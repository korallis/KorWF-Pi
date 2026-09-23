/**
 * KorWF-Pi configuration types (issue #11, PLAN §3.J).
 *
 * These types mirror `src/config/schema.json` (JSON Schema draft 2020-12)
 * one-to-one. The schema is the validation authority; this file exists so
 * the rest of the code base has a typed view of a *resolved* config (all
 * defaults applied) and of the raw user input (everything optional).
 *
 * Defaults and the rationale for each live in `docs/config-reference.md`.
 * Cross-field rules (V1–V12 in that document) are enforced by the validator
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

/** Every `TaskKind`, in schema order. Mirrors `$defs/TaskKind.enum` in `schema.json`. */
export const TASK_KINDS = ["default", "plan", "implement", "test", "review", "docs", "refactor", "research"] as const satisfies readonly TaskKind[];

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
  /** Opt-in main-session routing (PLAN §3.D "Main session"). Default `false`. */
  readonly routeMainSession: boolean;
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

/** Never-auto classes may be `queue` or `stop` in any mode (PLAN §3.C); the schema uses an enum. */
export type NoAutoPolicy = Readonly<Record<WorkflowMode, Exclude<ApprovalDecision, "auto">>>;

/**
 * Configurable (low/medium-risk) action classes. The vocabulary, the default
 * table and the classifier live in `src/workflow/approval-classes.ts` (#15);
 * these unions mirror it and `schema.json` one-to-one.
 */
export type ConfigurableApprovalClass =
  | "read_repository"
  | "edit_worktree"
  | "delete_file"
  | "write_outside_ownership"
  | "modify_project_config"
  | "run_checks"
  | "run_shell"
  | "run_migration"
  | "install_dependencies"
  | "add_dependency"
  | "network_access"
  | "local_commit"
  | "push_own_branch"
  | "spawn_worker"
  | "model_fallback"
  | "model_substitute_more_expensive"
  | "spend_over_estimate"
  | "complete_task";

/**
 * Never `auto` (PLAN §3.C: no silent scope expansion or replan).
 * `model_substitute_pinned` (PLAN §3.D) joins them: falling back from a
 * user's pinned model always asks, in every mode.
 */
export type NoAutoApprovalClass = "scope_change" | "replan" | "model_substitute_pinned";

/** High-risk action classes (PLAN §7): explicit approval regardless of mode. */
export type HighRiskApprovalClass =
  | "destructive_cleanup"
  | "destructive_git"
  | "remote_push"
  /** Merge an integration branch into the branch the user works on (#78, PLAN §3.E). */
  | "merge_to_user_branch"
  | "deployment"
  | "publishing"
  | "credential_access"
  | "modify_policy";

export type ApprovalClass = ConfigurableApprovalClass | NoAutoApprovalClass | HighRiskApprovalClass;

export type ApprovalClasses = Readonly<Record<ConfigurableApprovalClass, ApprovalPolicyPerMode>> &
  Readonly<Record<NoAutoApprovalClass, NoAutoPolicy>> &
  Readonly<Record<HighRiskApprovalClass, HighRiskPolicy>>;

export interface ApprovalsConfig {
  /** Minutes a queued approval waits before the task is marked blocked. 0 = indefinitely. */
  readonly queueTimeoutMinutes: number;
  readonly classes: ApprovalClasses;
}

// ---------------------------------------------------------------------------
// privacy
// ---------------------------------------------------------------------------

export interface OutboundLimits {
  /** Largest single file excerpt sent to Jev or a model provider (bytes). */
  readonly maxSnippetBytes: number;
  readonly maxSnippetsPerRequest: number;
  /** Hard cap on outbound request body size (bytes). */
  readonly maxRequestBytes: number;
  /** Send project-relative paths with snippets. Absolute paths are never sent. */
  readonly sendFilePaths: boolean;
  /** Include remote URL / repo name in Jev context. Off: only a hash. */
  readonly sendRepoIdentity: boolean;
}

export interface RawLoggingConfig {
  readonly enabled: boolean;
  readonly retentionDays: number;
  /** Fixed `true`: deny patterns are applied before writing raw logs. */
  readonly redactBeforeWrite: true;
}

/** `privacy` (PLAN §7). `denyPaths`/`denyPatterns` are supersets of the shipped minimum. */
export interface PrivacyConfig {
  /** Path globs never read into outbound context or logs. ⊇ `ShippedDenyPaths`. */
  readonly denyPaths: readonly string[];
  /** Content regexes (ECMAScript, flags `iu`, per line). ⊇ `ShippedDenyPatterns`. */
  readonly denyPatterns: readonly string[];
  /** Explicit per-project carve-outs; validator rule V7. */
  readonly allowPaths: readonly string[];
  readonly outbound: OutboundLimits;
  readonly rawLogging: RawLoggingConfig;
  readonly firstUseDisclosure: boolean;
}

// ---------------------------------------------------------------------------
// fallback
// ---------------------------------------------------------------------------

/** On a cap mid-task: hand off (packet + intact worktree) or restart (PLAN §3.D). */
export type MidTaskPolicy = "handoff" | "restart";

export type DwellPolicy = "remainder_of_task" | "remainder_of_phase" | "minutes";

export interface FallbackConfig {
  /** Task kind → policy. `default` always present. */
  readonly midTaskPolicy: { readonly default: MidTaskPolicy } & Readonly<
    Partial<Record<TaskKind, MidTaskPolicy>>
  >;
  readonly dwell: DwellPolicy;
  /** Only used when `dwell === "minutes"`. */
  readonly dwellMinutes: number;
  /** Wait for the primary if its cap clears within N minutes. 0 = never wait. */
  readonly preferWaitIfResetWithinMinutes: number;
  /** Fixed `true` (PLAN §3.D recovery rule). */
  readonly retryPrimaryAtTaskBoundary: true;
  /** Ordered model refs used when Jev is unavailable. ⊆ effective allowlist (V1). */
  readonly staticOrder: readonly ModelRef[];
  /** Fixed: all candidates capped → pause the phase. */
  readonly allCappedBehaviour: "pause_phase";
  /** Fixed `false`: pins are never overridden without asking. */
  readonly overridePins: false;
}

// ---------------------------------------------------------------------------
// jev
// ---------------------------------------------------------------------------

/** How the TypeSafe key is resolved. The key itself is never in config. */
export interface JevKeySource {
  readonly kind: "env" | "pi_secrets" | "none";
  /** Env var name or Pi secret name. */
  readonly name: string;
}

/** `jev` (docs/adr/0003-jev-transport.md). No key ⇒ optional mode. */
export interface JevConfig {
  readonly enabled: boolean;
  /** HTTPS origin; configurable for proxies. */
  readonly baseUrl: string;
  readonly keySource: JevKeySource;
  /** Pinned Jev version, e.g. `jev-1.13.0`. Never `jev-latest`. */
  readonly model: `jev-${number}.${number}.${number}`;
  /** Per-decision deadline including retries. */
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly pricePerMillionInputTokensUsd: number;
  readonly cache: { readonly enabled: boolean; readonly ttlSeconds: number };
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

export type NotificationEvent =
  | "approval_queued"
  | "phase_stopped"
  | "budget_exhausted"
  | "all_models_capped"
  | "workflow_completed"
  | "workflow_failed"
  | "model_fallback";

export interface NotificationChannels {
  /** Pi UI notify/status; no-op when `ctx.hasUI` is false. */
  readonly ui: { readonly enabled: boolean };
  readonly desktop: { readonly enabled: boolean };
  /** User executable with JSON event on stdin; counts as `run_shell` for approvals. */
  readonly command: { readonly enabled: boolean; readonly argv: readonly string[] };
  /** HTTPS POST of the redacted event JSON. */
  readonly webhook: { readonly enabled: boolean; readonly url: string | null };
}

export interface NotificationsConfig {
  readonly events: readonly NotificationEvent[];
  readonly channels: NotificationChannels;
  readonly quietHours: { readonly enabled: boolean; readonly start: string; readonly end: string };
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/** `storage` — see `src/storage/paths.ts`. */
export interface StorageConfig {
  /** Override for the storage root; `null` = `<project>/.korwf`. */
  readonly path: string | null;
  readonly allowOutsideProject: boolean;
  readonly artifactRetentionDays: number;
  readonly lockTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------

/** Terminal responses. The recovery ladder always ends on one of these. */
export type TerminalRecoveryResponse = "ask_user" | "stop";

/**
 * `recovery` — bounded recovery policy (PLAN §3.G, issue #53).
 *
 * Every number here is a ceiling, not a target. The failure mode this section
 * exists to prevent is an unbounded retry loop: six attempts on one task that
 * produced nothing. Enforcement is `src/workflow/recovery.ts`.
 */
export interface RecoveryConfig {
  readonly maxAttemptsPerTask: number;
  readonly maxAttemptsPerPhase: number;
  readonly maxEvidenceGatherings: number;
  readonly maxReplans: number;
  readonly maxModelFallbacks: number;
  readonly maxWorkerChanges: number;
  /** Fixed `true`: a side-effecting step is never retried unreconciled. */
  readonly requireReconciliationBeforeRetry: true;
  readonly unreconcilableSideEffect: TerminalRecoveryResponse;
  readonly finalResponse: TerminalRecoveryResponse;
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/**
 * Thresholds for one risk class (issue #47). Every field is optional: an
 * omitted field keeps the shipped default, and a present field may only make
 * the threshold **stricter**. `src/verification/evaluate.ts` enforces that
 * direction in code, so a config that tries to lower a floor is ignored on
 * that field rather than obeyed.
 */
export interface VerificationThresholdsConfig {
  readonly claimConfidence?: number;
  readonly gapCeiling?: number;
  readonly testExercisesMinLevel?: number;
  readonly requireExercisingTest?: boolean;
}

/**
 * `verification` — the evidence-gap evaluators (PLAN §2.4 (2), §3.F).
 *
 * These are condition 2 of the task gate. Nothing here can waive condition 1
 * or 3: the gate computes those from `Evidence`, `Approval` and
 * `CheckDefinition` rows and reads no `Decision` at all.
 */
export interface VerificationConfig {
  readonly thresholds: Readonly<Record<RiskClass, VerificationThresholdsConfig>>;
  /** Largest excerpt the evaluator puts into a question state, in bytes. */
  readonly maxExcerptBytes: number;
  /** Independent review contexts (issue #48). */
  readonly review: ReviewPolicyConfig;
}

/**
 * `verification.review` — which changes require an independent review
 * (PLAN §2.4 (3), §3.F; issue #48).
 *
 * Configuration can only *tighten* this: `rules` are added to the shipped
 * defaults in `src/verification/review.ts`, `reviewEverything` only adds, and
 * high-risk tasks are reviewed whatever is configured. There is deliberately
 * no key that makes a review optional.
 */
export interface ReviewPolicyConfig {
  readonly reviewEverything: boolean;
  readonly rules: readonly ReviewPolicyRuleConfig[];
  readonly preferDifferentModelFamily: boolean;
}

/** One configured review rule. `id` is required; everything else defaults. */
export interface ReviewPolicyRuleConfig {
  readonly id: string;
  readonly changeClasses: readonly string[];
  readonly paths: readonly string[];
  readonly minRiskClass: RiskClass;
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

/** Fully resolved configuration (every default applied). */
export interface KorwfConfig {
  readonly configVersion: typeof CONFIG_VERSION;
  readonly models: ModelsConfig;
  readonly budgets: BudgetsConfig;
  readonly mode: ModeConfig;
  readonly approvals: ApprovalsConfig;
  readonly privacy: PrivacyConfig;
  readonly fallback: FallbackConfig;
  readonly jev: JevConfig;
  readonly notifications: NotificationsConfig;
  readonly storage: StorageConfig;
  readonly recovery: RecoveryConfig;
  readonly verification: VerificationConfig;
}

/** Raw user input as read from the config file. `{}` is valid. */
export type KorwfConfigInput = DeepPartial<KorwfConfig> & { readonly $schema?: string };

/** Section names, in schema order. */
export const CONFIG_SECTIONS = [
  "models",
  "budgets",
  "mode",
  "approvals",
  "privacy",
  "fallback",
  "jev",
  "notifications",
  "storage",
  "recovery",
  "verification",
] as const satisfies readonly (keyof KorwfConfig)[];
