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
