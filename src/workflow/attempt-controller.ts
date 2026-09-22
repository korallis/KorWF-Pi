/**
 * The controller step that settles one worker turn (issue #124 AC2–AC4).
 *
 * This is the product port of the bootstrap orchestrator's `dispatch()`
 * ordering: capture the stop reason, classify truncation *before* looking at
 * the worker's output, and only then fold the result into the task's budgets.
 * Everything here is deterministic — no Jev, no clock, no I/O — so the
 * behaviour is identical with Jev disabled (AC6).
 */
import type {
  AttemptFailureKind,
  TurnClassification,
  WorkerTurnObservation,
} from "../workers/truncation.ts";
import { TRUNCATION_FEEDBACK, classifyTurn } from "../workers/truncation.ts";
import type {
  AttemptBudgetLimits,
  AttemptBudgetState,
  BudgetDecision,
} from "./attempt-budget.ts";
import {
  DEFAULT_ATTEMPT_BUDGET_LIMITS,
  EMPTY_ATTEMPT_BUDGET,
  recordTurn,
} from "./attempt-budget.ts";

/** Gate outcome for a turn that actually produced work. */
export interface GateResult {
  readonly passed: boolean;
  /** Feedback for the next attempt when the gate failed. */
  readonly feedback: string;
}

/** Telemetry-facing record of one settled turn. */
export interface AttemptTelemetry {
  /** Verbatim stop reason, `null` when none was reported (AC2). */
  readonly stopReason: string | null;
  readonly truncated: boolean;
  readonly failureKind: AttemptFailureKind;
  readonly failureClass: TurnClassification["failureClass"];
  readonly consumedAttemptBudget: boolean;
  readonly attemptsUsed: number;
  readonly harnessRetriesUsed: number;
  readonly consecutiveTruncations: number;
}

/** The controller's settlement of one worker turn. */
export interface SettledTurn {
  readonly classification: TurnClassification;
  readonly budget: BudgetDecision;
  /** `retry` | `judge` collapses to `retry` once feedback is attached. */
  readonly next: "retry" | "pass" | "fail";
  /** Feedback for the next attempt; `null` when there is nothing to retry. */
  readonly feedback: string | null;
  readonly telemetry: AttemptTelemetry;
}

export interface SettleOptions {
  readonly observation: WorkerTurnObservation;
  /** `null` when the turn produced nothing to gate (any harness failure). */
  readonly gate?: GateResult | null;
  readonly state?: AttemptBudgetState;
  readonly limits?: AttemptBudgetLimits;
}

/**
 * Settle one worker turn.
 *
 * The gate result is *ignored* for harness failures, and callers should not
 * even run the gate on one: a truncated turn wrote nothing, so any gate
 * verdict on it measures the absence of work rather than the worker.
 */
export function settleTurn(options: SettleOptions): SettledTurn {
  const classification = classifyTurn(options.observation);
  const state = options.state ?? EMPTY_ATTEMPT_BUDGET;
  const limits = options.limits ?? DEFAULT_ATTEMPT_BUDGET_LIMITS;
  const gate = classification.failureClass === "harness" ? null : (options.gate ?? null);

  const kind: AttemptFailureKind =
    classification.kind !== "none" ? classification.kind : gate?.passed === false ? "gap" : "none";
  const budget = recordTurn(kind, state, limits);

  const telemetry: AttemptTelemetry = {
    stopReason: classification.stopReason,
    truncated: classification.truncated,
    failureKind: kind,
    failureClass: kind === "gap" ? "quality" : classification.failureClass,
    consumedAttemptBudget: budget.consumedAttempt,
    attemptsUsed: budget.state.attemptsUsed,
    harnessRetriesUsed: budget.state.harnessRetriesUsed,
    consecutiveTruncations: budget.state.consecutiveTruncations,
  };

  if (budget.next === "fail") {
    return { classification, budget, next: "fail", feedback: null, telemetry };
  }
  if (budget.next === "judge") {
    // `recordTurn` returns "judge" only for kind === "none", which here means
    // the gate passed (or the caller ran no gate and still owes one).
    return { classification, budget, next: "pass", feedback: null, telemetry };
  }
  return {
    classification,
    budget,
    next: "retry",
    feedback: classification.truncated ? TRUNCATION_FEEDBACK : (gate?.feedback ?? classification.reason),
    telemetry,
  };
}
