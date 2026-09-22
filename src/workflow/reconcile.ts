/**
 * Session resume / reload / fork / tree reconciliation against **live**
 * repository state (issue #42; PLAN §5, §4 "session/tree/fork/resume/reload"
 * integration surfaces; docs/state-machine.md §5).
 *
 * The governing sentence, quoted from PLAN §5:
 *
 * > Pi conversation branching does not undo Git changes or external effects.
 * > Fork/resume reconciles live repository state and never resurrects
 * > obsolete approvals or replays completed actions.
 *
 * Three rules follow from it, and this module exists to make each of them
 * unavoidable rather than customary:
 *
 *  1. **Compare against the repository as it is now.** `Workflow.baseRevision`
 *     records what the plan was made against; the answer to "is that still
 *     true" is read from git at reconcile time through `src/git/` (ADR 0002),
 *     never from a cached field written when the session was saved.
 *
 *  2. **An invalidated approval stays invalidated.** Approvals are re-derived
 *     from the current plan/task revisions with the shared
 *     `approvalInvalidReason` helper, and `Approval.invalidation` only ever
 *     moves null → reason (enforced by the repository). So a fork of a
 *     conversation from *before* a revision bump still sees the invalidated
 *     row: the store is not part of the conversation and was not rewound.
 *
 *  3. **A completed action is never replayed.** Every effect carries an
 *     `actionId` derived from what it is, and the receipt lives in
 *     `store.actions`. `guardAction` refuses a repeat and records the refusal;
 *     it never "helpfully" re-runs anything, because the repository state that
 *     would make a re-run safe is exactly what we have just failed to assume.
 *
 * This module runs no git commands itself — `src/git/revision.ts` does — and
 * writes no status directly: every state change goes through `state.ts` /
 * `invalidation.ts`, so a reconciliation is audited exactly like any other
 * transition.
 */
import type { Store } from "../storage/db.ts";
import type { CompletedAction } from "../storage/action-log.ts";
import type { IsoTimestamp, Workflow, WorkflowId } from "../storage/records.ts";
import { approvalInvalidReason } from "../storage/records.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import type { GitRunner } from "../git/status.ts";
import { compareRevisions, readLiveRepoState, type LiveRepoState, type RevisionRelation } from "../git/revision.ts";
import { applyInvalidation, type InvalidationEffect } from "./invalidation.ts";

/**
 * Pi session lifecycle events this module reconciles for.
 *
 * `tree` covers `/tree` navigation, which rewinds the conversation to another
 * branch of the session without touching the repository — the purest form of
 * the hazard this module exists for.
 */
export const SESSION_EVENTS = ["startup", "reload", "new", "resume", "fork", "tree"] as const;
export type SessionEvent = (typeof SESSION_EVENTS)[number];

/**
 * Events that rewind or re-point the conversation, so the transcript may no
 * longer describe what the repository and the store contain.
 */
export const REWINDING_EVENTS: readonly SessionEvent[] = ["resume", "fork", "tree", "reload"];

/** Stable reason codes. `/korwf` output and the tests match on these, not on prose. */
export const RECONCILE_CODES = {
  /** The repository moved away from the revision the plan was made against. */
  revisionDrift: "revision_drift",
  /** The recorded base revision no longer exists in this repository. */
  revisionMissing: "revision_missing",
  /** Working tree has uncommitted changes the session did not make. */
  workingTreeDirty: "working_tree_dirty",
  /** The project is no longer a git repository, or git could not answer. */
  repoUnavailable: "repo_unavailable",
  /** The persisted workflow describes a different repository than this one. */
  repoIdentityMismatch: "repo_identity_mismatch",
  /** An approval is unusable under current revisions; it is not resurrected. */
  approvalStale: "approval_stale",
  /** An action with this id already completed; the repeat was refused. */
  actionAlreadyCompleted: "action_already_completed",
  /** The completed action's effect left this repository; never re-run. */
  externalEffectRecorded: "external_effect_recorded",
} as const;
export type ReconcileCode = (typeof RECONCILE_CODES)[keyof typeof RECONCILE_CODES];

/** Blocker kind raised on subjects held by reconciliation. */
export const RECONCILE_BLOCKER = "session_reconciled";

/** One thing reconciliation found. Ordered most severe first when rendered. */
export interface ReconcileFinding {
  readonly code: ReconcileCode;
  readonly detail: string;
  /** Subject ids this finding concerns; empty when workflow-wide. */
  readonly subjects: readonly string[];
}

/** Live repository facts, read fresh, plus how they relate to the stored plan. */
export interface RepoDrift {
  readonly live: LiveRepoState;
  /** `Workflow.baseRevision` as persisted. */
  readonly recordedRevision: string;
  readonly relation: RevisionRelation;
  readonly dirty: boolean;
  readonly changedPaths: readonly string[];
  /** `true` when the live repository is not the one the workflow was planned in. */
  readonly identityMismatch: boolean;
}

/** What one reconciliation concluded and did. */
export interface ReconcileReport {
  readonly at: IsoTimestamp;
  readonly event: SessionEvent;
  readonly workflowId: WorkflowId;
  readonly sessionId: string;
  readonly drift: RepoDrift;
  readonly findings: readonly ReconcileFinding[];
  /** Approvals invalidated by this reconciliation, with reason `session_reconciled`. */
  readonly invalidatedApprovals: readonly string[];
  /** Approvals that were *already* invalid and stay so; never resurrected. */
  readonly alreadyInvalidApprovals: readonly string[];
  /** Completed actions that must never be replayed in the resumed session. */
  readonly completedActions: readonly string[];
  readonly invalidation: InvalidationEffect | null;
}

export interface ReconcileOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly event: SessionEvent;
  /** Pi session id after the event (a fork has a new one). */
  readonly sessionId: string;
  /** Directory to read live git state from; normally `ctx.cwd`. */
  readonly cwd: string;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  readonly actor?: TransitionActor;
  /** Injected so tests need no real repository. */
  readonly gitRunner?: GitRunner;
  /**
   * Read-only: compute the report and write nothing. Used by the status line
   * on `startup`, where the store may be open read-only.
   */
  readonly dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Live repository state
// ---------------------------------------------------------------------------

/**
 * Compare the persisted workflow with what the repository looks like **now**.
 *
 * Pure read: it runs read-only git commands through `src/git/` and touches no
 * row. Everything downstream is derived from this, so "reconciles live
 * repository state" has exactly one implementation.
 */
export function computeDrift(
  workflow: Pick<Workflow, "baseRevision" | "repoIdentity">,
  cwd: string,
  runner?: GitRunner,
): RepoDrift {
  const live = runner === undefined ? readLiveRepoState(cwd) : readLiveRepoState(cwd, runner);
  if (live.kind === "no_repo") {
    return {
      live,
      recordedRevision: workflow.baseRevision,
      relation: "indeterminate",
      dirty: false,
      changedPaths: [],
      identityMismatch: false,
    };
  }

  const relation =
    runner === undefined
      ? compareRevisions(live.gitRoot, workflow.baseRevision, live.head)
      : compareRevisions(live.gitRoot, workflow.baseRevision, live.head, runner);

  return {
    live,
    recordedRevision: workflow.baseRevision,
    relation,
    dirty: live.dirty,
    changedPaths: live.changes.map((change) => change.path),
    identityMismatch: relation === "unknown_revision",
  };
}

/** Findings implied by the repository state alone, most severe first. */
export function driftFindings(drift: RepoDrift): readonly ReconcileFinding[] {
  const findings: ReconcileFinding[] = [];
  if (drift.live.kind === "no_repo") {
    findings.push({
      code: RECONCILE_CODES.repoUnavailable,
      detail:
        "the project directory is not a git repository right now; the recorded plan cannot be " +
        "related to any revision, so nothing is assumed to be current",
      subjects: [],
    });
    return findings;
  }

  switch (drift.relation) {
    case "same":
      break;
    case "unknown_revision":
      findings.push({
        code: RECONCILE_CODES.revisionMissing,
        detail:
          `the recorded base revision ${short(drift.recordedRevision)} does not exist in this ` +
          `repository (rewritten history, a different clone, or a deleted branch)`,
        subjects: [],
      });
      findings.push({
        code: RECONCILE_CODES.repoIdentityMismatch,
        detail: "this repository cannot be shown to contain the work the plan was made against",
        subjects: [],
      });
      break;
    case "indeterminate":
      findings.push({
        code: RECONCILE_CODES.repoUnavailable,
        detail: "git could not relate the recorded revision to HEAD; treated as drift, not as agreement",
        subjects: [],
      });
      break;
    default:
      findings.push({
        code: RECONCILE_CODES.revisionDrift,
        detail:
          `HEAD is ${short(drift.live.head)} and the plan was made against ` +
          `${short(drift.recordedRevision)} (${drift.relation})`,
        subjects: [],
      });
      break;
  }

  if (drift.dirty) {
    findings.push({
      code: RECONCILE_CODES.workingTreeDirty,
      detail: `${drift.changedPaths.length} uncommitted path(s) in the working tree: ${drift.changedPaths
        .slice(0, 5)
        .join(", ")}${drift.changedPaths.length > 5 ? ", …" : ""}`,
      subjects: [],
    });
  }
  return findings;
}

function short(revision: string | null): string {
  if (revision === null || revision.length === 0) return "(none)";
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

// ---------------------------------------------------------------------------
// Approvals: stale stays stale
// ---------------------------------------------------------------------------

/** One approval's standing at reconcile time. */
export interface ApprovalStanding {
  readonly approvalId: string;
  /** `null` when the approval is still usable. */
  readonly reason: string | null;
  /** `true` when it was already invalidated before this reconciliation. */
  readonly alreadyInvalid: boolean;
}

/**
 * Re-derive every approval's standing from the **current** plan and task
 * revisions.
 *
 * This is the mechanism behind "never resurrects obsolete approvals". A fork
 * restores the conversation, not the store; `Approval.invalidation` is on
 * disk, the repository refuses to clear it, and the ones not yet marked are
 * re-checked here against revisions read now. There is no code path — in this
 * module or anywhere else — that turns an invalid approval back into a valid
 * one; a new authorisation is a new row (docs/records.md §4).
 */
export function approvalStandings(
  store: Store,
  workflowId: WorkflowId,
  now: IsoTimestamp,
): readonly ApprovalStanding[] {
  const workflow = store.workflows.get(workflowId);
  if (workflow === undefined) return [];
  return store.approvals.findBy("workflowId", workflowId).map((approval) => {
    if (approval.invalidation !== null) {
      return { approvalId: approval.id, reason: approval.invalidation.reason, alreadyInvalid: true };
    }
    const task =
      approval.scope.kind === "task" ? (store.tasks.get(approval.scope.taskId) ?? null) : null;
    const reason = approvalInvalidReasonFor(approval, task, workflow.planRevision, now);
    return { approvalId: approval.id, reason, alreadyInvalid: false };
  });
}

/**
 * Thin wrapper over the shared record helper so the "current" snapshot is
 * built in exactly one place. Kept separate because the helper takes a task
 * or `null` and we resolve that from the scope.
 */
function approvalInvalidReasonFor(
  approval: Parameters<typeof approvalInvalidReason>[0],
  task: { readonly id: string; readonly revision: number } | null,
  planRevision: number,
  now: IsoTimestamp,
): string | null {
  return approvalInvalidReason(approval, {
    task: task as Parameters<typeof approvalInvalidReason>[1]["task"],
    planRevision,
    now,
  });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Thrown when reconciliation is asked about a workflow that is not in the store. */
export class UnknownWorkflowError extends Error {
  readonly workflowId: string;
  constructor(workflowId: string) {
    super(`no workflow ${workflowId} in this store; nothing to reconcile`);
    this.name = "UnknownWorkflowError";
    this.workflowId = workflowId;
  }
}

/**
 * Reconcile one workflow against live repository state for a session event.
 *
 * Order matters and is deliberate:
 *
 *  1. Read the repository (no writes, no assumptions).
 *  2. Re-derive approval standings from current revisions.
 *  3. If anything is stale — drift, a dirty tree at a moved revision, or an
 *     approval that no longer holds — apply the enumerated
 *     `session_reconciled` invalidation event, which blocks affected
 *     nonterminal tasks and pauses their phases in one transaction
 *     (`transitions.ts`: task `blocked`, phase `paused`).
 *  4. List the completed actions that must not be replayed.
 *
 * `dryRun` stops after step 2 and reports; it is what the status line uses on
 * a read-only handle.
 */
export function reconcileSession(options: ReconcileOptions): ReconcileReport {
  const { store, workflowId } = options;
  const workflow = store.workflows.get(workflowId);
  if (workflow === undefined) throw new UnknownWorkflowError(workflowId);

  const at = options.now();
  const drift = computeDrift(workflow, options.cwd, options.gitRunner);
  const findings: ReconcileFinding[] = [...driftFindings(drift)];

  const standings = approvalStandings(store, workflowId, at);
  const alreadyInvalid = standings.filter((s) => s.alreadyInvalid).map((s) => s.approvalId);
  const nowStale = standings.filter((s) => !s.alreadyInvalid && s.reason !== null);
  for (const stale of nowStale) {
    findings.push({
      code: RECONCILE_CODES.approvalStale,
      detail: `approval ${stale.approvalId} is unusable (${stale.reason ?? "unknown"}) at the current revisions`,
      subjects: [stale.approvalId],
    });
  }

  const completed = store.actions.forWorkflow(workflowId);
  for (const action of completed.filter((a) => a.externalEffect)) {
    findings.push({
      code: RECONCILE_CODES.externalEffectRecorded,
      detail:
        `"${action.summary}" (${action.kind}) already left this repository; it is never re-run by a ` +
        `resumed or forked session`,
      subjects: [action.actionId],
    });
  }

  const mustInvalidate = shouldInvalidate(options.event, drift, nowStale.length > 0);
  const invalidation =
    mustInvalidate && options.dryRun !== true
      ? applyInvalidation({
          store,
          workflowId,
          reason: "session_reconciled",
          detail: reconcileDetail(options.event, drift, findings),
          actor: options.actor ?? { kind: "engine", identity: "korwf:reconciler" },
          now: options.now,
          newId: options.newId,
        })
      : null;

  return {
    at,
    event: options.event,
    workflowId,
    sessionId: options.sessionId,
    drift,
    findings,
    invalidatedApprovals: invalidation?.invalidatedApprovals ?? [],
    alreadyInvalidApprovals: alreadyInvalid,
    completedActions: completed.map((action) => action.actionId),
    invalidation,
  };
}

/**
 * Does this event, against this repository state, require the
 * `session_reconciled` invalidation?
 *
 * `startup` and `new` are excluded: a fresh session that has not rewound
 * anything and finds the repository exactly where it left it has nothing to
 * reconcile, and invalidating approvals on every launch would be a denial of
 * service on the user's own authorisations. Everything else — any drift, any
 * already-stale approval, or an indeterminate answer from git — invalidates,
 * because the alternative is authorising an action against a repository we
 * cannot show is the one that was approved.
 */
export function shouldInvalidate(event: SessionEvent, drift: RepoDrift, hasStaleApproval: boolean): boolean {
  if (drift.live.kind === "no_repo") return true;
  if (drift.relation !== "same") return true;
  if (hasStaleApproval) return true;
  if (!REWINDING_EVENTS.includes(event)) return false;
  // A rewinding event at the exact recorded revision with a clean tree has
  // changed nothing about what was approved; the dirty tree is the hazard.
  return drift.dirty;
}

function reconcileDetail(
  event: SessionEvent,
  drift: RepoDrift,
  findings: readonly ReconcileFinding[],
): string {
  const head = drift.live.kind === "repo" ? short(drift.live.head) : "(no repository)";
  const codes = [...new Set(findings.map((f) => f.code))].join(", ");
  return (
    `session ${event}: HEAD ${head} vs recorded ${short(drift.recordedRevision)} ` +
    `(${drift.relation}${drift.dirty ? ", dirty" : ""})${codes === "" ? "" : `; ${codes}`}`
  );
}

// ---------------------------------------------------------------------------
// Idempotency: a completed action is never replayed
// ---------------------------------------------------------------------------

/** Verdict for a request to perform an action. */
export type ActionVerdict =
  | { readonly kind: "proceed"; readonly actionId: string }
  | {
      readonly kind: "refused";
      readonly actionId: string;
      readonly code: ReconcileCode;
      readonly notice: string;
      readonly completed: CompletedAction;
    };

export interface GuardActionOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly actionId: string;
  readonly sessionId: string;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

/**
 * Ask whether an action may run. **This is the only correct way to start an
 * effect that must happen at most once.**
 *
 * A recorded receipt means the effect already happened — in this session or
 * in the one this conversation was forked from — and the repository was not
 * rewound with the transcript. The answer is a refusal with a notice, never a
 * silent no-op and never a re-run: PLAN §5's "prefer refusing and reporting
 * over guessing". The refusal itself is recorded, so `/korwf why` can say why
 * a turn did nothing.
 */
export function guardAction(options: GuardActionOptions): ActionVerdict {
  const completed = options.store.actions.find(options.actionId);
  if (completed === undefined) return { kind: "proceed", actionId: options.actionId };

  const code = completed.externalEffect
    ? RECONCILE_CODES.externalEffectRecorded
    : RECONCILE_CODES.actionAlreadyCompleted;
  const notice = replayNotice(completed, options.sessionId);

  options.store.write(() => {
    options.store.actions.recordReplayAttempt({
      attemptRowId: options.newId(),
      createdAt: options.now(),
      actionId: options.actionId,
      workflowId: options.workflowId,
      sessionId: options.sessionId,
      reasonCode: code,
      detail: notice,
    });
  });

  return { kind: "refused", actionId: options.actionId, code, notice, completed };
}

/** The user-facing sentence for a refused replay. No credentials, no paths outside the repo. */
export function replayNotice(completed: CompletedAction, requestingSessionId: string): string {
  const where = completed.sessionId === requestingSessionId ? "this session" : `session ${completed.sessionId}`;
  const external = completed.externalEffect
    ? " Its effect left this repository, so it cannot be undone by rewinding the conversation."
    : "";
  return (
    `Refused: "${completed.summary}" (${completed.kind}) already completed in ${where} at ` +
    `${completed.recordedAt}${completed.gitRevision === null ? "" : ` on ${short(completed.gitRevision)}`}.` +
    `${external} Rewinding the conversation does not undo it; request a new, explicitly approved action ` +
    `if it genuinely needs to happen again.`
  );
}

/**
 * Record that an action completed. Call **after** the effect succeeded, in
 * the same transaction as whatever else the effect produced where possible.
 *
 * Throws if a receipt for this `actionId` already exists: reaching this point
 * twice means the guard was not consulted, and silently overwriting the first
 * receipt would hide a double effect.
 */
export function recordCompletedAction(options: {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly actionId: string;
  readonly kind: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly now: () => IsoTimestamp;
  readonly subjectKind?: CompletedAction["subjectKind"];
  readonly subjectId?: string | null;
  readonly gitRevision?: string | null;
  readonly approvalId?: string | null;
  readonly externalEffect?: boolean;
}): CompletedAction {
  const { store } = options;
  return store.write(() =>
    store.actions.record({
      actionId: options.actionId,
      recordedAt: options.now(),
      workflowId: options.workflowId,
      kind: options.kind,
      subjectKind: options.subjectKind ?? null,
      subjectId: options.subjectId ?? null,
      sessionId: options.sessionId,
      gitRevision: options.gitRevision ?? null,
      approvalId: options.approvalId ?? null,
      externalEffect: options.externalEffect ?? false,
      summary: options.summary,
    }),
  );
}

// ---------------------------------------------------------------------------
// Surfacing it
// ---------------------------------------------------------------------------

/** One line for the status widget: what the repository looks like versus the plan. */
export function statusLine(report: ReconcileReport): string {
  if (report.drift.live.kind === "no_repo") {
    return `KorWF: no git repository at this path — plan state cannot be reconciled (session ${report.event}).`;
  }
  const head = short(report.drift.live.head);
  const clean = report.drift.dirty ? `dirty (${report.drift.changedPaths.length} path(s))` : "clean";
  const approvals =
    report.invalidatedApprovals.length === 0
      ? report.alreadyInvalidApprovals.length === 0
        ? "approvals unchanged"
        : `${report.alreadyInvalidApprovals.length} approval(s) remain invalid`
      : `${report.invalidatedApprovals.length} approval(s) marked stale`;
  return (
    `KorWF ${report.event}: HEAD ${head} vs plan base ${short(report.drift.recordedRevision)} ` +
    `(${report.drift.relation}), working tree ${clean}; ${approvals}.`
  );
}

/** Full multi-line report for `/korwf status` and the session notice. */
export function describeReconciliation(report: ReconcileReport): string {
  const lines = [statusLine(report)];
  for (const finding of report.findings) {
    lines.push(`  ! ${finding.code}: ${finding.detail}`);
  }
  if (report.invalidation !== null) {
    const { blockedTasks, pausedPhases, excludedEvidence } = report.invalidation;
    lines.push(
      `  → session_reconciled applied: ${blockedTasks.length} task(s) blocked, ` +
        `${pausedPhases.length} phase(s) paused, ${excludedEvidence.length} evidence row(s) excluded ` +
        `from current gates (retained on disk).`,
    );
  }
  if (report.completedActions.length > 0) {
    lines.push(
      `  → ${report.completedActions.length} completed action(s) on record; re-running any of them is refused.`,
    );
  }
  if (report.findings.length === 0) {
    lines.push("  ✓ live repository state matches the plan base revision; nothing to reconcile.");
  }
  return lines.join("\n");
}

/**
 * Reconcile every workflow the store holds for this project.
 *
 * A store normally holds one, but a project may have several over its life
 * and a resumed session does not get to pick which one is "the" workflow. All
 * non-terminal ones are reconciled; completed and cancelled ones are left
 * alone, because their approvals are already spent and their actions already
 * recorded.
 */
export function reconcileAllWorkflows(
  options: Omit<ReconcileOptions, "workflowId">,
): readonly ReconcileReport[] {
  const active = options.store.workflows
    .list()
    .filter((workflow) => workflow.status !== "completed" && workflow.status !== "cancelled");
  return active.map((workflow) => reconcileSession({ ...options, workflowId: workflow.id }));
}
