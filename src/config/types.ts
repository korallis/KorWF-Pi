/**
 * KorWF-Pi configuration types (issue #11, PLAN §3.J).
 *
 * These types mirror `src/config/schema.json` (JSON Schema draft 2020-12)
 * one-to-one. The schema is the validation authority; this file exists so
 * the rest of the code base has a typed view of a *resolved* config (all
 * defaults applied) and of the raw user input (everything optional).
 *
 * Defaults and the rationale for each live in `docs/config-reference.md`.
 * Cross-field rules (V1–V9 in that document) are enforced by the validator
 * in `src/config/` (issue #21), not here.
 *
 * Shared enums are re-used from `src/storage/records.ts` so config and
 * records never disagree on spelling.
 */
import type { Budget, RiskClass, WorkflowMode } from "../storage/records.ts";

export type { Budget, RiskClass, WorkflowMode };

/** Fully qualified `<provider>/<modelId>` as shown by Pi's model registry. */
export type ModelRef = `${string}/${string}`;

/** Current `configVersion`. */
export const CONFIG_VERSION = 1 as const;

/** Task kinds used for pins and fallback policy. `default` covers unlisted kinds. */
export type TaskKind =
  | "default"
  | "plan"
  | "implement"
  | "test"
  | "review"
  | "docs"
  | "refactor"
  | "research";

/** Utility: deep-partial for the raw (pre-default) user config. */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

/** `models.allowlist` (PLAN §3.D). Empty lists mean "all configured". */
export interface ModelAllowlist {
  /** Provider ids eligible for selection. `[]` = every provider Pi has configured. */
  readonly providers: readonly string[];
  /** Model refs eligible for selection. `[]` = every model of an eligible provider. */
  readonly models: readonly ModelRef[];
  /** Task kind → pinned model. Never overridden by fallback without asking. */
  readonly pins: Readonly<Partial<Record<TaskKind, ModelRef>>>;
}

/** `models.overrides[<modelRef>]` — user card overrides (PLAN §3.D layer 3). */
export interface ModelOverride {
  readonly notes?: string;
  readonly aptitudes?: readonly string[];
  readonly disabled?: boolean;
}

export interface ModelsConfig {
  readonly allowlist: ModelAllowlist;
  readonly overrides: Readonly<Record<ModelRef, ModelOverride>>;
}

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

/** `budgets` — hard-stop caps (PLAN §2.6). Uses the `Budget` record shape. */
export interface BudgetsConfig {
  readonly workflow: Budget;
  readonly phase: Budget;
  readonly task: Budget;
  /** Per-workflow cap on Jev spend, separate from model spend. */
  readonly jev: Budget;
  /** Show a cost estimate and require confirmation before `run` begins. */
  readonly costEstimateBeforeRun: boolean;
}

// ---------------------------------------------------------------------------
// mode and approvals
// ---------------------------------------------------------------------------

/** `mode` — same values as `WorkflowMode` in docs/records.md. */
export type ModeConfig = WorkflowMode;

/** PLAN §2.6: auto-decide, queue-and-continue, stop-the-phase. */
export type ApprovalDecision = "auto" | "queue" | "stop";

export type ApprovalPolicyPerMode = Readonly<Record<WorkflowMode, ApprovalDecision>>;

/** High-risk classes are `stop` in every mode; the schema pins them with `const`. */
export type HighRiskPolicy = Readonly<Record<WorkflowMode, "stop">>;

/** Configurable (low/medium-risk) action classes. */
export type ConfigurableApprovalClass =
  | "read_repository"
  | "edit_worktree"
  | "run_checks"
  | "run_shell"
  | "install_dependencies"
  | "local_commit"
  | "spawn_worker"
  | "model_fallback"
  | "complete_task";

/** High-risk action classes (PLAN §7): explicit approval regardless of mode. */
export type HighRiskApprovalClass =
  | "destructive_cleanup"
  | "remote_push"
  | "deployment"
  | "credential_access"
  | "publishing";

export type ApprovalClass = ConfigurableApprovalClass | HighRiskApprovalClass;

export type ApprovalClasses = Readonly<Record<ConfigurableApprovalClass, ApprovalPolicyPerMode>> &
  Readonly<Record<HighRiskApprovalClass, HighRiskPolicy>>;

export interface ApprovalsConfig {
  /** Minutes a queued approval waits before the task is marked blocked. 0 = indefinitely. */
  readonly queueTimeoutMinutes: number;
  readonly classes: ApprovalClasses;
}

// --- sections are appended below ---
