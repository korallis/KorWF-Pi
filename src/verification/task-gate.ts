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
