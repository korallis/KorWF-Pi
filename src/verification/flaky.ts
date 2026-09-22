/**
 * Flaky, missing, and unavailable check states, represented explicitly
 * (issue #51; PLAN §3.F: "Flaky, missing, or unavailable checks are
 * represented explicitly, never as success").
 *
 * `checks.ts` (#45) already distinguishes pass/fail/timeout/unavailable for
 * one run. This module adds the two states that are properties of *several*
 * runs or of the store rather than of a single run:
 *
 *  - `flaky`: the same check, at the same revision, passed on one run and
 *    failed (or timed out) on another. Both runs stay on disk as Evidence;
 *    this module never deletes or overwrites either.
 *  - `missing`: no fresh evidence exists for a registered check, or — a
 *    distinct condition — an acceptance criterion has no check registered
 *    against it at all (`uncoveredCriteria`), which is reported per
 *    criterion id and raised as a `missing_check` blocker.
 *
 * None of these states satisfies `docs/gates.md` §3 C1: only `pass` does,
 * and this module does not add a code path that could make it otherwise —
 * `DEFAULT_RERUN_POLICY.allowFlakyToPass` exists for symmetry with the
 * option PLAN leaves configurable but defaults to `false`.
 */
import type { AcceptanceCriterion, CheckDefinition, Evidence, GitSha, Revision, TaskId } from "../storage/records.ts";
import type { CheckRunStatus } from "./evidence.ts";
import { runStatusOf, classifyOutcome } from "./evidence.ts";
import { runCheck, type CheckRunResult, type RunCheckOptions } from "./checks.ts";

/** Blocker kind for an acceptance criterion with no covering check. */
export const MISSING_CHECK_BLOCKER = "missing_check" as const;

/** Configurable rerun policy for flakiness detection (PLAN §3.F Scope). */
export interface RerunPolicy {
  /** Rerun once (or more) when the first run fails, to see if it recovers. */
  readonly rerunOnFail: boolean;
  /** Maximum additional runs after the first. */
  readonly maxReruns: number;
  /**
   * Whether a `flaky` result may satisfy the gate for this risk class.
   * PLAN §3.F: "flaky ≠ pass for the gate unless policy explicitly allows
   * for that risk class (default: not allowed)".
   */
  readonly allowFlakyToPass: boolean;
}

/** The shipped default: rerun once on failure; flaky never satisfies the gate. */
export const DEFAULT_RERUN_POLICY: RerunPolicy = {
  rerunOnFail: true,
  maxReruns: 1,
  allowFlakyToPass: false,
};

// ---------------------------------------------------------------------------
// Rerun and reconciliation: turning several runs into one state
// ---------------------------------------------------------------------------

/** Outcome of running one check under a rerun policy. */
export interface FlakyAwareResult {
  readonly checkId: string;
  /** Every attempt made, in order. Always at least one. */
  readonly runs: readonly CheckRunResult[];
  /**
   * The reconciled state: `flaky` only when runs at the *same* revision
   * disagree on pass vs. not-pass. Never `pass` unless every run passed.
   */
  readonly status: CheckRunStatus;
  readonly revision: GitSha | null;
  /** Every non-null evidence draft produced, one per executed run, plus a
   *  reconciled draft for the flaky case — the caller inserts all of them,
   *  so a reader sees the disagreeing runs linked by identical
   *  `(checkId, revision, taskRevision)`. */
  readonly evidence: readonly import("./evidence.ts").EvidenceDraft[];
}

/**
 * Run a check, and if it fails, rerun it (per policy) to see whether the
 * failure reproduces at the same revision.
 *
 * A rerun only happens when the first run is a genuine `fail` or `timeout` —
 * rerunning an `unavailable` result (missing tool, weak check, no revision)
 * would not distinguish anything: the tool is still absent on the second
 * try. A passing first run is never rerun by this policy (rerunning to
 * *find* flakiness on a pass is a distinct, more expensive policy this
 * function does not implement).
 */
export async function runCheckWithRerunPolicy(
  check: CheckDefinition,
  options: RunCheckOptions,
  policy: RerunPolicy = DEFAULT_RERUN_POLICY,
): Promise<FlakyAwareResult> {
  const first = await runCheck(check, options);
  const runs: CheckRunResult[] = [first];

  const rerunnable = (status: CheckRunStatus): boolean => status === "fail" || status === "timeout";

  if (policy.rerunOnFail && rerunnable(first.status)) {
    for (let i = 0; i < policy.maxReruns; i += 1) {
      const rerun = await runCheck(check, options);
      runs.push(rerun);
      // Stop early once a pass has been seen at the same revision: that is
      // already enough to call it flaky, and running a fixed rerun budget
      // beyond that only pins the revision cost higher for no new signal.
      if (rerun.status === "pass" && rerun.revision === first.revision) break;
    }
  }

  return reconcileRuns(check.id, runs);
}

/**
 * Reconcile several run results for the same check into one state.
 *
 * Only runs sharing the *first* run's revision are considered together —
 * `docs/gates.md` §2 defines freshness per revision, so a run at a different
 * revision (the worktree moved between attempts) is not evidence about the
 * same question and is excluded from the flaky determination, though its
 * evidence draft is still returned for the caller to store.
 */
export function reconcileRuns(checkId: string, runs: readonly CheckRunResult[]): FlakyAwareResult {
  if (runs.length === 0) {
    throw new Error(`reconcileRuns("${checkId}") called with no runs`);
  }
  const first = runs[0] as CheckRunResult;
  const evidence = runs.flatMap((r) => (r.evidence === null ? [] : [r.evidence]));

  const sameRevision = runs.filter((r) => r.revision === first.revision && r.revision !== null);
  const statuses = new Set(sameRevision.map((r) => r.status));
  const sawPass = statuses.has("pass");
  const sawNonPass = [...statuses].some((s) => s !== "pass");

  if (sameRevision.length > 1 && sawPass && sawNonPass) {
    return {
      checkId,
      runs,
      status: "flaky",
      revision: first.revision,
      evidence,
    };
  }

  // No disagreement: the reconciled state is whatever the *last* run at the
  // shared revision produced — matching "latest result wins" (docs/gates.md
  // §2), since a rerun that confirms the original result should not be
  // shadowed by a stale first attempt.
  const last = sameRevision.length > 0 ? (sameRevision[sameRevision.length - 1] as CheckRunResult) : first;
  return {
    checkId,
    runs,
    status: last.status,
    revision: last.revision,
    evidence,
  };
}
