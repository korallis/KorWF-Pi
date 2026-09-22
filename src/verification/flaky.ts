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
