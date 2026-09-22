/**
 * Per-worker and global limits (issue #71; PLAN §3.E "Enforce concurrency,
 * recursion depth, elapsed-time, token, and spend limits").
 *
 * Two kinds of limit exist and they are enforced in two different places, on
 * purpose:
 *
 * - **Global** limits (spend, tokens, requests, concurrency across the whole
 *   workflow/phase/task) are enforced by the #30 ledger's atomic
 *   `BEGIN IMMEDIATE` reservation. This module does *not* re-implement them:
 *   two workers asking at the same instant must be serialised by SQLite, and
 *   any in-process check would let both pass the same remaining budget. The
 *   only correct place is `Ledger.reserve()`.
 * - **Per-worker** limits (`WorkerBudget`: wall clock, output tokens, total
 *   tokens, spend) bound one subprocess. They are pure predicates over what
 *   the worker has been *observed* to use, evaluated here.
 *
 * This module is pure: no timers, no signals, no store. `evaluateLimits`
 * returns the first breach and the caller decides what to do with it, which
 * is what makes the policy testable without a process.
 */
import type { Usage } from "../storage/records.ts";
import type { WorkerBudget } from "./contract.ts";

/** Which per-worker limit was breached. */
export type LimitKind = "elapsed" | "output_tokens" | "total_tokens" | "spend";

/** A breach: the limit, the ceiling, and the observation that crossed it. */
export interface LimitBreach {
  readonly kind: LimitKind;
  readonly limit: number;
  readonly observed: number;
  /** Message suitable for the Attempt blocker and the user-facing board. */
  readonly message: string;
}

/** What a worker has used so far, as observed from the RPC stream. */
export interface ObservedUsage {
  readonly elapsedMs: number;
  readonly usage: Usage;
}

function breach(kind: LimitKind, limit: number, observed: number, unit: string): LimitBreach {
  return {
    kind,
    limit,
    observed,
    message:
      `worker exceeded its ${kind.replace("_", " ")} limit: ` +
      `${observed}${unit} used against a ceiling of ${limit}${unit}`,
  };
}

function exceeds(limit: number | null | undefined, observed: number): limit is number {
  return typeof limit === "number" && Number.isFinite(limit) && observed > limit;
}

/**
 * Evaluate a worker's per-worker budget against what it has used.
 *
 * Returns the first breach in a fixed order — elapsed, output tokens, total
 * tokens, spend — or `null`. The order is stable so the recorded reason for a
 * termination is deterministic when two ceilings are crossed in the same tick.
 *
 * **Unknown spend does not breach the spend ceiling.** A route the registry
 * cannot price reports `spendUsd: null` (#56, #30), and treating that as `0`
 * would be a silent under-report while treating it as infinite would kill
 * every unpriced worker. Unknown cost still consumes the elapsed and token
 * limits, which are the bounds that do not depend on a price.
 */
export function evaluateLimits(budget: WorkerBudget, observed: ObservedUsage): LimitBreach | null {
  if (exceeds(budget.wallClockMs, observed.elapsedMs)) {
    return breach("elapsed", budget.wallClockMs, observed.elapsedMs, "ms");
  }
  const output = observed.usage.outputTokens ?? 0;
  if (exceeds(budget.maxOutputTokens, output)) {
    return breach("output_tokens", budget.maxOutputTokens as number, output, " tokens");
  }
  const total = (observed.usage.inputTokens ?? 0) + output;
  if (exceeds(budget.maxTotalTokens, total)) {
    return breach("total_tokens", budget.maxTotalTokens as number, total, " tokens");
  }
  const spend = observed.usage.spendUsd;
  if (spend !== null && exceeds(budget.maxSpendUsd, spend)) {
    return breach("spend", budget.maxSpendUsd as number, spend, " USD");
  }
  return null;
}

/**
 * The next moment at which a limit could newly be breached, in ms from now.
 *
 * Only the elapsed limit is time-driven — token and spend limits change only
 * when the worker reports usage, which wakes the supervisor anyway. Returns
 * `null` when there is no wall-clock ceiling to wait for. Never negative: a
 * deadline already passed is `0`, i.e. "check immediately".
 */
export function msUntilElapsedLimit(budget: WorkerBudget, elapsedMs: number): number | null {
  const limit = budget.wallClockMs;
  if (typeof limit !== "number" || !Number.isFinite(limit)) return null;
  return Math.max(0, limit - elapsedMs);
}
