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
  { id: "run_shell", tier: "configurable", risk: "medium",
    act: "Execute a shell command that is not a registered check and matches no other class.",
    why: "Arbitrary code execution; reversibility unknown. Never pre-approved by default; the user opts in per project.",
    defaults: pm(S, S, Q, Q), payload: ["command", "cwd"] },
  { id: "run_migration", tier: "configurable", risk: "medium",
    act: "Run a schema or data migration against a local/ephemeral development database created by the task.",
    why: "Reversible on a throwaway store; against any shared or persistent store it is deployment.",
    defaults: pm(S, S, Q, Q), payload: ["command", "target"] },
  { id: "install_dependencies", tier: "configurable", risk: "medium",
    act: "Install the project's already-declared dependencies (lockfile unchanged).",
    why: "Network plus execution of install scripts, but nothing new enters the declared set.",
    defaults: pm(S, S, Q, Q), payload: ["command", "packageManager"] },
  { id: "add_dependency", tier: "configurable", risk: "medium",
    act: "Add, remove or change the version of a declared dependency (manifest or lockfile diff).",
    why: "Reversible, but consumers inherit supply-chain and licence consequences; a human should see it.",
    defaults: pm(S, S, Q, Q), payload: ["packages", "manifestPaths"] },
  { id: "network_access", tier: "configurable", risk: "medium",
    act: "Any outbound connection other than the configured Jev endpoint, model providers and the package registry used by install_dependencies.",
    why: "Data may leave the machine (PLAN §7 data policy); destination is not pre-approved.",
    defaults: pm(S, S, Q, Q), payload: ["hosts", "purpose"] },
  { id: "local_commit", tier: "configurable", risk: "low",
    act: "Create a commit on the task branch in the task worktree.",
    why: "Reversible, local, never leaves the machine.",
    defaults: pm(S, S, Q, A), payload: ["branch", "sha"] },
  { id: "push_own_branch", tier: "configurable", risk: "low",
    act: "Fast-forward push of the workflow's own task branch to the workflow's configured remote (ADR 0005).",
    why: "Reversible (branch can be deleted), no shared history rewritten, nothing consumers receive. Not the PLAN §7 remote push.",
    defaults: pm(S, S, Q, A), payload: ["branch", "remote", "sha"] },
  { id: "spawn_worker", tier: "configurable", risk: "low",
    act: "Start a worker attempt for a ready task within the allowlist and budgets.",
    why: "Spends budget; bounded by budgets.*.maxConcurrency and the caps; visible in the task board.",
    defaults: pm(S, S, Q, A), payload: ["role", "modelRef", "estimatedCost"] },
  { id: "model_fallback", tier: "configurable", risk: "low",
    act: "Switch a running or next attempt to another allowlisted model at equal or lower estimated cost.",
    why: "Within the allowlist, recorded on the Attempt, visible; cost cannot rise.",
    defaults: pm(A, A, Q, A), payload: ["fromModelRef", "toModelRef", "reason"] },
  { id: "model_substitute_more_expensive", tier: "configurable", risk: "medium",
    act: "Switch to an allowlisted model whose estimated cost for the attempt exceeds the primary's.",
    why: "Within the allowlist but spends more than the plan assumed; budgets still hard-stop.",
    defaults: pm(A, A, Q, Q), payload: ["fromModelRef", "toModelRef", "estimatedCostDelta"] },
  { id: "spend_over_estimate", tier: "configurable", risk: "medium",
    act: "Continue a phase whose projected spend exceeds the pre-run estimate by budgets' tolerance (never past a hard cap).",
    why: "Money; a hard cap is still a hard stop regardless of this class (PLAN §2.6).",
    defaults: pm(A, A, Q, Q), payload: ["estimateUsd", "projectedUsd", "capUsd"] },
  { id: "complete_task", tier: "configurable", risk: "low",
    act: "Mark a task done after the task gate (docs/gates.md C1–C5) has passed.",
    why: "The gate is the guard; this class decides only whether a human confirms the transition.",
    defaults: pm(S, S, Q, A), payload: ["gateReceiptId"] },
  // --- never auto (PLAN §3.C: no silent scope expansion) -------------------
  { id: "scope_change", tier: "no_auto", risk: "medium",
    act: "Change a task's goal, acceptance criteria or exclusions, or add/remove tasks in the running phase.",
    why: "Reversible, but PLAN §3.C forbids silent scope expansion; invalidates approvals (plan_revision_changed).",
    defaults: pm(S, S, Q, Q), payload: ["planRevisionFrom", "planRevisionTo", "diffSummary"] },
  { id: "replan", tier: "no_auto", risk: "medium",
    act: "Regenerate the phase plan or task decomposition after a failure or gap.",
    why: "Reversible, but it is a product decision the user must see; never auto in any mode.",
    defaults: pm(S, S, Q, Q), payload: ["reason", "planRevisionFrom", "proposedTaskCount"] },
  // --- high risk (PLAN §7): stop in every mode, not configurable ------------
  { id: "destructive_cleanup", tier: "high_risk", risk: "high",
    act: "Delete or overwrite anything not recoverable from git: untracked/ignored files, directories outside the worktree, other worktrees, stores.",
    why: "Irreversible.", defaults: STOP_ALL, payload: ["paths"] },
  { id: "destructive_git", tier: "high_risk", risk: "high",
    act: "Rewrite or discard history that is shared or not owned by this workflow: force-push, branch -D of a non-task branch, reset --hard past pushed commits, reflog expiry, tag deletion.",
    why: "Irreversible for other people; PLAN §7 'force-pushing or rewriting shared history'.", defaults: STOP_ALL, payload: ["command", "refs"] },
  { id: "remote_push", tier: "high_risk", risk: "high",
    act: "Push to a ref the workflow does not own (main/default branch, shared branches, another workflow's branch) or to a remote other than the configured one.",
    why: "Consumers receive it; may be irreversible downstream. The agent's own task branch is push_own_branch.", defaults: STOP_ALL, payload: ["branch", "remote", "sha"] },
  { id: "deployment", tier: "high_risk", risk: "high",
    act: "Any action that changes a running or shared environment: deploy, migrate a shared database, change infrastructure.",
    why: "Consumer impact; often irreversible.", defaults: STOP_ALL, payload: ["target", "command"] },
  { id: "publishing", tier: "high_risk", risk: "high",
    act: "Publish or release: create/push tags, publish to a registry, create a release, anything consumers receive.",
    why: "Consumers receive it; registries do not un-publish.", defaults: STOP_ALL, payload: ["artifact", "target"] },
  { id: "credential_access", tier: "high_risk", risk: "high",
    act: "Read, write, print or transmit a secret, key, token or credential store, or a privacy deny path.",
    why: "Credential.", defaults: STOP_ALL, payload: ["paths", "secretKind"] },
  { id: "modify_policy", tier: "high_risk", risk: "high",
    act: "Change KorWF config or policy: approval classes, allowlist, budgets, privacy lists, execution isolation, or this table.",
    why: "Policy loosening; the system never weakens its own permission, allowlist or spending policy (AGENTS.md §4).",
    defaults: STOP_ALL, payload: ["paths", "keysChanged"] },
] as const satisfies readonly ApprovalClassDefinition[];

export type ApprovalClassTable = Readonly<Record<ApprovalClassId, ApprovalPolicyPerMode>>;

/** `classes` defaults as plain data, in the shape of `config.approvals.classes`. */
export const DEFAULT_APPROVAL_CLASSES: ApprovalClassTable = Object.fromEntries(
  APPROVAL_CLASS_TABLE.map((c) => [c.id, c.defaults]),
) as ApprovalClassTable;

// ---------------------------------------------------------------------------
// Validation (config → effective table). Deterministic; never waivable.
// ---------------------------------------------------------------------------

export type ApprovalClassViolation =
  | { readonly rule: "V4"; readonly classId: ApprovalClassId; readonly mode: WorkflowMode; readonly message: string }
  | { readonly rule: "V10"; readonly classId: ApprovalClassId; readonly mode: WorkflowMode; readonly message: string }
  | { readonly rule: "V11"; readonly classId: ApprovalClassId; readonly mode: WorkflowMode; readonly message: string }
  | { readonly rule: "V12"; readonly classId: ApprovalClassId; readonly message: string };

/** Mutation classes may not be `auto` in the non-mutating modes (config-reference V4). */
export const NON_MUTATING_MODES = ["shadow", "advisory"] as const satisfies readonly WorkflowMode[];
export const MUTATION_CLASSES: readonly ApprovalClassId[] = APPROVAL_CLASS_TABLE
  .filter((c) => !["read_repository", "model_fallback", "model_substitute_more_expensive", "spend_over_estimate"].includes(c.id))
  .map((c) => c.id);

/**
 * Checks a full or partial `approvals.classes` object against the rules that the
 * JSON schema cannot express after a layered merge:
 *  - V10: high-risk classes are `stop` in every mode (schema `const`, re-checked here).
 *  - V11: `scope_change`/`replan` are never `auto`.
 *  - V4:  mutation classes are never `auto` in shadow/advisory.
 *  - V12: every listed class has a decision for all four modes.
 * Returns an empty array when valid. Unknown class ids are rejected by the
 * schema (`additionalProperties: false`) and are ignored here.
 */
export function validateApprovalClasses(
  classes: Readonly<Partial<Record<ApprovalClassId, Partial<ApprovalPolicyPerMode>>>>,
): readonly ApprovalClassViolation[] {
  const out: ApprovalClassViolation[] = [];
  for (const def of APPROVAL_CLASS_TABLE) {
    const row = classes[def.id];
    if (row === undefined) continue;
    for (const mode of WORKFLOW_MODES) {
      const d = row[mode];
      if (d === undefined) { out.push({ rule: "V12", classId: def.id, message: `${def.id} has no decision for mode ${mode}` }); continue; }
      if (def.tier === "high_risk" && d !== "stop")
        out.push({ rule: "V10", classId: def.id, mode, message: `${def.id} is high-risk (PLAN §7) and must be "stop" in ${mode}, got "${d}"` });
      if (def.tier === "no_auto" && d === "auto")
        out.push({ rule: "V11", classId: def.id, mode, message: `${def.id} may never be "auto" (PLAN §3.C: no silent scope expansion)` });
      if (d === "auto" && (NON_MUTATING_MODES as readonly WorkflowMode[]).includes(mode) && MUTATION_CLASSES.includes(def.id))
        out.push({ rule: "V4", classId: def.id, mode, message: `${def.id} mutates; ${mode} is non-mutating so it cannot be "auto"` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disposition: config → decision; Jev may escalate, never de-escalate.
// ---------------------------------------------------------------------------

export const isMoreRestrictive = (a: ApprovalDecision, b: ApprovalDecision): boolean =>
  DECISION_ORDER.indexOf(a) > DECISION_ORDER.indexOf(b);

export interface JevEscalation {
  /** Jev question id (src/decisions) that produced the signal, for the trace. */
  readonly questionId: string;
  /** Decision Jev proposes. Only honoured when more restrictive than the rule result. */
  readonly proposed: ApprovalDecision;
  readonly probability: number;
}

export interface Disposition {
  readonly classId: ApprovalClassId;
  readonly mode: WorkflowMode;
  /** Result of the deterministic rules alone. */
  readonly ruleDecision: ApprovalDecision;
  /** Final decision; `≥ ruleDecision` in DECISION_ORDER, always. */
  readonly decision: ApprovalDecision;
  /** `null` when no Jev signal was offered or it was ignored (not more restrictive). */
  readonly jevEscalation: JevEscalation | null;
}

/**
 * Resolve the disposition for a classified act.
 * - The table (after config merge) gives `ruleDecision`; high-risk classes are
 *   `stop` regardless of what `table` says (defence in depth: the schema and
 *   V10 already reject such a table).
 * - A Jev signal can raise the decision (auto → queue → stop) and is recorded;
 *   a signal proposing something less restrictive is discarded and recorded as
 *   ignored (`jevEscalation: null`). No Jev key ⇒ pass `null` ⇒ rules alone.
 */
export function resolveDisposition(
  classId: ApprovalClassId,
  mode: WorkflowMode,
  table: ApprovalClassTable = DEFAULT_APPROVAL_CLASSES,
  jev: JevEscalation | null = null,
): Disposition {
  const def = APPROVAL_CLASS_TABLE.find((c) => c.id === classId);
  if (def === undefined) throw new Error(`unknown approval class ${String(classId)}`);
  let ruleDecision: ApprovalDecision = def.tier === "high_risk" ? "stop" : table[classId][mode];
  if (def.tier === "no_auto" && ruleDecision === "auto") ruleDecision = "queue";
  const escalate = jev !== null && isMoreRestrictive(jev.proposed, ruleDecision);
  return { classId, mode, ruleDecision, decision: escalate ? jev.proposed : ruleDecision, jevEscalation: escalate ? jev : null };
}

/**
 * Deterministic classification input. Every field is computed by code
 * (`src/git/` for diffs and refs, `src/security/` for paths and network,
 * `src/models/` for cost) — never by a worker's claim or a Jev answer.
 */
export interface ActFacts {
  readonly kind: "read" | "write" | "delete" | "exec" | "git" | "network" | "model" | "plan" | "task";
  readonly paths?: readonly string[];
  readonly insideWorktree?: boolean;
  readonly insideOwnership?: boolean;
  readonly gitTracked?: boolean;
  readonly touchesDenyPath?: boolean;
  readonly touchesKorwfPolicy?: boolean;
  readonly touchesProjectConfig?: boolean;
  readonly touchesDependencyManifest?: boolean;
  readonly isRegisteredCheck?: boolean;
  readonly isMigration?: boolean;
  readonly targetIsEphemeral?: boolean;
  readonly isInstallOfDeclared?: boolean;
  readonly gitOp?: "commit" | "push" | "force_push" | "rewrite" | "delete_ref" | "tag";
  readonly refOwnedByWorkflow?: boolean;
  readonly remoteIsConfigured?: boolean;
  readonly hostAllowlisted?: boolean;
  readonly costDeltaUsd?: number;
  readonly planOp?: "scope_change" | "replan";
  readonly taskOp?: "spawn_worker" | "complete_task" | "spend_over_estimate";
  readonly isDeploy?: boolean;
  readonly isPublish?: boolean;
}

/**
 * Deterministic classifier (docs/approval-classes.md §5). Rules are ordered
 * most-restrictive-first and the first match wins, so an act that satisfies
 * several rules lands in the most restrictive class. Anything unmatched falls
 * to `run_shell` for executions and `write_outside_ownership` for writes —
 * never to `auto` by omission. Jev is not consulted here.
 */
export function classifyAct(f: ActFacts): ApprovalClassId {
  // High-risk first (PLAN §7). Order within the tier does not matter: all are `stop`.
  if (f.touchesDenyPath === true) return "credential_access";
  if (f.touchesKorwfPolicy === true) return "modify_policy";
  if (f.isPublish === true || f.gitOp === "tag") return "publishing";
  if (f.isDeploy === true || (f.isMigration === true && f.targetIsEphemeral !== true)) return "deployment";
  if (f.gitOp === "force_push" || f.gitOp === "rewrite" || f.gitOp === "delete_ref") return "destructive_git";
  if (f.gitOp === "push" && (f.refOwnedByWorkflow !== true || f.remoteIsConfigured !== true)) return "remote_push";
  if (f.kind === "delete" && (f.gitTracked !== true || f.insideWorktree !== true)) return "destructive_cleanup";
  if ((f.kind === "write" || f.kind === "delete") && f.insideWorktree !== true) return "destructive_cleanup";
  // Never-auto.
  if (f.planOp === "scope_change") return "scope_change";
  if (f.planOp === "replan") return "replan";
  // Configurable, medium before low.
  if (f.kind === "network") return f.hostAllowlisted === true ? "read_repository" : "network_access";
  if (f.kind === "model") return (f.costDeltaUsd ?? 0) > 0 ? "model_substitute_more_expensive" : "model_fallback";
  if (f.kind === "task") {
    if (f.taskOp === "spend_over_estimate") return "spend_over_estimate";
    if (f.taskOp === "complete_task") return "complete_task";
    return "spawn_worker";
  }
  if (f.kind === "git") return f.gitOp === "push" ? "push_own_branch" : "local_commit";
  if (f.kind === "exec") {
    if (f.isRegisteredCheck === true) return "run_checks";
    if (f.isMigration === true) return "run_migration";
    if (f.touchesDependencyManifest === true) return "add_dependency";
    if (f.isInstallOfDeclared === true) return "install_dependencies";
    return "run_shell";
  }
  if (f.kind === "read") return "read_repository";
  // write | delete inside the worktree
  if (f.touchesDependencyManifest === true) return "add_dependency";
  if (f.touchesProjectConfig === true) return "modify_project_config";
  if (f.insideOwnership !== true) return "write_outside_ownership";
  return f.kind === "delete" ? "delete_file" : "edit_worktree";
}
