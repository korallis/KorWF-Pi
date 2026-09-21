/**
 * Unattended approval classes (#15), mirrored in docs/approval-classes.md.
 * DATA ONLY plus pure functions: no I/O, no clock, no gate bypass.
 *
 * PLAN §2.6: per approval class and mode, one of `auto` (pre-approved for the
 * mode), `queue` (block this task, continue other ready tasks, notify) or
 * `stop` (stop the phase). PLAN §7: the high-risk set is `stop` in every mode
 * and cannot be configured otherwise. PLAN §3.A: authorization for an
 * irreversible action is never inferred from a Jev score — Jev may only
 * escalate a disposition, never de-escalate it.
 *
 * Boundary (ADR 0005): a class is judged by what the act does — reversible,
 * touches no credential, no consumer impact, not a policy loosening ⇒ it is a
 * candidate for `auto`. Labels, topics and file names are not risk.
 */
import type { ApprovalDecision, ApprovalPolicyPerMode, WorkflowMode } from "../config/types.ts";
import type { RiskClass } from "../storage/records.ts";

export type { ApprovalDecision, ApprovalPolicyPerMode };

export const WORKFLOW_MODES = ["shadow", "advisory", "supervised", "bounded_autonomous"] as const satisfies readonly WorkflowMode[];

/** Strictly ordered: a later entry is always at least as restrictive as an earlier one. */
export const DECISION_ORDER = ["auto", "queue", "stop"] as const satisfies readonly ApprovalDecision[];

// ---------------------------------------------------------------------------
// Class vocabulary. Three tiers, decided by what the act does (ADR 0005), not by
// which file, label or topic it touches.
// ---------------------------------------------------------------------------

/**
 * Configurable classes: the user may set any decision per mode. Validator rule
 * V4 still forbids `auto` for mutation classes in the non-mutating modes.
 */
export const CONFIGURABLE_CLASSES = [
  "read_repository",
  "edit_worktree",
  "delete_file",
  "write_outside_ownership",
  "modify_project_config",
  "run_checks",
  "run_shell",
  "run_migration",
  "install_dependencies",
  "add_dependency",
  "network_access",
  "local_commit",
  "push_own_branch",
  "spawn_worker",
  "model_fallback",
  "model_substitute_more_expensive",
  "spend_over_estimate",
  "complete_task",
] as const;

/**
 * Never-auto classes: PLAN §3.C forbids *silent* scope expansion and replanning,
 * so these may be `queue` or `stop` but never `auto`. They are not PLAN §7
 * high-risk acts (a plan change is reversible), hence not pinned to `stop`.
 */
export const NO_AUTO_CLASSES = ["scope_change", "replan"] as const;

/**
 * High-risk classes (PLAN §7): `stop` in every mode. The schema pins each mode
 * to `const: "stop"`; `validateApprovalClasses` re-checks after layered merge.
 * `remote_push` here means a push to a ref this workflow does not own (shared
 * branches, other people's branches); pushing the agent's own task branch is
 * `push_own_branch` (PLAN §7 last sentence, ADR 0005).
 */
export const HIGH_RISK_CLASSES = [
  "destructive_cleanup",
  "destructive_git",
  "remote_push",
  "deployment",
  "publishing",
  "credential_access",
  "modify_policy",
] as const;

export const APPROVAL_CLASSES = [...CONFIGURABLE_CLASSES, ...NO_AUTO_CLASSES, ...HIGH_RISK_CLASSES] as const;

export type ConfigurableClassId = (typeof CONFIGURABLE_CLASSES)[number];
export type NoAutoClassId = (typeof NO_AUTO_CLASSES)[number];
export type HighRiskClassId = (typeof HIGH_RISK_CLASSES)[number];
export type ApprovalClassId = (typeof APPROVAL_CLASSES)[number];
export type ClassTier = "configurable" | "no_auto" | "high_risk";

export interface ApprovalClassDefinition {
  readonly id: ApprovalClassId;
  readonly tier: ClassTier;
  /** Inherent risk of the act; `high` ⇔ tier `high_risk`. */
  readonly risk: RiskClass;
  /** What the act is, precisely enough to classify it in code. */
  readonly act: string;
  /** ADR 0005 test: reversible? credential? consumer impact? policy loosening? */
  readonly why: string;
  readonly defaults: ApprovalPolicyPerMode;
  /** Class-specific fields added to the common notification payload (§4 of the doc). */
  readonly payload: readonly string[];
}

const S = "stop", Q = "queue", A = "auto";
const pm = (shadow: ApprovalDecision, advisory: ApprovalDecision, supervised: ApprovalDecision, bounded_autonomous: ApprovalDecision): ApprovalPolicyPerMode =>
  ({ shadow, advisory, supervised, bounded_autonomous });
const STOP_ALL = pm(S, S, S, S);

/** Fields present on every notification (docs/approval-classes.md §4). */
export const NOTIFICATION_COMMON_FIELDS = [
  "event", "class", "tier", "decision", "mode", "workflowId", "phaseId", "taskId", "taskRevision",
  "planRevision", "attemptId", "summary", "determinedBy", "jevEscalation", "expiresAt", "resume", "createdAt",
] as const;

// ---------------------------------------------------------------------------
// Default disposition table: class × mode → auto | queue | stop.
// Columns: shadow, advisory, supervised, bounded_autonomous.
// ---------------------------------------------------------------------------
export const APPROVAL_CLASS_TABLE = [
  // --- configurable -------------------------------------------------------
  { id: "read_repository", tier: "configurable", risk: "low",
    act: "Read files, history or metadata inside the repository, minus privacy deny paths.",
    why: "No mutation, no credential (deny paths exclude them), nothing leaves the machine.",
    defaults: pm(A, A, A, A), payload: ["paths"] },
  { id: "edit_worktree", tier: "configurable", risk: "low",
    act: "Create or modify a tracked or new file inside the task worktree and within the task's ownership.",
    why: "Reversible via git; isolated in the task worktree; no consumer impact until merged and gated.",
    defaults: pm(S, S, Q, A), payload: ["paths", "bytesChanged"] },
  { id: "delete_file", tier: "configurable", risk: "low",
    act: "Delete a git-tracked file inside the task worktree and ownership. Untracked, ignored or out-of-worktree deletion is destructive_cleanup.",
    why: "Tracked content is recoverable from history; the task gate still has to pass on the result.",
    defaults: pm(S, S, Q, A), payload: ["paths"] },
  { id: "write_outside_ownership", tier: "configurable", risk: "medium",
    act: "Create, modify or delete a file in the worktree outside the task's declared ownership paths/components.",
    why: "Reversible, but may collide with another task's ownership (PLAN §3.E) and hides scope creep.",
    defaults: pm(S, S, Q, Q), payload: ["paths", "ownerTaskIds"] },
  { id: "modify_project_config", tier: "configurable", risk: "medium",
    act: "Edit build, test, lint, CI or packaging configuration of the target project (not KorWF policy — that is modify_policy).",
    why: "Reversible, but can change what the deterministic checks measure; a human should see it before it is trusted.",
    defaults: pm(S, S, Q, Q), payload: ["paths", "checksAffected"] },
  { id: "run_checks", tier: "configurable", risk: "low",
    act: "Execute a registered check definition of the task inside its worktree.",
    why: "Bounded by the check definition and budgets; produces gate evidence; read-mostly.",
    defaults: pm(S, S, A, A), payload: ["checkId", "command"] },
