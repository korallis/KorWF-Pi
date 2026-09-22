/**
 * Phases, state machine, scheduler, approvals, unattended policy, recovery, integration ownership (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `transitions.ts` / `approval-classes.ts` — the Stage 1 data contracts (#13, #15).
 * - `output-budget.ts` — planner task sizing against the model's `maxTokens` (#124).
 * - `attempt-budget.ts` — attempt budget plus a separate bounded harness-retry budget (#124).
 * - `attempt-controller.ts` — settlement of one worker turn (#124).
 * - `plan-schema.ts` / `plan-parse.ts` / `planner.ts` / `plan-store.ts` —
 *   structured plan generation with per-task verification checks (#37).
 * - `graph.ts` — dependency-graph validation, ready set and topological
 *   order over persisted Task records; wired into `plan-store.ts` so an
 *   invalid graph can never be saved (#40).
 */
export {
  buildWorkflow,
  CURRENT_POLICY_VERSION,
  deterministicClarificationQuestions,
  GREENFIELD_ROOT_COMMIT,
  intakeSummary,
  MAX_CLARIFICATION_QUESTIONS,
  parsePlanArgs,
  resolveRepo,
  runClarificationLoop,
} from "./intake.ts";
export type {
  BuildWorkflowInput,
  ClarificationAnswer,
  ClarificationPrompt,
  ClarificationQuestion,
  ClarificationResult,
  FreeTextClassification,
  ParsedMode,
  ParsedPlanArgs,
  ResolvedRepo,
} from "./intake.ts";
export { classifyFreeText } from "./intake.ts";
export { classifyByRules, DETERMINISTIC_RULES } from "./intake-rules.ts";
export type { IntakeClass, IntakeClassification, IntakeRule, RuleMatch } from "./intake-rules.ts";
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

export {
  EXECUTABLE_CHECK_KINDS,
  NO_CHECKS_BLOCKER,
  OUTPUT_BUDGET_BLOCKER,
  PLAN_CHECK_KINDS,
  PLAN_RISK_CLASSES,
  PLAN_SCHEMA_VERSION,
  SUPERSEDED_BLOCKER,
  formatPlanIssues,
  hasRegisteredChecks,
  ownershipOverlaps,
  taskReadiness,
  validateDependencyGraph,
  validatePlanDocument,
} from "./plan-schema.ts";
export type {
  DependencyGraphResult,
  PlanArtifact,
  PlanCheck,
  PlanCheckKind,
  PlanCriterion,
  PlanDocument,
  PlanIssue,
  PlanPhase,
  PlanRuleId,
  PlanTask,
  PlanValidation,
  TaskReadiness,
} from "./plan-schema.ts";

export { MAX_PLAN_BYTES, MAX_RETRY_FINDINGS, buildRetryPrompt, extractJson, parsePlanOutput } from "./plan-parse.ts";
export type { PlanParseResult } from "./plan-parse.ts";

export {
  DEFAULT_MAX_EXCERPT_CHARS,
  DEFAULT_PLAN_ATTEMPTS,
  UNKNOWN_WORKER_LIMITS,
  buildPlannerPrompt,
  deterministicPlanSkeleton,
  generatePlan,
  greenfieldScaffoldingIssues,
  planRulesText,
  planSchemaText,
  sizePlanTasks,
  tasksNeedingDecomposition,
} from "./planner.ts";
export type {
  GeneratePlanOptions,
  GeneratePlanResult,
  PlannerAttemptRecord,
  PlannerContextExcerpt,
  PlannerIntake,
  PlannerModel,
  PlannerPromptInput,
} from "./planner.ts";

export {
  INITIAL_TASK_STATUS,
  PlanPersistError,
  defaultIntegrationBranch,
  definitionOfDoneChanged,
  initialStatusFor,
  persistOrRevisePlan,
  persistPlan,
  readStoredPlan,
  revisePlan,
  summarisePersistedPlan,
} from "./plan-store.ts";
export type { IdMapping, PersistPlanOptions, PersistPlanResult, StoredPlan } from "./plan-store.ts";

export { READINESS_GRAPH_PRECONDITION, findGraphCycles, readySet, topoOrder, validateGraph } from "./graph.ts";
export type {
  CycleSearchResult,
  DependencyEdge,
  GraphIssue,
  GraphRuleId,
  GraphValidationResult,
  TopoOrderResult,
} from "./graph.ts";
export {
  composeTaskReadiness,
  evaluatePlan,
  evaluateRequirementCoverage,
  evaluateTaskSemantics,
  formatPlanEvaluation,
  formatSemanticField,
  formatTaskEvaluation,
  NOT_EVALUATED,
} from "./evaluate-plan.ts";
export type {
  IntakeRequirement,
  PlanEvaluation,
  RequirementCoverage,
  SemanticResult,
  TaskEvaluation,
} from "./evaluate-plan.ts";
