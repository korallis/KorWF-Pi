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
import { isTrivialCheck } from "../workflow/weak-checks.ts";
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
