/**
 * Attempt budgeting with a separate, bounded harness-retry budget
 * (issue #124 AC3/AC4; docs/PRD.md §3.3, PLAN §3.G "bounded responses").
 *
 * Two budgets, deliberately distinct:
 *
 *  - the **attempt budget** counts attempts that actually produced work to
 *    judge. A truncated turn produced none, so it may not consume a slot —
 *    otherwise a harness limit silently exhausts a task that was never
 *    really tried (observed on #14: six attempts, zero files).
 *  - the **harness-retry budget** bounds the truncated (and other harness)
 *    retries themselves, so a task that truncates every single time stops
 *    with a distinct `harness_limit` failure rather than retrying forever.
 *
 * Pure decision function: no clock, no I/O, no Jev. Deterministic under
 * every configuration (AC6).
 */
import type { AttemptFailureKind } from "../workers/truncation.ts";
import { isHarnessFailure } from "../workers/truncation.ts";

/** Default number of attempts that may be judged on quality before a task fails. */
export const DEFAULT_MAX_ATTEMPTS = 3 as const;

/**
 * Default bound on harness retries for one task. Three is enough to clear a
 * transient ceiling hit after the incremental-write guidance is added, and
 * small enough that a structurally over-sized task surfaces quickly instead
 * of burning a token budget the way #14 did.
 */
export const DEFAULT_MAX_HARNESS_RETRIES = 3 as const;

/**
 * Consecutive truncations after which the task is treated as structurally
 * over-sized: the guidance is not working, so the plan is wrong, not the
 * worker.
 */
export const DEFAULT_MAX_CONSECUTIVE_TRUNCATIONS = 2 as const;

/** Configured bounds for one task. */
export interface AttemptBudgetLimits {
  readonly maxAttempts: number;
  readonly maxHarnessRetries: number;
  readonly maxConsecutiveTruncations: number;
}

export const DEFAULT_ATTEMPT_BUDGET_LIMITS: AttemptBudgetLimits = Object.freeze({
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  maxHarnessRetries: DEFAULT_MAX_HARNESS_RETRIES,
  maxConsecutiveTruncations: DEFAULT_MAX_CONSECUTIVE_TRUNCATIONS,
});

/** Running tally of what a task has spent. */
export interface AttemptBudgetState {
  /** Attempts that produced work and were judged. */
  readonly attemptsUsed: number;
  /** Harness retries taken (truncation, timeout, transport error, cap). */
  readonly harnessRetriesUsed: number;
  /** Truncations since the last non-truncated turn. */
  readonly consecutiveTruncations: number;
}

export const EMPTY_ATTEMPT_BUDGET: AttemptBudgetState = Object.freeze({
  attemptsUsed: 0,
  harnessRetriesUsed: 0,
  consecutiveTruncations: 0,
});

/** What the controller should do next with the task. */
export type NextAction = "retry" | "judge" | "fail";

/** Distinct terminal failures, so telemetry and the board never conflate them. */
export type TerminalFailure =
  | "attempt_limit"
  | "harness_limit"
  | "persistent_truncation";

export interface BudgetDecision {
  readonly state: AttemptBudgetState;
  readonly next: NextAction;
  /** `null` unless `next === "fail"`. */
  readonly failure: TerminalFailure | null;
  /** `true` when this turn consumed one of the `maxAttempts` slots. */
  readonly consumedAttempt: boolean;
  readonly reason: string;
}

/**
 * Fold one classified turn into the task's budget state and decide what
 * happens next.
 *
 * @param kind        failure kind from `classifyTurn`
 * @param state       the task's budget so far
 * @param limits      configured bounds
 * @param gatePassed  for non-harness turns, whether the task gate passed.
 *                    Ignored for harness failures — nothing was judged.
 */
export function recordTurn(
  kind: AttemptFailureKind,
  state: AttemptBudgetState = EMPTY_ATTEMPT_BUDGET,
  limits: AttemptBudgetLimits = DEFAULT_ATTEMPT_BUDGET_LIMITS,
): BudgetDecision {
  const harness = isHarnessFailure(kind);
  const truncated = kind === "truncated";
  const next: AttemptBudgetState = {
    attemptsUsed: state.attemptsUsed + (harness ? 0 : 1),
    harnessRetriesUsed: state.harnessRetriesUsed + (harness ? 1 : 0),
    consecutiveTruncations: truncated ? state.consecutiveTruncations + 1 : 0,
  };

  if (truncated && next.consecutiveTruncations >= limits.maxConsecutiveTruncations) {
    return {
      state: next,
      next: "fail",
      failure: "persistent_truncation",
      consumedAttempt: false,
      reason:
        `${next.consecutiveTruncations} consecutive turns were cut off at the output-token ceiling ` +
        `(limit ${limits.maxConsecutiveTruncations}). Incremental-write guidance is not clearing it, ` +
        `so the task is over-sized for this model's output budget: decompose it before retrying. ` +
        `No attempt-budget slot was consumed and the acceptance criteria were never assessed.`,
    };
  }
  if (harness && next.harnessRetriesUsed >= limits.maxHarnessRetries) {
    return {
      state: next,
      next: "fail",
      failure: "harness_limit",
      consumedAttempt: false,
      reason:
        `${next.harnessRetriesUsed} harness failures (limit ${limits.maxHarnessRetries}) without a ` +
        `judged attempt. This is an execution-environment failure, distinct from unmet criteria.`,
    };
  }
  if (harness) {
    return {
      state: next,
      next: "retry",
      failure: null,
      consumedAttempt: false,
      reason:
        `Harness failure (${kind}): retrying without consuming the attempt budget ` +
        `(${next.attemptsUsed}/${limits.maxAttempts} attempts used, ` +
        `${next.harnessRetriesUsed}/${limits.maxHarnessRetries} harness retries used).`,
    };
  }
  if (kind === "none") {
    return {
      state: next,
      next: "judge",
      failure: null,
      consumedAttempt: true,
      reason: `Attempt ${next.attemptsUsed}/${limits.maxAttempts} produced work; hand it to the task gate.`,
    };
  }
  if (next.attemptsUsed >= limits.maxAttempts) {
    return {
      state: next,
      next: "fail",
      failure: "attempt_limit",
      consumedAttempt: true,
      reason: `Attempt limit reached (${next.attemptsUsed}/${limits.maxAttempts}) with unmet criteria.`,
    };
  }
  return {
    state: next,
    next: "retry",
    failure: null,
    consumedAttempt: true,
    reason:
      `Attempt ${next.attemptsUsed}/${limits.maxAttempts} did not satisfy the criteria; ` +
      `retrying with the gate's feedback.`,
  };
}

/** Attempts still available for work that will actually be judged. */
export function attemptsRemaining(
  state: AttemptBudgetState,
  limits: AttemptBudgetLimits = DEFAULT_ATTEMPT_BUDGET_LIMITS,
): number {
  return Math.max(0, limits.maxAttempts - state.attemptsUsed);
}
