/**
 * Persistent record definitions for KorWF-Pi (PLAN §5 "Records").
 *
 * This module is the single source of truth for the shape of every row the
 * SQLite store (Stage 2, #23) persists. It contains only types, constant
 * tables, and small pure helpers. No I/O, no Pi imports, no provider names.
 *
 * Conventions
 * -----------
 * - Every record carries the common envelope from `RecordEnvelope`:
 *   `id`, `createdAt`, `updatedAt`, `schemaVersion`.
 * - Timestamps are ISO-8601 UTC strings (`IsoTimestamp`).
 * - Ids are opaque, stable, branded strings. They never encode meaning and are
 *   never reused.
 * - Mutable records extend `MutableRecord`. Append-only records extend
 *   `AppendOnlyRecord`, whose fields are all `readonly` and whose `updatedAt`
 *   is pinned to `createdAt`. `UpdatePatch<T>` resolves to `never` for
 *   append-only records, so no update path exists in the type design.
 * - Foreign keys and cascade behaviour are declared in `FOREIGN_KEYS`.
 * - Revision and approval-invalidation semantics are documented in
 *   `docs/records.md` and expressed by `Task.revision`,
 *   `Approval.taskRevision`, `Approval.planRevision`, and `Approval.invalidation`.
 */

// ---------------------------------------------------------------------------
// Primitive aliases and brands
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp in UTC, e.g. `2026-09-21T10:15:30.000Z`. */
export type IsoTimestamp = string;

/** Full 40-hex Git commit SHA. Short SHAs are never stored. */
export type GitSha = string;

/** Lower-case hex SHA-256 digest of some content. */
export type ContentHash = string;

/** Monotonic integer revision counter, starting at 1. */
export type Revision = number;

/** Opaque branded id. `Brand` prevents mixing id kinds at compile time. */
export type RecordId<Kind extends string> = string & { readonly __brand: Kind };

export type WorkflowId = RecordId<"workflow">;
export type PhaseId = RecordId<"phase">;
export type TaskId = RecordId<"task">;
export type AttemptId = RecordId<"attempt">;
export type DecisionId = RecordId<"decision">;
export type EvidenceId = RecordId<"evidence">;
export type ApprovalId = RecordId<"approval">;
export type MemoryId = RecordId<"memory">;
export type ModelAvailabilityId = RecordId<"model_availability">;
export type ModelOutcomeId = RecordId<"model_outcome">;
export type AuditEntryId = RecordId<"audit_entry">;

/**
 * Model identifier as exposed by Pi's model registry: `provider/model`.
 * Never a hardcoded provider; always whatever the user's Pi has configured
 * and the allowlist permits (PLAN §3.D).
 */
export type ModelRef = string;

/**
 * Opaque identifier of a *route*: one rate-limited path to a model, i.e. one
 * Pi provider entry plus one model id under it (issue #125, PRD §3.4).
 * Derived by `src/models/route.ts` (`deriveRouteId`), never user-supplied,
 * never parsed. Two providers exposing the same model id are two routes.
 */
export type RouteId = RecordId<"route">;

/** Current version of the record schema described by this module. */
export const RECORDS_SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof RECORDS_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Record envelopes: mutable vs append-only
// ---------------------------------------------------------------------------

/** Fields every persisted record carries (issue #12 Scope). */
export interface RecordEnvelope<Id extends string> {
  /** Stable, opaque, never reused. */
  readonly id: Id;
  readonly createdAt: IsoTimestamp;
  /** For append-only records this always equals `createdAt`. */
  readonly updatedAt: IsoTimestamp;
  /** Schema version the row was written under; migrations bump it. */
  readonly schemaVersion: SchemaVersion;
}

/**
 * Marker for records that may be updated in place. `updatedAt` moves on every
 * write. Which fields are writable is expressed by `UpdatePatch<T>`.
 */
export interface MutableRecord<Id extends string> extends RecordEnvelope<Id> {
  readonly kind: "mutable";
}

/**
 * Marker for append-only records (PLAN §5 "append-only audit table",
 * PLAN §3.I "decisions explained from recorded inputs").
 *
 * Append-only rows are written exactly once. The store exposes no UPDATE or
 * DELETE statement for them; corrections are new rows that reference the old
 * one (see `supersedesId` on the relevant records). `updatedAt` is pinned to
 * `createdAt` so consumers cannot observe an in-place change.
 */
export interface AppendOnlyRecord<Id extends string> extends RecordEnvelope<Id> {
  readonly kind: "append_only";
}

/** Envelope fields the store owns; callers never patch these. */
export type EnvelopeFields = keyof RecordEnvelope<string> | "kind";

/**
 * The only update path in the type design.
 *
 * - For a `MutableRecord`, a patch is a partial of the non-envelope fields.
 * - For an `AppendOnlyRecord`, the patch type is `never`: there is no value
 *   that can be passed to an update call, so no update path exists.
 */
export type UpdatePatch<T extends RecordEnvelope<string>> = T extends AppendOnlyRecord<string>
  ? never
  : T extends MutableRecord<string>
    ? Partial<Omit<T, EnvelopeFields>>
    : never;

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** Operating modes (PLAN §4 `/korwf mode`). */
export type WorkflowMode = "shadow" | "advisory" | "supervised" | "bounded_autonomous";

/** Risk classification used by gates and unattended policy (PLAN §2.4, §2.6). */
export type RiskClass = "low" | "medium" | "high";

/** Task states (PLAN §5 "Task states"). `paused_cap` is `paused(cap)`. */
export type TaskStatus =
  | "proposed"
  | "ready"
  | "running"
  | "verifying"
  | "review"
  | "done"
  | "blocked"
  | "failed"
  | "cancelled"
  | "needs_changes"
  | "paused_cap";

/**
 * Phase gate status (PLAN §2.5). Transitions are defined in
 * `src/workflow/transitions.ts` / `docs/state-machine.md` (issue #13):
 * `integrating`/`verifying`/`review` are the gating states, `passed` is the
 * terminal success state, `paused_cap` is PLAN §3.D "all candidates capped"
 * (also budget caps), and `paused_approval` is PLAN §2.6 "stop the phase".
 */
export type PhaseGateStatus =
  | "pending"
  | "running"
  | "integrating"
  | "verifying"
  | "review"
  | "passed"
  | "failed"
  | "paused_cap"
  | "paused_approval"
  | "cancelled";

/** Budget caps. `null` means "no cap of this kind". */
export interface Budget {
  readonly maxSpendUsd: number | null;
  readonly maxTokens: number | null;
  readonly maxRequests: number | null;
  readonly maxConcurrency: number | null;
  readonly maxElapsedMs: number | null;
}

/** Cost provenance: known (from provider), estimated (from card), or unknown (PLAN §3.I). */
export type CostBasis = "known" | "estimated" | "unknown";

/** Usage accounting for an attempt or a decision. */
export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requests: number;
  readonly spendUsd: number | null;
  readonly costBasis: CostBasis;
}

/** One acceptance criterion; identity is stable across task revisions when the text is unchanged. */
export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
}

/** Executable check registered on a task (PLAN §2.3). */
export interface CheckDefinition {
  readonly id: string;
  readonly kind: "command" | "assertion" | "lint" | "typecheck" | "human";
  /** Exact command line for `command`/`lint`/`typecheck`; description for `human`. */
  readonly command: string;
  /** Working directory relative to the repository root. */
  readonly cwd: string;
  readonly expectedExitCode: number;
  /** Acceptance-criterion ids this check exercises. */
  readonly coversCriteria: readonly string[];
  /** `true` when the check may not be waived by Jev or a worker (PLAN §2.4). */
  readonly required: boolean;
}

/** Ownership declared by the planner; conflicts are detected in code (PLAN §3.E). */
export interface Ownership {
  readonly paths: readonly string[];
  readonly components: readonly string[];
}

/** Jev-independent characterisation of a task (PLAN §3.D "Task profile"). */
export interface TaskProfile {
  readonly domain: string;
  readonly modalities: readonly string[];
  /** 0..1, relative reasoning depth required. */
  readonly reasoningDepth: number;
  /** 0..1, relative context size required. */
  readonly contextSize: number;
  readonly risk: RiskClass;
}

/**
 * Provenance on every excerpt and memory entry (PLAN §3.B):
 * revision, path, range, retrieval method, content hash.
 */
export interface Provenance {
  /** Exact Git revision the content was read at. */
  readonly revision: GitSha;
  /** Repository-relative path. Never absolute. */
  readonly path: string;
  /** Inclusive 1-based line range; `null` when the whole file is meant. */
  readonly range: { readonly startLine: number; readonly endLine: number } | null;
  readonly retrievalMethod: "explicit" | "search" | "symbol" | "dependency" | "pinned" | "plan_document" | "tool_output";
  /** SHA-256 of the excerpt exactly as presented. */
  readonly contentHash: ContentHash;
}

/** Reference to a stored artifact under the artifact directory (PLAN §5). */
export interface ArtifactRef {
  /** Path relative to the artifact directory. Never absolute. */
  readonly relativePath: string;
  readonly contentHash: ContentHash;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Workflow (mutable)
// ---------------------------------------------------------------------------

/** Repository identity; never a machine-specific absolute path. */
export interface RepoIdentity {
  /** Normalised origin URL, or `null` for a repository with no remote. */
  readonly remoteUrl: string | null;
  /** SHA of the root commit; stable across clones. */
  readonly rootCommit: GitSha;
  /** Human label, e.g. the directory basename. */
  readonly name: string;
}

/** Pi session references the workflow is attached to. */
export interface SessionRefs {
  readonly coordinatorSessionId: string;
  readonly workerSessionIds: readonly string[];
}

/** PLAN §5: goal, repo identity, base revision, exclusions, mode, budgets, policy version, session refs. */
export interface Workflow extends MutableRecord<WorkflowId> {
  readonly goal: string;
  readonly repoIdentity: RepoIdentity;
  /** Revision the plan was made against. */
  readonly baseRevision: GitSha;
  /** Paths/components the user excluded from scope. */
  readonly exclusions: readonly string[];
  readonly mode: WorkflowMode;
  readonly budgets: Budget;
  /** Version of the approval/unattended policy in force. */
  readonly policyVersion: string;
  readonly sessionRefs: SessionRefs;
  /**
   * Plan revision. Increments whenever phases/tasks are added, removed, or
   * reordered, or scope changes. Approvals scoped to the plan reference it.
   */
  readonly planRevision: Revision;
  readonly status: "planning" | "ready" | "running" | "paused" | "completed" | "cancelled";
}

// ---------------------------------------------------------------------------
// Phase (mutable)
// ---------------------------------------------------------------------------

/** Phase report produced at completion (PLAN §2.5). */
export interface PhaseReport {
  readonly summary: string;
  readonly evidenceIds: readonly EvidenceId[];
  readonly openQuestions: readonly string[];
  readonly cost: Usage;
  readonly producedAt: IsoTimestamp;
}

/** PLAN §5: id, order, goal, acceptance criteria, budget cap, integration point, gate status, report. */
export interface Phase extends MutableRecord<PhaseId> {
  readonly workflowId: WorkflowId;
  /** Position within the workflow, 0-based; phase 0 may be scaffolding (PLAN §2.7). */
  readonly order: number;
  readonly goal: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly budgetCap: Budget;
  /** Branch/ref into which task worktrees integrate (PLAN §3.E "one integration owner"). */
  readonly integrationPoint: { readonly branch: string; readonly baseRevision: GitSha };
  readonly gateStatus: PhaseGateStatus;
  /** `null` until the phase gate passes. */
  readonly report: PhaseReport | null;
}

// ---------------------------------------------------------------------------
// Task (mutable, revisioned)
// ---------------------------------------------------------------------------

/**
 * PLAN §5: stable id, revision, phase, goal, dependencies, ownership,
 * acceptance criteria, checks, risk class, status.
 *
 * Identity rule: `id` never changes. `revision` increments on any change to
 * `goal`, `acceptanceCriteria`, or `checks` (the fields that define what
 * "done" means). Status changes and `dependencies`/`ownership` edits do not
 * bump the revision. Every Approval and Evidence row records the revision it
 * was produced against; a revision bump invalidates them (see `docs/records.md`).
 */
export interface Task extends MutableRecord<TaskId> {
  readonly workflowId: WorkflowId;
  readonly phaseId: PhaseId;
  readonly revision: Revision;
  readonly goal: string;
  /** Task ids that must be `done` first. Cycles are rejected in code (PLAN §3.C). */
  readonly dependencies: readonly TaskId[];
  readonly ownership: Ownership;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  /** Empty checks ⇒ the task may not become `ready` (PLAN §2.3). */
  readonly checks: readonly CheckDefinition[];
  readonly riskClass: RiskClass;
  readonly status: TaskStatus;
  /** Reason for `blocked`/`failed`/`paused_cap`; `null` otherwise. */
  readonly blocker: string | null;
}

/** Fields of `Task` whose change bumps `Task.revision`. */
export const TASK_REVISIONED_FIELDS = ["goal", "acceptanceCriteria", "checks"] as const satisfies readonly (keyof Task)[];
export type TaskRevisionedField = (typeof TASK_REVISIONED_FIELDS)[number];

// ---------------------------------------------------------------------------
// Attempt (mutable while running; frozen once outcome is set)
// ---------------------------------------------------------------------------

/** Why the used model differs from the requested one (PLAN §3.D "Caps and fallback"). */
export type FallbackReason =
  | "quota_exhausted"
  | "rate_limited"
  | "budget_cap"
  | "model_unavailable"
  | "jev_selected_substitute"
  | "static_fallback_order"
  | "user_pin";

export type AttemptOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "handed_off"
  | "abandoned"
  | "paused_cap";

/** Input set given to the worker; content is referenced by provenance, not copied. */
export interface AttemptInputs {
  readonly taskRevision: Revision;
  readonly contextProvenance: readonly Provenance[];
  readonly pinnedPaths: readonly string[];
  readonly skills: readonly string[];
  /** Content hash of the full handoff packet or prompt bundle. */
  readonly bundleHash: ContentHash;
}

/**
 * PLAN §5: worker id, task profile, requested model, used model, fallback
 * reason, profile, inputs, worktree, timestamps, usage, outcome, artifacts.
 */
export interface Attempt extends MutableRecord<AttemptId> {
  readonly taskId: TaskId;
  /** Task revision this attempt was started against. */
  readonly taskRevision: Revision;
  readonly workerId: string;
  /** Worker role (PLAN §3.E bounded roles). */
  readonly role: "scout" | "planner" | "implementer" | "verifier" | "reviewer" | "integrator";
  readonly taskProfile: TaskProfile;
  readonly requestedModel: ModelRef;
  readonly usedModel: ModelRef;
  /** `null` when `usedModel === requestedModel`. */
  readonly fallbackReason: FallbackReason | null;
  /** Worker profile / contract name (tools, limits, termination criteria). */
  readonly profile: string;
  readonly inputs: AttemptInputs;
  /** Worktree path relative to the workflow's worktree root, plus its branch. */
  readonly worktree: { readonly relativePath: string; readonly branch: string; readonly baseRevision: GitSha };
  readonly timestamps: {
    readonly startedAt: IsoTimestamp;
    readonly endedAt: IsoTimestamp | null;
    readonly lastActivityAt: IsoTimestamp;
  };
  readonly usage: Usage;
  /** `null` while running. Once non-null the store rejects further patches. */
  readonly outcome: AttemptOutcome | null;
  readonly artifacts: readonly ArtifactRef[];
  /** Attempt this one continued from after a fallback/handoff. */
  readonly handedOffFromAttemptId: AttemptId | null;
}

// ---------------------------------------------------------------------------
// Decision (append-only)
// ---------------------------------------------------------------------------

/** Raw distribution as returned by the Jev question, keyed by option label. */
export type Distribution = Readonly<Record<string, number>>;

/** Who or what overrode a decision (PLAN §3.I "overrides tracked explicitly"). */
export interface DecisionOverride {
  readonly actor: "user" | "policy";
  readonly action: string;
  readonly reason: string;
  readonly at: IsoTimestamp;
}

/**
 * PLAN §5: state hash, question version, Jev model version, raw distribution
 * and confidence, policy rule, action, override, freshness.
 *
 * Append-only: a decision is a fact about what was asked and answered. A
 * changed input produces a new Decision with a new `stateHash`.
 */
export interface Decision extends AppendOnlyRecord<DecisionId> {
  readonly workflowId: WorkflowId;
  /** Subject the decision was about; `null` for workflow-level decisions. */
  readonly subject: { readonly taskId: TaskId; readonly taskRevision: Revision } | { readonly phaseId: PhaseId } | null;
  /** Hash of the minimal state sent to Jev (revision-aware cache key). */
  readonly stateHash: ContentHash;
  readonly questionId: string;
  readonly questionVersion: string;
  /** `null` when answered by the deterministic fallback (no key / Jev unavailable). */
  readonly jevModelVersion: string | null;
  readonly rawDistribution: Distribution;
  /** 0..1 confidence; `null` for deterministic fallback. */
  readonly confidence: number | null;
  /** Policy rule id that mapped the answer to an action. */
  readonly policyRule: string;
  readonly action: string;
  readonly override: DecisionOverride | null;
  readonly freshness: {
    /** Revision the state was computed at. */
    readonly revision: GitSha;
    readonly decidedAt: IsoTimestamp;
    /** `null` = valid until the state hash changes. */
    readonly expiresAt: IsoTimestamp | null;
  };
  readonly usage: Usage;
  readonly latencyMs: number | null;
}

// ---------------------------------------------------------------------------
// Evidence (append-only)
// ---------------------------------------------------------------------------

/** Exit status; flaky/missing/unavailable are represented explicitly (PLAN §3.F). */
export type EvidenceExitStatus =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signalled"; readonly signal: string }
  | { readonly kind: "timed_out" }
  | { readonly kind: "flaky"; readonly runs: readonly number[] }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Identity of the command that produced the evidence (PLAN §3.F "command identity, environment"). */
export interface CommandIdentity {
  readonly command: string;
  readonly cwd: string;
  /** Hash of the sanitised environment snapshot (never the values). */
  readonly environmentHash: ContentHash;
}

/**
 * PLAN §5: requirement/check id, artifact, revision, command identity,
 * exit status, reviewer, caveats. Provenance per PLAN §3.B.
 *
 * Append-only: evidence is a fact captured at an exact revision. Evidence
 * is never edited; it is invalidated by a later `Task.revision` or a change
 * under the task's ownership, which is detected by comparing `revision` and
 * `taskRevision` to the current state. Invalidated evidence stays on disk.
 */
export interface Evidence extends AppendOnlyRecord<EvidenceId> {
  readonly workflowId: WorkflowId;
  readonly taskId: TaskId;
  /** Task revision the check definition came from. */
  readonly taskRevision: Revision;
  readonly attemptId: AttemptId | null;
  /** Acceptance-criterion id this evidence supports. */
  readonly requirementId: string;
  /** `CheckDefinition.id` that produced it; `null` for reviewer evidence. */
  readonly checkId: string | null;
  readonly artifact: ArtifactRef | null;
  /** Exact Git revision the check ran at. */
  readonly revision: GitSha;
  readonly commandIdentity: CommandIdentity | null;
  readonly exitStatus: EvidenceExitStatus;
  /** Who produced it: a deterministic check, a review model, or a human. */
  readonly reviewer:
    | { readonly kind: "deterministic" }
    | { readonly kind: "model"; readonly model: ModelRef; readonly attemptId: AttemptId }
    | { readonly kind: "human"; readonly actor: string };
  readonly caveats: readonly string[];
  /** Provenance of the material the evidence was captured from. */
  readonly provenance: readonly Provenance[];
  /** Earlier evidence row this one supersedes (re-verification). */
  readonly supersedesId: EvidenceId | null;
}

// ---------------------------------------------------------------------------
// Approval (mutable only in its `invalidation` field)
// ---------------------------------------------------------------------------

export type ApprovalScope =
  | { readonly kind: "task"; readonly taskId: TaskId }
  | { readonly kind: "phase"; readonly phaseId: PhaseId }
  | { readonly kind: "plan" }
  | { readonly kind: "workflow" };

/**
 * Why an approval stopped being usable. Once set it is never cleared.
 * Each reason is an enumerated event in `APPROVAL_INVALIDATION_EVENTS`
 * (`src/workflow/transitions.ts`, issue #13) with its task/phase state effect.
 */
export interface ApprovalInvalidation {
  readonly reason:
    | "task_revision_changed"
    | "plan_revision_changed"
    | "expired"
    | "mode_changed"
    | "policy_version_changed"
    | "consumed"
    | "revoked"
    | "session_reconciled";
  readonly at: IsoTimestamp;
  readonly detail: string | null;
}

/**
 * PLAN §5: actor, scope, task/plan revision, permitted action, expiry, invalidation.
 *
 * Invalidation rule (issue #12): an approval references `(taskId, taskRevision)`
 * via `scope` + `taskRevision`, and `planRevision`. It is valid only while
 * the referenced `Task.revision` and `Workflow.planRevision` are unchanged,
 * `expiresAt` has not passed, and `invalidation` is `null`.
 * See `isApprovalValid` and `docs/records.md`.
 *
 * The only mutable field is `invalidation`, and only from `null` to non-null.
 * Fork/resume never resurrects an invalidated approval (PLAN §5).
 */
export interface Approval extends MutableRecord<ApprovalId> {
  readonly workflowId: WorkflowId;
  /** Human or policy identity that granted it. Never a Jev score (PLAN §3.A). */
  readonly actor: { readonly kind: "user" | "policy"; readonly identity: string };
  readonly scope: ApprovalScope;
  /** Required when `scope.kind === "task"`; `null` otherwise. */
  readonly taskRevision: Revision | null;
  /** `Workflow.planRevision` at grant time. */
  readonly planRevision: Revision;
  readonly permittedAction: string;
  readonly riskClass: RiskClass;
  readonly expiresAt: IsoTimestamp | null;
  readonly invalidation: ApprovalInvalidation | null;
}

/** The only patchable field on an Approval. */
export type ApprovalPatch = { readonly invalidation: ApprovalInvalidation };

/**
 * Deterministic validity check. Pure; no clock access — the caller passes `now`.
 * Returns the reason an approval is unusable, or `null` when it is valid.
 */
export function approvalInvalidReason(
  approval: Pick<Approval, "scope" | "taskRevision" | "planRevision" | "expiresAt" | "invalidation">,
  current: { readonly task: Pick<Task, "id" | "revision"> | null; readonly planRevision: Revision; readonly now: IsoTimestamp },
): ApprovalInvalidation["reason"] | null {
  if (approval.invalidation !== null) return approval.invalidation.reason;
  if (approval.expiresAt !== null && approval.expiresAt <= current.now) return "expired";
  if (approval.planRevision !== current.planRevision) return "plan_revision_changed";
  if (approval.scope.kind === "task") {
    if (current.task === null || current.task.id !== approval.scope.taskId) return "task_revision_changed";
    if (approval.taskRevision !== current.task.revision) return "task_revision_changed";
  }
  return null;
}

export function isApprovalValid(
  approval: Parameters<typeof approvalInvalidReason>[0],
  current: Parameters<typeof approvalInvalidReason>[1],
): boolean {
  return approvalInvalidReason(approval, current) === null;
}

// ---------------------------------------------------------------------------
// Memory (mutable in status/supersession only)
// ---------------------------------------------------------------------------

/** Memory classes (PLAN §3.H). */
export type MemoryType =
  | "durable_decision"
  | "temporary_observation"
  | "open_question"
  | "superseded_assumption"
  | "reusable_lesson"
  | "required_instruction"
  | "unresolved_commitment";

export type MemoryStatus = "active" | "superseded" | "stale" | "retracted";

/**
 * PLAN §5: source, revision, type, freshness, supersession, status.
 * Provenance per PLAN §3.B on the `source`.
 */
export interface Memory extends MutableRecord<MemoryId> {
  readonly workflowId: WorkflowId;
  /** Where the entry came from. */
  readonly source:
    | { readonly kind: "excerpt"; readonly provenance: Provenance }
    | { readonly kind: "summary"; readonly authorModel: ModelRef; readonly attemptId: AttemptId | null; readonly provenance: readonly Provenance[] }
    | { readonly kind: "user"; readonly sessionId: string }
    | { readonly kind: "decision"; readonly decisionId: DecisionId };
  /** Git revision the entry was true at. */
  readonly revision: GitSha;
  readonly type: MemoryType;
  readonly content: string;
  readonly contentHash: ContentHash;
  readonly freshness: {
    readonly observedAt: IsoTimestamp;
    /** `null` = does not expire on its own. */
    readonly staleAfter: IsoTimestamp | null;
    /** Last time the entry was re-validated against the repo. */
    readonly lastValidatedAt: IsoTimestamp | null;
  };
  readonly supersession: {
    readonly supersededById: MemoryId | null;
    readonly supersedesId: MemoryId | null;
  };
  readonly status: MemoryStatus;
  /** Deterministic pin: required instructions and unresolved commitments (PLAN §3.H). */
  readonly pinned: boolean;
}

// ---------------------------------------------------------------------------
// ModelAvailability (mutable; one row per ROUTE, not per model id)
// ---------------------------------------------------------------------------

export type CapKind = "quota_exhausted" | "rate_limited" | "budget_cap" | "unavailable" | "none";

/**
 * PLAN §5: model id, cap kind, detected at, estimated reset, last probe.
 *
 * Keyed on `routeId` (issue #125): a quota cap belongs to the provider
 * account that hit it, so the same model id under another provider is
 * unaffected. `providerId` and `modelId` are the components the id was
 * derived from, kept for display and for joining to the per-model card.
 */
export interface ModelAvailability extends MutableRecord<ModelAvailabilityId> {
  /** Upsert key. One row per route. */
  readonly routeId: RouteId;
  /** Pi provider key the route belongs to (user-chosen name; never a shipped default). */
  readonly providerId: string;
  /** Bare model id under that provider; joins to the model card. */
  readonly modelId: string;
  readonly capKind: CapKind;
  /** `null` when `capKind === "none"`. */
  readonly detectedAt: IsoTimestamp | null;
  /** `null` when unknown. Recovery retries at the next task boundary after this (PLAN §3.D). */
  readonly estimatedReset: IsoTimestamp | null;
  readonly lastProbe: {
    readonly at: IsoTimestamp;
    readonly result: "available" | "capped" | "error";
    readonly detail: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// ModelOutcome (append-only; feeds card refinement)
// ---------------------------------------------------------------------------

export type OutcomeResult = "succeeded" | "failed" | "needs_changes" | "cancelled" | "handed_off";

/**
 * PLAN §5: model, task profile, result, cost, latency.
 *
 * Attributed per route (issue #125): `routeId` identifies the account the
 * attempt actually ran on, so one account's results never bias another's.
 * `model` remains the `provider/model` ref for the per-model card layer 4.
 */
export interface ModelOutcome extends AppendOnlyRecord<ModelOutcomeId> {
  readonly workflowId: WorkflowId;
  readonly attemptId: AttemptId;
  /** Route the attempt ran on. */
  readonly routeId: RouteId;
  readonly model: ModelRef;
  readonly taskProfile: TaskProfile;
  readonly result: OutcomeResult;
  readonly cost: Usage;
  readonly latencyMs: number;
  /** Whether this outcome was on a fallback model (affects weighting). */
  readonly wasFallback: boolean;
}

// ---------------------------------------------------------------------------
// AuditEntry (append-only audit table, PLAN §5)
// ---------------------------------------------------------------------------

/** Every write to a mutable record produces one audit row. */
export interface AuditEntry extends AppendOnlyRecord<AuditEntryId> {
  readonly workflowId: WorkflowId | null;
  readonly table: RecordTable;
  readonly recordId: string;
  readonly operation: "insert" | "update" | "delete";
  /** Hash of the row before/after; values are not copied into the audit. */
  readonly beforeHash: ContentHash | null;
  readonly afterHash: ContentHash;
  readonly actor: string;
}

// ---------------------------------------------------------------------------
// Table registry, mutability, foreign keys, cascades
// ---------------------------------------------------------------------------

export interface RecordTypes {
  readonly workflow: Workflow;
  readonly phase: Phase;
  readonly task: Task;
  readonly attempt: Attempt;
  readonly decision: Decision;
  readonly evidence: Evidence;
  readonly approval: Approval;
  readonly memory: Memory;
  readonly model_availability: ModelAvailability;
  readonly model_outcome: ModelOutcome;
  readonly audit_entry: AuditEntry;
}

export type RecordTable = keyof RecordTypes;
export type AnyRecord = RecordTypes[RecordTable];

/** Tables that never receive UPDATE/DELETE. Derived from the type, not hand-listed. */
export type AppendOnlyTable = {
  [K in RecordTable]: RecordTypes[K] extends AppendOnlyRecord<string> ? K : never;
}[RecordTable];

export type MutableTable = Exclude<RecordTable, AppendOnlyTable>;

export const APPEND_ONLY_TABLES = ["decision", "evidence", "model_outcome", "audit_entry"] as const satisfies readonly AppendOnlyTable[];

export const MUTABLE_TABLES = ["workflow", "phase", "task", "attempt", "approval", "memory", "model_availability"] as const satisfies readonly MutableTable[];

/**
 * Cascade behaviour on parent delete.
 * - `cascade`: child rows deleted with the parent (only for mutable tables).
 * - `restrict`: parent cannot be deleted while children exist (append-only
 *   children are never deleted, so their parents are never deleted either).
 * - `set_null`: nullable FK is cleared.
 */
export type CascadeRule = "cascade" | "restrict" | "set_null";

export interface ForeignKey {
  readonly from: RecordTable;
  readonly column: string;
  readonly to: RecordTable;
  readonly onDelete: CascadeRule;
}

export const FOREIGN_KEYS: readonly ForeignKey[] = [
  { from: "phase", column: "workflowId", to: "workflow", onDelete: "cascade" },
  { from: "task", column: "workflowId", to: "workflow", onDelete: "cascade" },
  { from: "task", column: "phaseId", to: "phase", onDelete: "cascade" },
  { from: "task", column: "dependencies[]", to: "task", onDelete: "restrict" },
  { from: "attempt", column: "taskId", to: "task", onDelete: "cascade" },
  { from: "attempt", column: "handedOffFromAttemptId", to: "attempt", onDelete: "set_null" },
  { from: "decision", column: "workflowId", to: "workflow", onDelete: "restrict" },
  { from: "decision", column: "subject.taskId", to: "task", onDelete: "restrict" },
  { from: "decision", column: "subject.phaseId", to: "phase", onDelete: "restrict" },
  { from: "evidence", column: "workflowId", to: "workflow", onDelete: "restrict" },
  { from: "evidence", column: "taskId", to: "task", onDelete: "restrict" },
  { from: "evidence", column: "attemptId", to: "attempt", onDelete: "restrict" },
  { from: "evidence", column: "supersedesId", to: "evidence", onDelete: "restrict" },
  { from: "approval", column: "workflowId", to: "workflow", onDelete: "cascade" },
  { from: "approval", column: "scope.taskId", to: "task", onDelete: "cascade" },
  { from: "approval", column: "scope.phaseId", to: "phase", onDelete: "cascade" },
  { from: "memory", column: "workflowId", to: "workflow", onDelete: "cascade" },
  { from: "memory", column: "source.attemptId", to: "attempt", onDelete: "set_null" },
  { from: "memory", column: "source.decisionId", to: "decision", onDelete: "restrict" },
  { from: "memory", column: "supersession.supersededById", to: "memory", onDelete: "set_null" },
  { from: "memory", column: "supersession.supersedesId", to: "memory", onDelete: "set_null" },
  { from: "model_outcome", column: "workflowId", to: "workflow", onDelete: "restrict" },
  { from: "model_outcome", column: "attemptId", to: "attempt", onDelete: "restrict" },
  { from: "audit_entry", column: "workflowId", to: "workflow", onDelete: "restrict" },
];
