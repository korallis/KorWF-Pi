/**
 * Phases, state machine, scheduler, approvals, unattended policy, recovery, integration ownership (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `transitions.ts` / `approval-classes.ts` — the Stage 1 data contracts (#13, #15).
 * - `output-budget.ts` — planner task sizing against the model's `maxTokens` (#124).
 * - `attempt-budget.ts` — attempt budget plus a separate bounded harness-retry budget (#124).
 * - `attempt-controller.ts` — settlement of one worker turn (#124).
 */
export {
  ASSUMED_MAX_OUTPUT_TOKENS,
  BYTES_PER_TOKEN,
  DECOMPOSE_FRACTION,
  THINKING_RESERVE,
  TOKENS_PER_LINE,
  WARN_FRACTION,
  estimateTokens,
  outputBudget,
  outputCeilingBindsFirst,
  planIncrementalSteps,
  sizePlan,
  sizeTaskOutput,
} from "./output-budget.ts";
export type {
  ArtifactSizing,
  ExpectedArtifact,
  PlannedTaskOutput,
  PlannedTaskSizing,
  ModelOutputLimits,
  OutputBudget,
  SizingVerdict,
  TaskSizing,
  ThinkingLevel,
} from "./output-budget.ts";

export {
  DEFAULT_ATTEMPT_BUDGET_LIMITS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_CONSECUTIVE_TRUNCATIONS,
  DEFAULT_MAX_HARNESS_RETRIES,
  EMPTY_ATTEMPT_BUDGET,
  attemptsRemaining,
  recordTurn,
} from "./attempt-budget.ts";
export type {
  AttemptBudgetLimits,
  AttemptBudgetState,
  BudgetDecision,
  NextAction,
  TerminalFailure,
} from "./attempt-budget.ts";

export { settleTurn, toAttemptTermination } from "./attempt-controller.ts";
export type { AttemptTelemetry, GateResult, SettleOptions, SettledTurn } from "./attempt-controller.ts";
