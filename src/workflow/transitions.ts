/**
 * KorWF Stage 1 transition contract (#13), mirrored in docs/state-machine.md.
 * DATA ONLY: no evaluator, state mutation, dispatch, clock, I/O, or gate bypass.
 * Stage 3 implements these rows; all preconditions are conjunctive guard ids.
 */
import type { ApprovalInvalidation, PhaseGateStatus, TaskStatus } from "../storage/records.ts";

export const TASK_STATES = [
  "proposed", "ready", "running", "verifying", "review", "done", "blocked",
  "failed", "cancelled", "needs_changes", "paused_cap",
] as const satisfies readonly TaskStatus[];
export const TASK_TERMINAL_STATES = ["done", "cancelled"] as const;
export const TASK_NONTERMINAL_STATES = [
  "proposed", "ready", "running", "verifying", "review", "blocked", "failed", "needs_changes", "paused_cap",
] as const satisfies readonly TaskStatus[];

export const PHASE_STATES = ["pending", "running", "gating", "done", "paused", "failed", "cancelled"] as const;
export type PhaseState = (typeof PHASE_STATES)[number];
export const PHASE_TERMINAL_STATES = ["done", "cancelled"] as const;
export const PHASE_NONTERMINAL_STATES = ["pending", "running", "gating", "paused", "failed"] as const;
/** Canonical lifecycle states are a projection, not a replacement of #12's gate stages. */
export const PHASE_STORAGE_STATES = {
  pending: ["pending"], running: ["running"], gating: ["integrating", "verifying", "review"],
  done: ["passed"], paused: ["paused_cap", "paused_approval"], failed: ["failed"], cancelled: ["cancelled"],
} as const satisfies Record<PhaseState, readonly PhaseGateStatus[]>;

export const PRECONDITIONS = {
  checks_registered: "Task.checks.length >= 1; every registered check is executable or an explicitly required human check (PLAN 2.3).",
  readiness_valid: "Current task/plan schema, criterion coverage and acyclic dependencies validated; dependencies done; scope approved; no unresolved blocker; ownership schedulable.",
  authorization_current: "Current mode, policy, scope, revisions and unexpired approvals permit this action; high-risk actions require explicit approval in every mode.",
  dispatch_allowed: "Parent phase running; allowlist, pin, capability, budget, concurrency and ownership constraints pass; eligible model available.",
  attempt_settled: "Current attempt stopped and artifacts/revision captured; worker completion is only a request, not success evidence.",
  all_checks_pass_exact_revision: "Every registered check passes for the current Task.revision and exact Git SHA to be marked done: commands exit 0; human checks have explicit passing human evidence. Missing, stale, flaky, unavailable or nonzero results fail; required=false is not an exemption.",
  no_jev_gap_or_disabled: "Fresh Jev assessment finds no gap for every criterion and tests exercise the requirement, OR optional assistance is explicitly disabled (including no-key mode) with a recorded deterministic coverage assessment. Missing/error/unknown Jev response is not no-gap; record disabled fallback before proceeding. Checks and review remain mandatory.",
  policy_review_satisfied: "All current policy-required independent model reviews and high-risk human approvals pass at the same task/plan/policy and exact Git revision; a recorded policy result states when no review is required.",
  failure_observed: "Actual non-cap execution/environment/check failure recorded; not merely a worker's unsupported claim.",
  changes_required: "Evidence gap or review findings require changes; record failed criteria and bounded next steps.",
  blocker_present: "Unresolved dependency, permission, information or user pause prevents progress; never treat a blocker as success.",
  recovery_authorized: "Bounded recovery plan fits approved scope/budget; uncertain external effects reconciled before retry; no automatic policy weakening.",
  all_eligible_models_capped: "The pre-cap eligible set is nonempty and every member is capped; eligibility respects allowlist, capability, pins and policy. No eligible model is a blocker, not vacuous all-capped.",
  cap_resume_valid: "A previously capped eligible candidate is available under current ModelAvailability/reset policy; revisions, approvals, dependencies, ownership, budgets and pins revalidated; no other pause reason remains; cancellation absent.",
  phase_start_valid: "Approved current plan, preceding phase gates and phase budget permit run; at least one schedulable task OR all tasks already done and integrated gating needs retry; no unresolved phase stop.",
  all_tasks_done: "Every task in the current approved phase is done at its current revision; failed, blocked, paused or cancelled tasks cannot count as done.",
  integrated_checks_pass_exact_revision: "All integrated checks exit 0 on the exact merged Git SHA under the sole integration owner; current task completion receipts and phase evidence match the approved plan. Later edits require fresh verification.",
  phase_no_jev_gap_or_disabled: "Fresh phase Jev assessment finds no gap between phase criteria and accumulated evidence, OR recorded disabled/no-key deterministic coverage fallback; errors/unknown never masquerade as no-gap.",
  phase_policy_review_satisfied: "All policy-required phase reviews and high-risk human approvals pass for the exact merged SHA and current plan/mode/policy; explicit policy result if none required.",
  phase_stop_present: "Cap, budget hard stop, manual pause, inadequate substitute, pin conflict or stop-phase approval rule requires a resumable halt.",
  manual_resume_valid: "User explicitly resumes; stop reasons resolved; approvals, scope, dependencies, budgets, allowlist, pins and live repository state revalidated; no cancelled or terminal work replayed.",
  invalidation_applies: "An enumerated invalidation event affects this nonterminal subject; approval remains unusable even if the state was already blocked/paused.",
  stop_phase_required: "Invalidation mapping requires a phase stop (revision changes always stop; other approval classes use queue-and-continue or stop-phase policy).",
  revision_changed: "Relevant Git content changed since evidence was captured; old evidence retained but excluded from current gates.",
  user_revision_requested: "User requests replan/scope/priority change within explicit authorization; bump task and/or plan revisions by records.md rules and never expand scope silently.",
  cancellation_requested: "Explicit user cancellation or previously user-approved cancellation policy; deny further dispatch immediately and stop/reconcile children before finalizing cancellation.",
} as const;
export type Precondition = keyof typeof PRECONDITIONS;
export type TriggerActor = "engine_only" | "user" | "worker_request_then_engine";
export interface Transition<State extends string> {
  readonly id: string;
  readonly from: readonly State[];
  readonly to: State;
  readonly trigger: string;
  readonly whoMayTrigger: readonly TriggerActor[];
  readonly preconditions: readonly Precondition[];
  readonly requiredEvidence: readonly string[];
  readonly sideEffects: readonly string[];
}

export const READY_PRECONDITIONS = ["checks_registered", "readiness_valid", "authorization_current"] as const;
export const TASK_DONE_PRECONDITIONS = [
  "checks_registered", "all_checks_pass_exact_revision", "no_jev_gap_or_disabled", "policy_review_satisfied",
] as const;
export const PHASE_DONE_PRECONDITIONS = [
  "all_tasks_done", "integrated_checks_pass_exact_revision", "phase_no_jev_gap_or_disabled", "phase_policy_review_satisfied",
] as const;

export const TASK_TRANSITIONS = [
  {
    id: "task-ready", from: ["proposed", "blocked", "failed", "needs_changes"], to: "ready", trigger: "readiness_validated",
    whoMayTrigger: ["engine_only"], preconditions: [...READY_PRECONDITIONS, "recovery_authorized"],
    requiredEvidence: ["current checks and criterion coverage", "dependency/schema validation", "scope/approval and recovery decision"],
    sideEffects: ["clear resolved blocker", "queue task without spawning a worker"],
  },
  {
    id: "task-dispatch", from: ["ready"], to: "running", trigger: "dispatch",
    whoMayTrigger: ["engine_only"], preconditions: [...READY_PRECONDITIONS, "dispatch_allowed"],
    requiredEvidence: ["current authorization and model selection", "budget and ownership reservation", "attempt contract"],
    sideEffects: ["create attempt and isolated worktree binding", "record and surface requested/used model and fallback reason"],
  },
  {
    id: "task-submit", from: ["running"], to: "verifying", trigger: "completion_requested",
    whoMayTrigger: ["engine_only", "worker_request_then_engine"], preconditions: ["attempt_settled"],
    requiredEvidence: ["attempt artifacts and completion claim", "current task revision and exact Git SHA"],
    sideEffects: ["schedule all registered checks", "do not count worker claim as passing evidence"],
  },
  {
    id: "task-review", from: ["verifying"], to: "review", trigger: "checks_and_gap_assessed",
    whoMayTrigger: ["engine_only"], preconditions: ["checks_registered", "all_checks_pass_exact_revision", "no_jev_gap_or_disabled"],
    requiredEvidence: ["per-check results and criterion coverage at current revisions", "fresh gap decision or recorded disabled fallback"],
    sideEffects: ["request policy-required independent review and human approvals"],
  },
  {
    id: "task-done", from: ["review"], to: "done", trigger: "task_gate_passed",
    whoMayTrigger: ["engine_only"], preconditions: TASK_DONE_PRECONDITIONS,
    requiredEvidence: ["all check evidence at exact task/Git revision", "criterion coverage and no-gap decision or disabled fallback", "policy review result and required approvals"],
    sideEffects: ["atomically record gate receipt and completion revision", "release ownership and surface evidence-backed completion"],
  },
  {
    id: "task-failed", from: ["running", "verifying", "review"], to: "failed", trigger: "non_cap_failure",
    whoMayTrigger: ["engine_only", "worker_request_then_engine"], preconditions: ["failure_observed"],
    requiredEvidence: ["failure category and attempt/check outcome", "bounded next-step options"],
    sideEffects: ["stop/reconcile active attempt", "retain worktree and evidence; release execution reservations"],
  },
  {
    id: "task-changes", from: ["verifying", "review"], to: "needs_changes", trigger: "gap_or_review_changes",
    whoMayTrigger: ["engine_only"], preconditions: ["changes_required"],
    requiredEvidence: ["gap decision or independent/human review findings with criterion ids"],
    sideEffects: ["retain failed gate evidence", "request bounded remediation, never silently change scope"],
  },
  {
    id: "task-block", from: TASK_NONTERMINAL_STATES, to: "blocked", trigger: "blocker_or_user_pause",
    whoMayTrigger: ["engine_only", "user", "worker_request_then_engine"], preconditions: ["blocker_present"],
    requiredEvidence: ["blocker reason, affected action and policy disposition"],
    sideEffects: ["halt affected dispatch/attempt at safe boundary", "queue approval or notify; retain resumable artifacts"],
  },
  {
    id: "task-invalidate", from: TASK_NONTERMINAL_STATES, to: "blocked", trigger: "approval_invalidated",
    whoMayTrigger: ["engine_only"], preconditions: ["invalidation_applies"],
    requiredEvidence: ["invalidation event, affected approval ids and current revisions/mode/policy"],
    sideEffects: ["invalidate approvals atomically with source change", "stop affected action; retain evidence as history", "apply phase invalidation disposition"],
  },
  {
    id: "task-replan", from: TASK_NONTERMINAL_STATES, to: "proposed", trigger: "user_replan",
    whoMayTrigger: ["user"], preconditions: ["user_revision_requested"],
    requiredEvidence: ["authorized plan/task diff and revision counters"],
    sideEffects: ["stop/reconcile affected attempts", "apply revision invalidation before any dispatch; affected tasks end blocked via task-invalidate", "require readiness again"],
  },
  {
    id: "task-stale-evidence", from: ["verifying", "review"], to: "verifying", trigger: "git_revision_changed",
    whoMayTrigger: ["engine_only"], preconditions: ["revision_changed"],
    requiredEvidence: ["old/new exact Git SHA and affected evidence ids"],
    sideEffects: ["exclude stale checks, gap decisions and reviews", "rerun checks and all revision-sensitive review"],
  },
  {
    id: "task-cap", from: ["ready", "running", "verifying", "review"], to: "paused_cap", trigger: "all_candidates_capped",
    whoMayTrigger: ["engine_only"], preconditions: ["all_eligible_models_capped"],
    requiredEvidence: ["eligible set and per-model ModelAvailability", "estimated reset or unknown", "handoff and previous stage if mid-attempt"],
    sideEffects: ["pause parent phase in same transaction", "settle attempt as paused_cap, not failed; preserve worktree", "surface cap/reset and stop phase dispatch"],
  },
  {
    id: "task-cap-resume", from: ["paused_cap"], to: "ready", trigger: "eligible_cap_cleared",
    whoMayTrigger: ["engine_only"], preconditions: [...READY_PRECONDITIONS, "cap_resume_valid", "recovery_authorized"],
    requiredEvidence: ["updated availability", "fresh readiness/authorization/budget evaluation", "reconciled handoff and saved stage"],
    sideEffects: ["resume parent only through phase-cap-resume", "new attempt continues saved stage via explicit handoff (or authorized restart); never replay effects", "rerun current checks/review before done"],
  },
  {
    id: "task-cancel", from: TASK_NONTERMINAL_STATES, to: "cancelled", trigger: "cancel",
    whoMayTrigger: ["user", "engine_only"], preconditions: ["cancellation_requested"],
    requiredEvidence: ["user request or pre-approved cancellation rule", "child termination and external-effect reconciliation"],
    sideEffects: ["stop dispatch and children", "invalidate outstanding action approvals; retain worktrees and user changes", "record partial result, never success"],
  },
] as const satisfies readonly Transition<TaskStatus>[];

export const PHASE_TRANSITIONS = [
  {
    id: "phase-start", from: ["pending"], to: "running", trigger: "run",
    whoMayTrigger: ["user", "engine_only"], preconditions: ["phase_start_valid", "authorization_current"],
    requiredEvidence: ["approved plan/run request or approved run-all continuation", "cost estimate and budget/preceding-gate results"],
    sideEffects: ["reserve phase budget", "enable ready-task scheduling"],
  },
  {
    id: "phase-gate", from: ["running"], to: "gating", trigger: "tasks_completed",
    whoMayTrigger: ["engine_only"], preconditions: ["all_tasks_done", "authorization_current"],
    requiredEvidence: ["current task gate receipts", "sole integration owner and merged revision"],
    sideEffects: ["integrate under sole owner then verify merged result then review", "persist integrating/verifying/review substage; no done shortcut"],
  },
  {
    id: "phase-done", from: ["gating"], to: "done", trigger: "phase_gate_passed",
    whoMayTrigger: ["engine_only"], preconditions: PHASE_DONE_PRECONDITIONS,
    requiredEvidence: ["task gate receipts", "integrated check evidence at exact merged SHA", "phase coverage/no-gap or disabled fallback", "phase policy review and approvals"],
    sideEffects: ["persist passed and report: built scope, evidence, open questions, cost", "permit next phase only through phase-start"],
  },
  {
    id: "phase-failed", from: ["running", "gating"], to: "failed", trigger: "phase_failure",
    whoMayTrigger: ["engine_only"], preconditions: ["failure_observed"],
    requiredEvidence: ["failed integrated check, execution or integration outcome", "recovery options"],
    sideEffects: ["stop phase dispatch; retain task completions and artifacts", "do not advance next phase"],
  },
  {
    id: "phase-gap", from: ["gating"], to: "failed", trigger: "phase_gap_or_review_changes",
    whoMayTrigger: ["engine_only"], preconditions: ["changes_required"],
    requiredEvidence: ["phase gap or review findings"],
    sideEffects: ["retain failed phase gate", "propose explicitly scoped remediation; never reopen terminal tasks"],
  },
  {
    id: "phase-recover", from: ["failed"], to: "pending", trigger: "recovery_approved",
    whoMayTrigger: ["user", "engine_only"], preconditions: ["recovery_authorized", "authorization_current"],
    requiredEvidence: ["bounded recovery plan and reconciled effects"],
    sideEffects: ["replan with explicit scope approval when needed; invalidate revised approvals", "require phase-start and complete gate again"],
  },
  {
    id: "phase-cap", from: ["running", "gating"], to: "paused", trigger: "all_candidates_capped",
    whoMayTrigger: ["engine_only"], preconditions: ["all_eligible_models_capped"],
    requiredEvidence: ["blocking task/reviewer eligible set and availability/reset records", "saved phase substage and handoffs"],
    sideEffects: ["persist paused_cap with reason all_candidates_capped", "pause blocked task via task-cap; quiesce other workers with recoverable artifacts", "notify, stop dispatch, do not record failure"],
  },
  {
    id: "phase-cap-resume", from: ["paused"], to: "running", trigger: "eligible_cap_cleared",
    whoMayTrigger: ["engine_only"], preconditions: ["cap_resume_valid", "authorization_current", "recovery_authorized"],
    requiredEvidence: ["pause reason all_candidates_capped", "updated availability and full resume validation", "saved substage and reconciled workers"],
    sideEffects: ["restore scheduling and explicit handoffs", "if tasks already done, re-enter gating through phase-gate; never jump to done"],
  },
  {
    id: "phase-pause", from: PHASE_NONTERMINAL_STATES, to: "paused", trigger: "phase_stop",
    whoMayTrigger: ["engine_only", "user"], preconditions: ["phase_stop_present"],
    requiredEvidence: ["pause reason, stop policy or user request", "saved stage, budget usage and resumable workers"],
    sideEffects: ["stop dispatch and quiesce children; retain artifacts", "persist paused_cap for budget/cap and paused_approval otherwise", "surface reason and next action; budget never auto-increases"],
  },
  {
    id: "phase-invalidate", from: PHASE_NONTERMINAL_STATES, to: "paused", trigger: "approval_invalidated",
    whoMayTrigger: ["engine_only"], preconditions: ["invalidation_applies", "stop_phase_required"],
    requiredEvidence: ["invalidation event and affected approvals", "stop-phase disposition"],
    sideEffects: ["persist paused_approval and stop phase dispatch/affected children", "retain all unresolved pause reasons; no cap-clear bypass"],
  },
  {
    id: "phase-resume", from: ["paused"], to: "pending", trigger: "user_resume",
    whoMayTrigger: ["user"], preconditions: ["manual_resume_valid", "authorization_current"],
    requiredEvidence: ["explicit resume and fresh approvals when required", "resolved pause reasons and reconciliation"],
    sideEffects: ["require phase-start again", "preserve prior completed work; do not repeat completed actions"],
  },
  {
    id: "phase-stale-evidence", from: ["gating"], to: "gating", trigger: "git_revision_changed",
    whoMayTrigger: ["engine_only"], preconditions: ["revision_changed"],
    requiredEvidence: ["old/new merged SHA and affected gate evidence"],
    sideEffects: ["return storage substage to verifying", "exclude stale integrated checks and reviews; rerun full phase gate"],
  },
  {
    id: "phase-cancel", from: PHASE_NONTERMINAL_STATES, to: "cancelled", trigger: "cancel",
    whoMayTrigger: ["user", "engine_only"], preconditions: ["cancellation_requested"],
    requiredEvidence: ["explicit request or approved cancellation rule", "child termination and effect reconciliation"],
    sideEffects: ["cancel nonterminal tasks via task-cancel; preserve done tasks", "invalidate action approvals, retain worktrees, publish partial report", "never advance next phase as success"],
  },
] as const satisfies readonly Transition<PhaseState>[];

export interface ApprovalInvalidationEvent {
  readonly event: ApprovalInvalidation["reason"];
  readonly appliesTo: string;
  readonly taskEffect: "blocked" | "unchanged_unless_action_repeated";
  readonly phaseEffect: "paused" | "by_approval_class" | "unchanged_unless_action_repeated";
  readonly evidenceEffect: string;
}
export const APPROVAL_INVALIDATION_EVENTS = [
  { event: "task_revision_changed", appliesTo: "Approvals for changed task plus containing phase/plan approvals whose approved content includes it.", taskEffect: "blocked", phaseEffect: "paused", evidenceEffect: "Exclude old task-revision evidence, decisions and review; preserve originals." },
  { event: "plan_revision_changed", appliesTo: "All workflow approvals pinned to the previous planRevision; includes scope changes, cancellation edits and reprioritisation.", taskEffect: "blocked", phaseEffect: "paused", evidenceEffect: "Reassess coverage and approvals against revised plan; reuse no stale gate decision." },
  { event: "expired", appliesTo: "Every approval with expiresAt <= now, checked before use and on timer/reconciliation.", taskEffect: "blocked", phaseEffect: "by_approval_class", evidenceEffect: "Keep check evidence if still exact/current; require fresh approval and gate evaluation." },
  { event: "mode_changed", appliesTo: "All approvals in the workflow on an actual Workflow.mode change, even to a stricter mode.", taskEffect: "blocked", phaseEffect: "by_approval_class", evidenceEffect: "Re-evaluate policy review in the new mode; no prior mode authorization reused." },
  { event: "policy_version_changed", appliesTo: "All workflow approvals when Workflow.policyVersion changes.", taskEffect: "blocked", phaseEffect: "by_approval_class", evidenceEffect: "Re-evaluate reviews and permissions under the new user-approved policy; no self-weakening." },
  { event: "revoked", appliesTo: "Approvals explicitly withdrawn by the user/authorized policy actor.", taskEffect: "blocked", phaseEffect: "by_approval_class", evidenceEffect: "Retain evidence; revoked permission cannot authorize a later action." },
  { event: "session_reconciled", appliesTo: "Approvals found stale on fork/resume against live repository/plan/effect state.", taskEffect: "blocked", phaseEffect: "paused", evidenceEffect: "Exclude stale evidence and reconcile abandoned attempts; never replay completed effects." },
  { event: "consumed", appliesTo: "Single-use approval whose authorized action completed and is recorded.", taskEffect: "unchanged_unless_action_repeated", phaseEffect: "unchanged_unless_action_repeated", evidenceEffect: "Keep completion receipt; repeated action requires new approval and blocks/pauses by class." },
] as const satisfies readonly ApprovalInvalidationEvent[];

export const INVALIDATION_STATE_EFFECTS = {
  task: { affectedNonterminal: "task-invalidate", alreadyBlocked: "blocked", terminal: "unchanged" },
  phase: { forcedStop: "phase-invalidate", queue_and_continue: "unchanged", stop_phase: "phase-invalidate", terminal: "unchanged" },
  approval: "Set invalidation null -> reason/at/detail atomically with source change; never clear it. A new approval is a new row.",
  precedence: "Cancellation stops dispatch first; invalidation and unresolved pause reasons win over cap resume/readiness. Replan plus invalidation finishes blocked/paused, never runnable.",
} as const;

export const ILLEGAL_TRANSITION_POLICY = {
  disposition: "reject_and_audit",
  rejects: ["unknown state/trigger", "unlisted edge", "unauthorized actor", "false, missing or unknown precondition", "missing/stale evidence", "direct status patch", "terminal-state mutation", "stale concurrent snapshot"],
  stateEffect: "No task/phase/approval/attempt mutation or external action; no automatic coercion to another edge.",
  audit: ["subject kind/id", "from/requested to/trigger", "requesting actor and engine identity", "timestamp", "task/plan/Git revisions and mode/policy", "failed guard ids and sanitized evidence refs", "unchanged before/after hash", "reason code"],
  persistence: "Append-only rejection event in the same single-writer boundary; if audit cannot persist, fail closed and surface storage failure. Audit event schema is for the store issue, not a fake row update.",
} as const;

export const TRANSITION_COMMIT_POLICY = {
  writer: "engine_only",
  initialStates: { task: "proposed", phase: "pending" },
  mandatory: ["Authenticate request origin; user/worker trigger permissions never grant direct writes.", "Validate every conjunctive guard and evidence reference against one current snapshot.", "Recheck revisions and approvals atomically under single-writer ownership; reject stale snapshots.", "Record transition/gate receipt and side effects; dispatch external work only after durable authorization.", "No user, worker, Jev, UI, tool, import, recovery or raw status-patch path may create/set done or passed.", "Terminal states have no outgoing transitions; subsequent work needs explicitly approved new work, not a reopened completion."],
} as const;
