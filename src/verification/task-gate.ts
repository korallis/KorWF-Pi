/**
 * The task gate (issue #46; PLAN §2.4; specification in `docs/gates.md` §2–§5,
 * test outline in `test/spec/gates.spec.md`).
 *
 * PLAN §2.4 is one paragraph and this file exists to make every clause of it
 * true *by construction* rather than by convention:
 *
 * > A task reaches `done` only when all of the following hold:
 * > 1. deterministic checks pass at the exact revision, recorded as evidence;
 * > 2. Jev finds no evidence gap;
 * > 3. policy-required review passes.
 * > Jev cannot waive (1) or (3). A worker's assertion cannot set `done`.
 * > A Jev "no gap" result cannot substitute for a failing check.
 *
 * How each sentence becomes a structural property:
 *
 * - **"Jev cannot waive (1) or (3)"** — `C1` and `C3` are computed from
 *   `Evidence`, `Approval` and `CheckDefinition` rows only. No `Decision` row
 *   is read by either; there is no parameter, field or option through which a
 *   Jev answer could reach them. The conjunction is evaluated over *all*
 *   conditions (never short-circuited), so a failing check is reported even
 *   when C2 holds.
 * - **"A worker's assertion cannot set `done`"** — a completion claim appears
 *   exactly once, in `C0`, as the *existence* of an attempt whose outcome
 *   requested completion. Its content is never read as a truth value, and the
 *   gate returns a receipt rather than writing status; the status write is
 *   refused by the store unless a matching, unconsumed receipt exists.
 * - **"works with no Jev key"** — `C2` is a disjunction of two *recorded*
 *   outcomes. With Jev disabled the recorded `deterministic_fallback` branch
 *   requires `DET_COVERAGE`, which is stricter on structure than Jev. Absence
 *   of a row is neither branch (`jev_decision_missing`).
 * - **"every refusal says which condition failed"** — the result carries one
 *   `GateConditionResult` per condition with a closed-set `reasonCode`, and
 *   those are persisted on the receipt, so `/korwf why` explains a refusal
 *   from recorded fields rather than from message text.
 *
 * The evaluation is **pure**: same records + same `SHA` + same `now` ⇒ same
 * result. It reads no clock, no network and no Jev. The revision it evaluates
 * at is read from `src/git/` by the caller-supplied resolver, never taken from
 * a record a worker could write.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../storage/repos/base.ts";
import type { GateConditionResult, GateReceipt } from "../storage/gate-receipts.ts";
import {
  approvalInvalidReason,
  type Approval,
  type Attempt,
  type CheckDefinition,
  type ContentHash,
  type Decision,
  type Evidence,
  type GitSha,
  type IsoTimestamp,
  type RiskClass,
  type Task,
  type Workflow,
} from "../storage/records.ts";
import type { Store } from "../storage/db.ts";
import type { TaskId } from "../storage/records.ts";
import { isTrivialCheck } from "../workflow/weak-checks.ts";
import { revisionAt } from "./checks.ts";
import { runStatusOf, type CheckRunStatus } from "./evidence.ts";

// ---------------------------------------------------------------------------
// Reason codes (docs/gates.md §7, closed set)
// ---------------------------------------------------------------------------

/**
 * Every reason the task gate may refuse, exactly as enumerated in
 * docs/gates.md §7. The list is closed and tests match on it: a refusal is a
 * machine-readable fact, not a sentence.
 *
 * `approval_invalid:<reason>` is spelled as a prefix because its suffix comes
 * from `approvalInvalidReason` (#12) and must not be re-invented here.
 */
export const TASK_GATE_REASON_CODES = [
  "not_in_review",
  "blocker_present",
  "no_completion_claim",
  "no_checks",
  "check_trivial",
  "check_fail",
  "check_flaky",
  "check_missing",
  "check_unavailable",
  "check_timeout",
  "criterion_uncovered",
  "evidence_stale_revision",
  "evidence_stale_task_revision",
  "evidence_superseded",
  "command_identity_mismatch",
  "jev_gap",
  "jev_error",
  "jev_decision_missing",
  "jev_unavailable",
  "fallback_coverage_gap",
  "review_missing",
  "review_not_independent",
  "approval_missing",
  "approval_actor_not_user",
  "policy_result_missing",
  "status_write_forbidden",
  "revision_unavailable",
] as const;

export type TaskGateReasonCode = (typeof TASK_GATE_REASON_CODES)[number] | `approval_invalid:${string}`;

/** The four conditions of `TASK_GATE`, in the order they are reported. */
export const TASK_GATE_CONDITIONS = ["C0", "C1", "C2", "C3"] as const;
export type TaskGateCondition = (typeof TASK_GATE_CONDITIONS)[number];

// ---------------------------------------------------------------------------
// Gate input
// ---------------------------------------------------------------------------

/**
 * The review policy result for this task (issue #15 supplies the function;
 * the gate only consumes its result).
 *
 * It must be **recorded**, not computed on the fly by the gate's caller at
 * will: docs/gates.md §3 `policyResultRecorded(T)`. An absent result is
 * `policy_result_missing`, never "no review required".
 */
export interface PolicyReviewResult {
  readonly modelReview: boolean;
  readonly humanApproval: boolean;
  /** Change class the policy was evaluated for, from `src/git/`. */
  readonly changeClass: string;
  /** Policy version the result came from; must match `Workflow.policyVersion`. */
  readonly policyVersion: string;
  /** Revision the result was computed at; must equal the gate revision. */
  readonly revision: GitSha;
  /** Task revision the result was computed against. */
  readonly taskRevision: number;
}

/** Jev configuration as the engine resolved it for this evaluation. */
export interface JevGateConfig {
  /** `false` when disabled in config or when no credential is present. */
  readonly enabled: boolean;
  /**
   * May a transport failure fall back to `DET_COVERAGE`? docs/gates.md §9 D2:
   * an operator who turned Jev on expects its judgement, so degrading is
   * configurable and never implicit.
   */
  readonly optional: boolean;
  /** Confidence threshold θ from the policy version. Deterministic. */
  readonly confidenceThreshold: number;
  /** Question version pinned by `Workflow.policyVersion`. */
  readonly questionVersion: string;
}

/**
 * Everything the gate reads. Assembled by the caller from the store, and
 * hashed into the receipt's `inputHash`, so a receipt cannot outlive the
 * facts that produced it.
 *
 * `revision` is the exact Git SHA, read by `src/git/` at evaluation time (see
 * `resolveGateRevision`). There is deliberately no way to pass a
 * worker-supplied revision: `evaluateTaskGate` takes it here and
 * `runTaskGate` obtains it from the repository itself.
 */
export interface TaskGateInput {
  readonly workflow: Workflow;
  readonly task: Task;
  /** Exact Git SHA at the head of the task's worktree, from `src/git/`. */
  readonly revision: GitSha | null;
  /** Every `Evidence` row for the task. Freshness is derived, never stored. */
  readonly evidence: readonly Evidence[];
  /** Every `Decision` row of the workflow. */
  readonly decisions: readonly Decision[];
  /** Every `Approval` row of the workflow. */
  readonly approvals: readonly Approval[];
  /** Every `Attempt` row for the task, for the claim and independence checks. */
  readonly attempts: readonly Attempt[];
  /** Unresolved blocker kinds on the task, from the blocker table. */
  readonly unresolvedBlockers: readonly string[];
  /** Recorded policy review result, or `null` when none was recorded. */
  readonly policy: PolicyReviewResult | null;
  readonly jev: JevGateConfig;
  /** Caller-supplied timestamp; the gate does no clock access. */
  readonly now: IsoTimestamp;
}

/** The verdict. `pass` is true only when every condition is satisfied. */
export interface TaskGateResult {
  readonly pass: boolean;
  /** One entry per condition, in `TASK_GATE_CONDITIONS` order. Always complete. */
  readonly conditions: readonly GateConditionResult[];
  /** Every reason the gate refused, in condition order; empty on pass. */
  readonly reasons: readonly TaskGateRejection[];
  /** Hash of the exact input this verdict was computed from. */
  readonly inputHash: ContentHash;
  /** Which branch of C2 was taken, for the receipt and `/korwf why`. */
  readonly c2Branch: "jev_no_gap" | "deterministic_fallback" | null;
  /** Per-check states, so a refusal can name the state verbatim. */
  readonly checkStates: readonly { readonly checkId: string; readonly state: CheckRunStatus }[];
}

/** One refusal: which condition, which code, and the detail behind it. */
export interface TaskGateRejection {
  readonly condition: TaskGateCondition;
  readonly reasonCode: TaskGateReasonCode;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Freshness and check state (docs/gates.md §2, §4)
// ---------------------------------------------------------------------------

/**
 * Why a row is not fresh, or `null` when it is.
 *
 * Freshness is **derived on every evaluation** from the current `SHA` and
 * `Task.revision` (docs/gates.md §7 guarantee 3). There is no `evidence.valid`
 * column to flip, so "mark it fresh" is not an operation that exists.
 */
export type StalenessReason =
  | "evidence_stale_revision"
  | "evidence_stale_task_revision"
  | "evidence_superseded";

export function stalenessReason(
  row: Evidence,
  args: { readonly taskRevision: number; readonly revision: GitSha; readonly superseded: ReadonlySet<string> },
): StalenessReason | null {
  if (row.revision !== args.revision) return "evidence_stale_revision";
  if (row.taskRevision !== args.taskRevision) return "evidence_stale_task_revision";
  if (args.superseded.has(row.id)) return "evidence_superseded";
  return null;
}

/** Ids of evidence rows superseded by some other row in the same set. */
export function supersededIds(evidence: readonly Evidence[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of evidence) if (row.supersedesId !== null) out.add(row.supersedesId);
  return out;
}

/**
 * Fresh rows only, in the deterministic order docs/gates.md §2 fixes:
 * greatest `createdAt`, ties broken by greatest `id`.
 */
export function freshEvidence(input: Pick<TaskGateInput, "task" | "evidence">, revision: GitSha): readonly Evidence[] {
  const superseded = supersededIds(input.evidence);
  return input.evidence
    .filter(
      (row) =>
        row.taskId === input.task.id &&
        stalenessReason(row, { taskRevision: input.task.revision, revision, superseded }) === null,
    )
    .slice()
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * The latest fresh result for a check, or `undefined`.
 *
 * A `human` check is satisfied only by a `human` reviewer row (docs/gates.md
 * §2, §9 D3); an executable check only by a `deterministic` one. Mixing them
 * is how a model "review" could otherwise stand in for a command that was
 * never run.
 */
export function latestResultFor(
  check: CheckDefinition,
  fresh: readonly Evidence[],
): Evidence | undefined {
  const wanted = check.kind === "human" ? "human" : "deterministic";
  const matching = fresh.filter((row) => row.checkId === check.id && row.reviewer.kind === wanted);
  return matching[matching.length - 1];
}

/**
 * `state(c, T)` of docs/gates.md §4.
 *
 * Only `pass` satisfies C1. Everything else — including the absence of a row
 * — is a distinct, explicit non-success, and the distinction survives into the
 * refusal: `flaky`, `missing`, `unavailable` and `timeout` are never collapsed
 * into `fail`.
 *
 * Command identity is compared against the **definition**, so evidence
 * produced by running something else under a registered check id is `fail`
 * (gates.spec.md B6). `required: false` changes nothing here: it is a
 * reporting flag and this function never reads it (B9).
 */
export function checkState(
  check: CheckDefinition,
  fresh: readonly Evidence[],
): { readonly state: CheckRunStatus; readonly identityMismatch: boolean } {
  const row = latestResultFor(check, fresh);
  if (row === undefined) return { state: "missing", identityMismatch: false };
  if (check.kind === "human") {
    const ok = row.exitStatus.kind === "exited" && row.exitStatus.code === 0;
    return { state: ok ? "pass" : "fail", identityMismatch: false };
  }
  const identity = row.commandIdentity;
  const identityMismatch =
    identity === null || identity.command !== check.command || identity.cwd !== check.cwd;
  const state = runStatusOf(row.exitStatus, check.expectedExitCode);
  if (identityMismatch && state === "pass") return { state: "fail", identityMismatch: true };
  return { state, identityMismatch: identityMismatch && state !== "pass" };
}

/** Reason code for a non-passing check state (docs/gates.md §4 table). */
export function checkReasonCode(state: CheckRunStatus): TaskGateReasonCode {
  switch (state) {
    case "fail":
      return "check_fail";
    case "flaky":
      return "check_flaky";
    case "missing":
      return "check_missing";
    case "unavailable":
      return "check_unavailable";
    case "timeout":
      return "check_timeout";
    case "pass":
      return "check_fail";
  }
}

// ---------------------------------------------------------------------------
// C0 — the worker's claim is an input, never an authority
// ---------------------------------------------------------------------------

/**
 * Attempt outcomes that constitute a completion claim.
 *
 * `succeeded` is a *request* to be gated, in exactly the sense docs/gates.md
 * §3 means by `author(T).outcome = completion_requested`: the attempt finished
 * and asked for its work to be assessed. Nothing about the claim's content is
 * read — not a summary, not a self-report, not a "tests all pass" string. The
 * only thing the gate learns from it is that there is something to gate.
 */
const CLAIM_OUTCOMES: readonly string[] = ["succeeded"];

/** The attempt whose outcome produced the completion claim, if any. */
export function claimingAttempt(input: Pick<TaskGateInput, "task" | "attempts">): Attempt | undefined {
  const candidates = input.attempts
    .filter(
      (attempt) =>
        attempt.taskId === input.task.id &&
        attempt.taskRevision === input.task.revision &&
        attempt.outcome !== null &&
        CLAIM_OUTCOMES.includes(attempt.outcome),
    )
    .slice()
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  return candidates[candidates.length - 1];
}

function evaluateC0(input: TaskGateInput): readonly TaskGateRejection[] {
  const out: TaskGateRejection[] = [];
  const { task } = input;
  if (task.status !== "review") {
    out.push({
      condition: "C0",
      reasonCode: "not_in_review",
      detail: `task ${task.id} is "${task.status}"; the gate is entered from "review" only`,
    });
  }
  if (task.blocker !== null || input.unresolvedBlockers.length > 0) {
    out.push({
      condition: "C0",
      reasonCode: "blocker_present",
      detail: `task ${task.id} has unresolved blocker(s): ${
        input.unresolvedBlockers.length > 0 ? input.unresolvedBlockers.join(", ") : String(task.blocker)
      }`,
    });
  }
  if (claimingAttempt(input) === undefined) {
    out.push({
      condition: "C0",
      reasonCode: "no_completion_claim",
      detail: `no attempt at revision ${task.revision} requested completion for ${task.id}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// C1 — deterministic checks pass at the exact revision. No Jev term.
// ---------------------------------------------------------------------------

/**
 * Condition 1 of PLAN §2.4. Deliberately takes no `Decision` argument: there
 * is no expressible way for a Jev answer to influence it, which is what
 * "a Jev 'no gap' result cannot substitute for a failing check" means once it
 * is code rather than a policy.
 *
 * Every failing check is reported, not just the first, so a refusal explains
 * the whole picture and re-running the gate is not a bisection exercise.
 */
export function evaluateC1(
  input: TaskGateInput,
  fresh: readonly Evidence[],
): {
  readonly rejections: readonly TaskGateRejection[];
  readonly checkStates: readonly { readonly checkId: string; readonly state: CheckRunStatus }[];
} {
  const out: TaskGateRejection[] = [];
  const states: { checkId: string; state: CheckRunStatus }[] = [];
  const { task } = input;

  if (task.checks.length === 0) {
    out.push({ condition: "C1", reasonCode: "no_checks", detail: `task ${task.id} has no registered checks` });
  }

  for (const check of task.checks) {
    // A check that cannot fail is not a registered check for gate purposes
    // (#44 `isVerifyingCheck` is the one definition of "real check"; this is
    // its trivial-command half). Registration should have refused it at
    // `task-ready`; if one was forced into the record, it is refused here.
    if (isTrivialCheck(check)) {
      out.push({
        condition: "C1",
        reasonCode: "check_trivial",
        detail: `check ${check.id} (${JSON.stringify(check.command)}) passes unconditionally and verifies nothing`,
      });
      states.push({ checkId: check.id, state: "missing" });
      continue;
    }
    const { state, identityMismatch } = checkState(check, fresh);
    states.push({ checkId: check.id, state });
    if (state === "pass") continue;
    if (identityMismatch) {
      out.push({
        condition: "C1",
        reasonCode: "command_identity_mismatch",
        detail: `check ${check.id}: evidence was produced by a different command than the registered one`,
      });
      continue;
    }
    out.push({
      condition: "C1",
      reasonCode: checkReasonCode(state),
      // The state name appears verbatim: docs/gates.md §4 forbids collapsing
      // flaky/missing/unavailable/timeout into `fail` in the audit entry.
      detail: `check ${check.id} is "${state}"${stalenessNote(check, input, fresh)}`,
    });
  }

  for (const criterion of task.acceptanceCriteria) {
    const covered = task.checks.some(
      (check) => !isTrivialCheck(check) && check.coversCriteria.includes(criterion.id),
    );
    if (!covered) {
      out.push({
        condition: "C1",
        reasonCode: "criterion_uncovered",
        detail: criterion.id,
      });
    }
  }

  return { rejections: out, checkStates: states };
}

/**
 * Why a check has no fresh result, when stale rows exist for it. This is what
 * turns an opaque `check_missing` into "evidence was recorded at another
 * revision", which is the difference between a user re-running a check and a
 * user staring at a green terminal.
 */
function stalenessNote(check: CheckDefinition, input: TaskGateInput, fresh: readonly Evidence[]): string {
  if (latestResultFor(check, fresh) !== undefined) return "";
  const superseded = supersededIds(input.evidence);
  const revision = input.revision;
  const reasons = new Set<string>();
  for (const row of input.evidence) {
    if (row.checkId !== check.id || revision === null) continue;
    const reason = stalenessReason(row, { taskRevision: input.task.revision, revision, superseded });
    if (reason !== null) reasons.add(reason);
  }
  return reasons.size === 0 ? "" : ` (${[...reasons].sort().join(", ")})`;
}

// ---------------------------------------------------------------------------
// C2 — a disjunction of two *recorded* outcomes (docs/gates.md §5)
// ---------------------------------------------------------------------------

/** The question id both branches of C2 are recorded under. */
export const TASK_EVIDENCE_GAP_QUESTION = "task_evidence_gap" as const;

/** Override reasons that record "Jev did not answer this". */
export const JEV_DISABLED_REASONS = ["jev_disabled", "jev_no_key", "jev_unavailable"] as const;
export type JevDisabledReason = (typeof JEV_DISABLED_REASONS)[number];

/**
 * `H(...)` of docs/gates.md §5.1: the canonical hash over the gate input a
 * decision was made about.
 *
 * It covers the check **states**, so a decision made while a check was failing
 * is stale the moment that check is re-run: a "no gap" cannot be carried
 * across a fix. It covers fresh evidence content hashes, so swapping the
 * evidence under a decision invalidates it too.
 */
export function gateStateHash(args: {
  readonly task: Task;
  readonly revision: GitSha;
  readonly checkStates: readonly { readonly checkId: string; readonly state: CheckRunStatus }[];
  readonly fresh: readonly Evidence[];
}): ContentHash {
  const payload = {
    taskRevision: args.task.revision,
    revision: args.revision,
    acceptanceCriteria: args.task.acceptanceCriteria.map((a) => ({ id: a.id, text: a.text })),
    checks: args.task.checks.map((c) => ({
      id: c.id,
      kind: c.kind,
      command: c.command,
      cwd: c.cwd,
      expectedExitCode: c.expectedExitCode,
      coversCriteria: [...c.coversCriteria].sort(),
    })),
    checkStates: args.checkStates.map((s) => [s.checkId, s.state]).sort(),
    evidence: args.fresh
      .map((e) => [e.id, ...e.provenance.map((p) => p.contentHash)])
      .sort(),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Decisions about this task+revision at this SHA, under the gap question. */
function candidateDecisions(input: TaskGateInput, revision: GitSha, stateHash: ContentHash): readonly Decision[] {
  return input.decisions.filter((d) => {
    const subject = d.subject;
    if (subject === null || !("taskId" in subject)) return false;
    return (
      subject.taskId === input.task.id &&
      subject.taskRevision === input.task.revision &&
      d.questionId === TASK_EVIDENCE_GAP_QUESTION &&
      d.freshness.revision === revision &&
      d.stateHash === stateHash
    );
  });
}

/**
 * `DET_COVERAGE(T)` of docs/gates.md §5.2 — what condition 2 *becomes* when
 * Jev is disabled.
 *
 * This is the reason "the product works with no key" is not a weakening. The
 * fallback is stricter on structure than Jev's judgement: every criterion must
 * be covered by a **passing** check *and* have its own passing evidence row,
 * and each command/assertion check's provenance must intersect the task's
 * ownership — a deterministic proxy for "the tests exercise the requirement
 * rather than something unrelated".
 */
export function evaluateDetCoverage(
  input: TaskGateInput,
  fresh: readonly Evidence[],
): readonly TaskGateRejection[] {
  const out: TaskGateRejection[] = [];
  const { task } = input;

  for (const criterion of task.acceptanceCriteria) {
    const passingCheck = task.checks.some(
      (check) =>
        !isTrivialCheck(check) &&
        check.coversCriteria.includes(criterion.id) &&
        checkState(check, fresh).state === "pass",
    );
    if (!passingCheck) {
      out.push({
        condition: "C2",
        reasonCode: "fallback_coverage_gap",
        detail: `criterion ${criterion.id} has no passing check`,
      });
    }
    const evidenceRow = fresh.some(
      (row) => row.requirementId === criterion.id && evidencePasses(row, task.checks),
    );
    if (!evidenceRow) {
      out.push({
        condition: "C2",
        reasonCode: "fallback_coverage_gap",
        detail: `criterion ${criterion.id} has no passing evidence row`,
      });
    }
  }

  for (const check of task.checks) {
    if (check.kind !== "command" && check.kind !== "assertion") continue;
    const row = latestResultFor(check, fresh);
    if (row === undefined) continue;
    const touchesOwned = row.provenance.some((p) => pathIsOwned(p.path, task.ownership.paths));
    if (!touchesOwned) {
      out.push({
        condition: "C2",
        reasonCode: "fallback_coverage_gap",
        detail: `check ${check.id}: no provenance path inside the task's ownership`,
      });
    }
  }

  return out;
}

/** Does a criterion-level evidence row itself record a success? */
function evidencePasses(row: Evidence, checks: readonly CheckDefinition[]): boolean {
  const expected = checks.find((c) => c.id === row.checkId)?.expectedExitCode ?? 0;
  return runStatusOf(row.exitStatus, expected) === "pass";
}

/**
 * Is a provenance path inside one of the task's owned paths? Prefix match on
 * path segments, so `src/a` owns `src/a/b.ts` but never `src/ab.ts`.
 */
export function pathIsOwned(path: string, owned: readonly string[]): boolean {
  const normalise = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const target = normalise(path);
  return owned.some((raw) => {
    const base = normalise(raw);
    if (base === "" || base === ".") return true;
    return target === base || target.startsWith(`${base}/`);
  });
}

/**
 * Condition 2, as the truth table of docs/gates.md §5.2.
 *
 * Exactly one of the two branches must be **present as a fresh `Decision`
 * row**. "No row" is neither branch and yields `jev_decision_missing`:
 * skipping is not a state, and with Jev disabled the gate still works — it
 * just requires the recorded fallback plus `DET_COVERAGE`.
 *
 * `Decision` rows are engine-append-only (records.md §4), so nothing a worker
 * can do produces one; that is what keeps this condition an input rather than
 * a lever.
 */
export function evaluateC2(
  input: TaskGateInput,
  fresh: readonly Evidence[],
  stateHash: ContentHash,
  revision: GitSha,
): { readonly rejections: readonly TaskGateRejection[]; readonly branch: TaskGateResult["c2Branch"] } {
  const candidates = candidateDecisions(input, revision, stateHash);
  const fallback = candidates.find(
    (d) =>
      d.override !== null &&
      d.override.actor === "policy" &&
      (JEV_DISABLED_REASONS as readonly string[]).includes(d.override.reason) &&
      d.action === "deterministic_fallback",
  );

  if (fallback !== undefined) {
    const reason = fallback.override?.reason as JevDisabledReason;
    // D2: an operator who turned Jev *on* expects its judgement. A transport
    // failure degrades to the deterministic predicate only when the config
    // says that is acceptable; otherwise the task waits in `review`.
    if (reason === "jev_unavailable" && input.jev.enabled && !input.jev.optional) {
      return {
        branch: null,
        rejections: [
          {
            condition: "C2",
            reasonCode: "jev_unavailable",
            detail: "Jev is enabled and jev.optional is false: the gate waits rather than degrading",
          },
        ],
      };
    }
    const coverage = evaluateDetCoverage(input, fresh);
    return { branch: "deterministic_fallback", rejections: coverage };
  }

  const answered = candidates.filter((d) => d.override === null);
  const noGap = answered.find(
    (d) => d.action === "no_gap" && (d.confidence ?? 0) >= input.jev.confidenceThreshold,
  );
  if (noGap !== undefined) {
    if (noGap.questionVersion !== input.jev.questionVersion) {
      return {
        branch: null,
        rejections: [
          {
            condition: "C2",
            reasonCode: "jev_decision_missing",
            detail: `decision was answered under question version ${noGap.questionVersion}, policy pins ${input.jev.questionVersion}`,
          },
        ],
      };
    }
    return { branch: "jev_no_gap", rejections: [] };
  }

  const errored = answered.find((d) => d.action === "error");
  if (errored !== undefined) {
    // "An error is not disabled" (docs/gates.md §5.1). Without a separately
    // recorded fallback row an error leaves the task in `review`.
    return {
      branch: null,
      rejections: [
        {
          condition: "C2",
          reasonCode: input.jev.optional ? "jev_error" : "jev_unavailable",
          detail: `evidence-gap question returned "error" and no deterministic fallback was recorded`,
        },
      ],
    };
  }

  const gap = answered.find((d) => d.action === "gap" || d.action === "no_gap");
  if (gap !== undefined) {
    const detail =
      gap.action === "no_gap"
        ? `no_gap recorded at confidence ${String(gap.confidence)} below threshold ${input.jev.confidenceThreshold}`
        : "evidence-gap question reported a gap";
    return { branch: null, rejections: [{ condition: "C2", reasonCode: "jev_gap", detail }] };
  }

  return {
    branch: null,
    rejections: [
      {
        condition: "C2",
        reasonCode: "jev_decision_missing",
        detail: input.jev.enabled
          ? "no fresh evidence-gap decision for this task revision, revision and state hash"
          : "Jev is disabled and no deterministic-fallback decision was recorded; absence is not a state",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// C3 — policy-required review. No Jev term either.
// ---------------------------------------------------------------------------

/** Risk ordering, so `a.riskClass >= T.riskClass` is a comparison and not a guess. */
const RISK_ORDER: Readonly<Record<RiskClass, number>> = { low: 0, medium: 1, high: 2 };

/**
 * Is this review evidence independent of the author?
 *
 * Structural, as docs/gates.md §2 requires: the reviewing attempt must differ
 * from the authoring attempt **and** its `handedOffFromAttemptId` chain must
 * not contain it. A model that reviews a handoff of its own work is the same
 * context wearing a different id (gates.spec.md B7).
 */
export function isIndependentReview(
  row: Evidence,
  args: { readonly author: Attempt | undefined; readonly attempts: readonly Attempt[] },
): boolean {
  if (row.reviewer.kind !== "model") return false;
  const authorId = args.author?.id;
  if (authorId === undefined) return true;
  const byId = new Map(args.attempts.map((a) => [a.id, a]));
  let current: Attempt | undefined = byId.get(row.reviewer.attemptId);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    if (current.id === authorId) return false;
    seen.add(current.id);
    const parent = current.handedOffFromAttemptId;
    current = parent === null ? undefined : byId.get(parent);
  }
  // An implementer or integrator role never counts as an independent review,
  // whatever the attempt graph says.
  const reviewer = byId.get(row.reviewer.attemptId);
  if (reviewer !== undefined && (reviewer.role === "implementer" || reviewer.role === "integrator")) return false;
  return true;
}

/**
 * Condition 3. Reads `Approval` and `Evidence` rows and the **recorded**
 * policy result; it has no `Decision` parameter, so Jev cannot waive it, and
 * the high-risk clause is applied on top of the policy result, so a policy
 * that says `humanApproval: false` for a high-risk task does not get to.
 */
export function evaluateC3(
  input: TaskGateInput,
  fresh: readonly Evidence[],
): readonly TaskGateRejection[] {
  const out: TaskGateRejection[] = [];
  const { task, workflow, policy } = input;

  if (
    policy === null ||
    policy.revision !== input.revision ||
    policy.taskRevision !== task.revision ||
    policy.policyVersion !== workflow.policyVersion
  ) {
    out.push({
      condition: "C3",
      reasonCode: "policy_result_missing",
      detail:
        policy === null
          ? "no policy review result recorded for this task"
          : "the recorded policy result is stale for this revision, task revision or policy version",
    });
  }

  const humanApproval = (policy?.humanApproval ?? false) || task.riskClass === "high";
  const modelReview = policy?.modelReview ?? false;

  if (modelReview) {
    const author = claimingAttempt(input);
    const reviews = fresh.filter((row) => row.reviewer.kind === "model" && row.exitStatus.kind === "exited" && row.exitStatus.code === 0);
    if (reviews.length === 0) {
      out.push({
        condition: "C3",
        reasonCode: "review_missing",
        detail: "policy requires an independent model review and no fresh passing review evidence exists",
      });
    } else if (!reviews.some((row) => isIndependentReview(row, { author, attempts: input.attempts }))) {
      out.push({
        condition: "C3",
        reasonCode: "review_not_independent",
        detail: "every fresh review came from the authoring attempt or its handoff chain",
      });
    }
  }

  if (humanApproval) out.push(...approvalRejections(input));

  return out;
}

/** The `valid approval` clause of docs/gates.md §2, with its reason codes. */
function approvalRejections(input: TaskGateInput): readonly TaskGateRejection[] {
  const { task, workflow } = input;
  const scoped = input.approvals.filter(
    (a) =>
      a.workflowId === workflow.id &&
      a.scope.kind === "task" &&
      a.scope.taskId === task.id &&
      a.permittedAction === "complete_task",
  );
  if (scoped.length === 0) {
    return [
      {
        condition: "C3",
        reasonCode: "approval_missing",
        detail:
          task.riskClass === "high"
            ? `task ${task.id} is high risk: a user approval for complete_task is required and none exists`
            : `policy requires human approval for ${task.id} and none exists`,
      },
    ];
  }

  // A `policy` actor can never satisfy a human approval: that is the whole
  // point of the class (docs/gates.md §2 "valid approval", B8).
  const byUser = scoped.filter((a) => a.actor.kind === "user");
  if (byUser.length === 0) {
    return [
      {
        condition: "C3",
        reasonCode: "approval_actor_not_user",
        detail: `every approval for ${task.id} was granted by a non-user actor`,
      },
    ];
  }

  const underRisk = byUser.filter((a) => RISK_ORDER[a.riskClass] >= RISK_ORDER[task.riskClass]);
  if (underRisk.length === 0) {
    return [
      {
        condition: "C3",
        reasonCode: "approval_missing",
        detail: `no approval for ${task.id} covers risk class "${task.riskClass}"`,
      },
    ];
  }

  const reasons: TaskGateRejection[] = [];
  for (const approval of underRisk) {
    const reason = approvalInvalidReason(approval, {
      task: { id: task.id, revision: task.revision },
      planRevision: workflow.planRevision,
      now: input.now,
    });
    if (reason === null) return [];
    reasons.push({
      condition: "C3",
      reasonCode: `approval_invalid:${reason}`,
      detail: `approval ${approval.id} is unusable: ${reason}`,
    });
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

/**
 * Hash of the complete gate input. The receipt carries it, and the store
 * refuses a `done` write whose recomputed hash does not match a receipt: a
 * pass stops authorising anything the instant any input moves.
 */
export function taskGateInputHash(input: TaskGateInput): ContentHash {
  const payload = {
    workflow: {
      id: input.workflow.id,
      planRevision: input.workflow.planRevision,
      policyVersion: input.workflow.policyVersion,
      mode: input.workflow.mode,
    },
    task: {
      id: input.task.id,
      revision: input.task.revision,
      status: input.task.status,
      riskClass: input.task.riskClass,
      blocker: input.task.blocker,
      acceptanceCriteria: input.task.acceptanceCriteria,
      checks: input.task.checks,
      ownership: input.task.ownership,
    },
    revision: input.revision,
    evidence: input.evidence.map((e) => e.id).sort(),
    decisions: input.decisions.map((d) => d.id).sort(),
    approvals: input.approvals.map((a) => [a.id, a.invalidation?.reason ?? null]).sort(),
    attempts: input.attempts.map((a) => [a.id, a.outcome ?? null, a.role]).sort(),
    unresolvedBlockers: [...input.unresolvedBlockers].sort(),
    policy: input.policy,
    jev: input.jev,
    now: input.now,
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * `TASK_GATE(T)` — pure, total, and complete in its reporting.
 *
 * Every condition is evaluated even when an earlier one already failed, so
 * the result explains the whole refusal rather than the first thing noticed;
 * `/korwf why` reads those fields off the receipt. Ordering the conjunction
 * differently cannot change the verdict, because the conditions do not read
 * each other: C1 and C3 take no `Decision`, and C2 takes no authority over
 * either.
 */
export function evaluateTaskGate(input: TaskGateInput): TaskGateResult {
  const inputHash = taskGateInputHash(input);
  const revision = input.revision;

  if (revision === null) {
    // No revision means nothing can be pinned to one. Fail closed rather than
    // evaluating against "whatever is on disk" (docs/gates.md §1).
    const rejection: TaskGateRejection = {
      condition: "C1",
      reasonCode: "revision_unavailable",
      detail: "no Git revision could be read for the task worktree; evidence cannot be pinned",
    };
    return {
      pass: false,
      conditions: TASK_GATE_CONDITIONS.map((id) => ({
        id,
        satisfied: false,
        reasonCode: id === "C1" ? rejection.reasonCode : "revision_unavailable",
        detail: rejection.detail,
      })),
      reasons: [rejection],
      inputHash,
      c2Branch: null,
      checkStates: [],
    };
  }

  const fresh = freshEvidence(input, revision);
  const c0 = evaluateC0(input);
  const c1 = evaluateC1(input, fresh);
  const stateHash = gateStateHash({ task: input.task, revision, checkStates: c1.checkStates, fresh });
  const c2 = evaluateC2(input, fresh, stateHash, revision);
  const c3 = evaluateC3(input, fresh);

  const byCondition: Record<TaskGateCondition, readonly TaskGateRejection[]> = {
    C0: c0,
    C1: c1.rejections,
    C2: c2.rejections,
    C3: c3,
  };
  const reasons = TASK_GATE_CONDITIONS.flatMap((id) => byCondition[id]);
  const conditions: GateConditionResult[] = TASK_GATE_CONDITIONS.map((id) => {
    const failures = byCondition[id];
    const first = failures[0];
    return {
      id,
      satisfied: failures.length === 0,
      reasonCode: first?.reasonCode ?? null,
      detail: first === undefined ? null : failures.map((f) => f.detail).join("; "),
    };
  });

  return {
    pass: reasons.length === 0,
    conditions,
    reasons,
    inputHash,
    c2Branch: c2.branch,
    checkStates: c1.checkStates,
  };
}

// ---------------------------------------------------------------------------
// Runtime entry point: build the input from the store, record the verdict
// ---------------------------------------------------------------------------

/**
 * How the evaluation reads the exact revision.
 *
 * The default resolves it from the worktree through `src/git/`. A caller may
 * substitute a resolver (tests do), but the signature takes a *worktree path*
 * and not a SHA, so "pass in the revision you would like to be at" is not an
 * option any caller has — including a worker-driven one.
 */
export type RevisionResolver = (worktreePath: string) => GitSha | null;

export interface TaskGateOptions {
  /** Policy review result, recorded by #15's policy evaluation. */
  readonly policy: PolicyReviewResult | null;
  readonly jev: JevGateConfig;
  readonly now: IsoTimestamp;
  readonly newId: () => string;
  /** Absolute path of the task worktree the revision is read from. */
  readonly worktreePath: string;
  readonly resolveRevision?: RevisionResolver;
}

/** A gate evaluation and the receipt that recorded it. */
export interface TaskGateEvaluation {
  readonly result: TaskGateResult;
  readonly receipt: GateReceipt;
}

/**
 * Evaluate the task gate for `taskId` against the store, and record the
 * verdict as a `gate_receipt` row — pass *or* reject.
 *
 * The receipt is written **before** the result is returned (docs/gates.md §7
 * guarantee 5), so a crash after a refusal still leaves the explanation, and
 * the ordinary `audit_entry` row that the repositories emit is untouched: a
 * rejection changes no record, so it must not pretend to be an update.
 */
export function runTaskGate(store: Store, taskId: TaskId, options: TaskGateOptions): TaskGateEvaluation {
  const task = store.tasks.require(taskId);
  const workflow = store.workflows.require(task.workflowId);
  const resolve = options.resolveRevision ?? ((path: string) => revisionAt(path));
  const input: TaskGateInput = {
    workflow,
    task,
    revision: resolve(options.worktreePath),
    evidence: store.evidence.findBy("taskId", task.id),
    decisions: store.decisions.findBy("workflowId", workflow.id),
    approvals: store.approvals.findBy("workflowId", workflow.id),
    attempts: store.attempts.forTask(task.id),
    unresolvedBlockers: store.blockers.unresolvedForSubject("task", task.id).map((b) => b.kind),
    policy: options.policy,
    jev: options.jev,
    now: options.now,
  };
  const result = evaluateTaskGate(input);
  const receipt = store.gateReceipts.record({
    receiptId: options.newId(),
    createdAt: options.now,
    workflowId: workflow.id,
    gate: "task",
    subjectId: task.id,
    subjectRevision: task.revision,
    // A rejected evaluation with no readable revision still needs a row; the
    // all-zero SHA records "there was none" without inventing one.
    revision: input.revision ?? "0".repeat(40),
    disposition: result.pass ? "pass" : "reject",
    reasonCode: result.pass ? null : (result.reasons[0]?.reasonCode ?? null),
    detail: result.pass ? null : explainTaskGate(result),
    inputHash: result.inputHash,
    evaluatedAt: options.now,
    consumedAt: null,
    conditions: result.conditions,
  });
  return { result, receipt };
}

/** One-line explanation of a refusal, for `/korwf why` and log lines. */
export function explainTaskGate(result: TaskGateResult): string {
  if (result.pass) return "task gate passed: checks, evidence-gap assessment and policy review all satisfied";
  return result.reasons
    .map((r) => `${r.condition} ${r.reasonCode}: ${r.detail}`)
    .join("\n");
}
