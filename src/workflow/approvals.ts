/**
 * Human-approval gates for high-risk classes (issue #49; PLAN §2.4 condition
 * 3, §2.6, §7; `docs/gates.md` §2 "valid approval"; `docs/approvals.md`).
 *
 * This module owns the request → record → expiry → invalidation lifecycle of
 * an approval, and nothing else. What it deliberately does *not* own:
 *
 * - **Whether an act needs approval.** That is `resolveDisposition` in
 *   `approval-classes.ts` (#15), whose high-risk tier is fixed in code and
 *   rejected by config validation (V10) if a config tries to lower it.
 * - **Whether a task may complete.** That is `evaluateTaskGate` (#46), which
 *   reads `Approval` rows and never this module's request queue.
 *
 * The four properties that make this safe, each structural rather than
 * conventional:
 *
 * 1. **An approval is a record, never an inference.** `grantApproval` is the
 *    only function here that writes an `Approval`, it demands a `user` actor
 *    for a high-risk class, and its input is a pending request row — not text,
 *    not a Jev probability, not a worker's claim. #44 proved injected text
 *    cannot approve anything; there is no parameter here through which text
 *    could try.
 * 2. **Single use.** A request leaves `pending` exactly once (SQL trigger),
 *    and `consumeApproval` moves the granted `Approval` to
 *    `invalidation.reason = "consumed"` when its act completes, so the same
 *    grant cannot authorise a second act.
 * 3. **Revision pinned.** Every request and every approval carries
 *    `(taskRevision, planRevision, mode, policyVersion)`. `approvalInvalidReason`
 *    (#12) rejects an approval whose revisions moved, and
 *    `invalidatePendingRequests` marks the *questions* stale on the same
 *    events, so an answer to a stale question can never become a fresh grant.
 * 4. **Non-interactive never blocks.** `requestApproval` writes a row and
 *    returns; asking a human is a separate, optional step
 *    (`src/extension/ui/approval-prompt.ts`), which returns `queued`
 *    immediately when there is no UI.
 */
import type { Store } from "../storage/db.ts";
import {
  requestKeyFor,
  type ApprovalRequest,
  type ApprovalRequestScope,
  type ApprovalRequestStatus,
} from "../storage/approval-requests.ts";
import {
  approvalInvalidReason,
  type Approval,
  type ApprovalId,
  type ApprovalScope,
  type IsoTimestamp,
  type Revision,
  type RiskClass,
  type TaskId,
  type WorkflowId,
} from "../storage/records.ts";
import { RECORDS_SCHEMA_VERSION } from "../storage/records.ts";
import type { WorkflowMode } from "../config/types.ts";
import {
  APPROVAL_CLASS_TABLE,
  DEFAULT_APPROVAL_CLASSES,
  resolveDisposition,
  type ApprovalClassId,
  type ApprovalClassTable,
  type ApprovalDecision,
  type ClassTier,
  type Disposition,
  type JevEscalation,
} from "./approval-classes.ts";

export type { ApprovalRequest, ApprovalRequestStatus };

/** Look up the immutable class definition, or throw for an unknown id. */
export function approvalClassDefinition(classId: ApprovalClassId): (typeof APPROVAL_CLASS_TABLE)[number] {
  const def = APPROVAL_CLASS_TABLE.find((c) => c.id === classId);
  if (def === undefined) throw new Error(`unknown approval class ${String(classId)}`);
  return def;
}

/** Tier of a class, straight from the code table. Config cannot change it. */
export function tierOf(classId: ApprovalClassId): ClassTier {
  return approvalClassDefinition(classId).tier;
}

/** `true` for the seven PLAN §7 classes that are `stop` in every mode. */
export function isHighRiskClass(classId: ApprovalClassId): boolean {
  return tierOf(classId) === "high_risk";
}

/**
 * Does this act need a human being to say yes?
 *
 * High-risk always. Otherwise only when the resolved disposition is not
 * `auto`: `queue` and `stop` both mean "a person decides", they differ in what
 * the rest of the workflow does meanwhile (PLAN §2.6).
 */
export function requiresHumanApproval(
  classId: ApprovalClassId,
  mode: WorkflowMode,
  table: ApprovalClassTable = DEFAULT_APPROVAL_CLASSES,
  jev: JevEscalation | null = null,
): boolean {
  if (isHighRiskClass(classId)) return true;
  return resolveDisposition(classId, mode, table, jev).decision !== "auto";
}

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

/** Everything `requestApproval` needs. All of it is computed by code. */
export interface RequestApprovalOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly classId: ApprovalClassId;
  readonly scope: ApprovalRequestScope;
  /**
   * The specific act, namespaced so one grant cannot be replayed for another
   * act of the same class (`publish:v1.2.0`, `verify_check:chk-migrate`).
   */
  readonly permittedAction: string;
  /** One redacted line for the prompt and the notification payload. */
  readonly summary: string;
  /** `Task.revision` when the scope is a task; `null` otherwise. */
  readonly taskRevision?: Revision | null;
  readonly now: IsoTimestamp;
  readonly newId: () => string;
  /** Wall-clock lifetime of the question. `null` = no expiry. */
  readonly ttlMs?: number | null;
  /** Jev may only *escalate* the disposition (#15); never de-escalate. */
  readonly jev?: JevEscalation | null;
  /** Effective `approvals.classes`; defaults to the shipped table. */
  readonly table?: ApprovalClassTable;
}

/** Outcome of asking for authorisation. */
export interface RequestApprovalResult {
  /**
   * `auto` — the class is pre-approved for this mode, so no question exists
   * and no row is written (high-risk can never reach this branch).
   * `queued` — a pending request row now exists; other ready tasks continue.
   * `stop` — a pending request row exists and the phase must stop (PLAN §2.6).
   * `already_pending` — the identical question was already queued; the
   * existing row is returned rather than a duplicate written.
   */
  readonly outcome: "auto" | "queued" | "stop" | "already_pending";
  readonly disposition: Disposition;
  /** `null` only for `auto`. */
  readonly request: ApprovalRequest | null;
}

/**
 * Ask for authorisation for one classified act.
 *
 * Returns immediately in every mode: this function writes a row, it does not
 * wait for anybody. That is what makes an unattended run safe to leave alone
 * (issue #49 AC3, PLAN §2.6 "queue and continue"). Whether and how a human is
 * *shown* the question is `src/extension/ui/approval-prompt.ts`'s problem.
 *
 * The disposition comes from #15 and the high-risk tier is read from the code
 * table, so a config that tried to set `destructive_git: auto` — which
 * validation rule V10 already rejects — would still land in `stop` here.
 */
export function requestApproval(options: RequestApprovalOptions): RequestApprovalResult {
  const { store, workflowId } = options;
  const workflow = store.workflows.require(workflowId);
  const mode = workflow.mode;
  const table = options.table ?? DEFAULT_APPROVAL_CLASSES;
  const disposition = resolveDisposition(options.classId, mode, table, options.jev ?? null);
  const def = approvalClassDefinition(options.classId);

  if (disposition.decision === "auto") {
    return { outcome: "auto", disposition, request: null };
  }
  const decision: Exclude<ApprovalDecision, "auto"> = disposition.decision;

  const taskRevision = options.taskRevision ?? null;
  const requestKey = requestKeyFor({
    classId: options.classId,
    scope: options.scope,
    permittedAction: options.permittedAction,
    taskRevision,
    planRevision: workflow.planRevision,
    policyVersion: workflow.policyVersion,
    mode,
  });

  return store.write(() => {
    const existing = store.approvalRequests.findPendingByKey(workflowId, requestKey);
    if (existing !== undefined) {
      return { outcome: "already_pending" as const, disposition, request: existing };
    }
    const ttl = options.ttlMs ?? null;
    const request = store.approvalRequests.insert({
      requestId: options.newId(),
      createdAt: options.now,
      workflowId,
      classId: options.classId,
      tier: def.tier,
      decision,
      mode,
      policyVersion: workflow.policyVersion,
      scope: options.scope,
      taskRevision,
      planRevision: workflow.planRevision,
      permittedAction: options.permittedAction,
      riskClass: def.risk,
      requestKey,
      summary: options.summary,
      expiresAt: ttl === null ? null : (new Date(Date.parse(options.now) + ttl).toISOString() as IsoTimestamp),
      status: "pending",
      resolvedAt: null,
      resolvedBy: null,
      approvalId: null,
      invalidationReason: null,
      detail: null,
    });
    return {
      outcome: decision === "stop" ? ("stop" as const) : ("queued" as const),
      disposition,
      request,
    };
  });
}

// ---------------------------------------------------------------------------
// Granting and denying
// ---------------------------------------------------------------------------

/** Who answered. Only a `user` can satisfy a high-risk class (PLAN §7). */
export interface ApprovalActor {
  readonly kind: "user" | "policy";
  readonly identity: string;
}

/** Why a grant was refused. Closed set; every refusal is a machine-readable fact. */
export const APPROVAL_GRANT_REFUSALS = [
  "request_not_found",
  "request_not_pending",
  "request_expired",
  "actor_not_user",
  "task_revision_changed",
  "plan_revision_changed",
  "mode_changed",
  "policy_version_changed",
  "scope_task_missing",
] as const;

export type ApprovalGrantRefusal = (typeof APPROVAL_GRANT_REFUSALS)[number];

/** Result of answering a pending request. */
export type GrantApprovalResult =
  | { readonly granted: true; readonly approval: Approval; readonly request: ApprovalRequest }
  | { readonly granted: false; readonly reason: ApprovalGrantRefusal; readonly detail: string };

export interface GrantApprovalOptions {
  readonly store: Store;
  readonly requestId: string;
  /** The human (or authorised policy actor) who said yes. */
  readonly actor: ApprovalActor;
  readonly now: IsoTimestamp;
  readonly newId: () => string;
  /** Lifetime of the resulting `Approval`; `null` = until something invalidates it. */
  readonly ttlMs?: number | null;
  readonly detail?: string;
}

/**
 * Turn an answered request into an `Approval` record.
 *
 * Everything the record says is copied from the *request row* and the live
 * workflow/task, never from the caller: the caller supplies only who they are.
 * So there is no argument through which a worker, a tool result or injected
 * repository text could widen the scope, raise the risk class, or point the
 * approval at a different task.
 *
 * Before writing, the world is re-checked against the question as asked. A
 * request written at task revision 3 cannot be granted at revision 4 (issue
 * #49 AC2) even if nothing has run `invalidatePendingRequests` yet — the check
 * is here as well as in the sweeper because a stale answer must be refused on
 * the only path that can act on it.
 */
export function grantApproval(options: GrantApprovalOptions): GrantApprovalResult {
  const { store } = options;
  return store.write(() => {
    const request = store.approvalRequests.find(options.requestId);
    if (request === undefined) {
      return { granted: false as const, reason: "request_not_found" as const, detail: `no request ${options.requestId}` };
    }
    if (request.status !== "pending") {
      return {
        granted: false as const,
        reason: "request_not_pending" as const,
        detail: `request ${request.requestId} is already ${request.status}`,
      };
    }
    const staleness = requestStaleness(store, request, options.now);
    if (staleness !== null) {
      // The question is no longer the question that was asked. Record that
      // rather than answering it, so the row explains itself afterwards.
      store.approvalRequests.resolve(request.requestId, options.now, {
        status: "invalidated",
        reason: staleness,
        resolvedBy: `${options.actor.kind}:${options.actor.identity}`,
        detail: `refused at grant time: ${staleness}`,
      });
      return {
        granted: false as const,
        reason: staleness,
        detail: `request ${request.requestId} was asked under different conditions (${staleness})`,
      };
    }
    // PLAN §7 and docs/gates.md B8: a policy actor can never satisfy a
    // high-risk class. This is the one place a grant is minted, so the check
    // here is the whole enforcement.
    if (request.tier === "high_risk" && options.actor.kind !== "user") {
      return {
        granted: false as const,
        reason: "actor_not_user" as const,
        detail: `${request.classId} is high risk (PLAN §7): only a user may approve it, not ${options.actor.kind}`,
      };
    }

    const ttl = options.ttlMs ?? null;
    const approval = store.approvals.insert({
      id: options.newId() as ApprovalId,
      createdAt: options.now,
      updatedAt: options.now,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      kind: "mutable",
      workflowId: request.workflowId,
      actor: options.actor,
      scope: request.scope as ApprovalScope,
      taskRevision: request.taskRevision,
      planRevision: request.planRevision,
      permittedAction: request.permittedAction,
      riskClass: request.riskClass,
      expiresAt: ttl === null ? null : (new Date(Date.parse(options.now) + ttl).toISOString() as IsoTimestamp),
      invalidation: null,
    });
    store.approvalRequests.resolve(request.requestId, options.now, {
      status: "granted",
      approvalId: approval.id,
      resolvedBy: `${options.actor.kind}:${options.actor.identity}`,
      detail: options.detail,
    });
    const resolved = store.approvalRequests.find(request.requestId) ?? request;
    return { granted: true as const, approval, request: resolved };
  });
}

/**
 * Is this pending request still a question about the current world?
 *
 * Returns the invalidation reason, or `null` when the request is still live.
 * The reasons are spelled exactly as `ApprovalInvalidation["reason"]` spells
 * them (`records.ts`), so a request and the approval it would produce die of
 * the same named causes rather than two parallel vocabularies.
 */
export function requestStaleness(
  store: Store,
  request: ApprovalRequest,
  now: IsoTimestamp,
): ApprovalGrantRefusal | null {
  if (request.expiresAt !== null && request.expiresAt <= now) return "request_expired";
  const workflow = store.workflows.get(request.workflowId);
  if (workflow === undefined) return "plan_revision_changed";
  if (workflow.planRevision !== request.planRevision) return "plan_revision_changed";
  if (workflow.mode !== request.mode) return "mode_changed";
  if (workflow.policyVersion !== request.policyVersion) return "policy_version_changed";
  if (request.scope.kind === "task") {
    const task = store.tasks.get(request.scope.taskId);
    if (task === undefined) return "scope_task_missing";
    if (task.revision !== request.taskRevision) return "task_revision_changed";
  }
  return null;
}

/** Record a refusal. A denied request is answered and never re-asked. */
export function denyApproval(options: {
  readonly store: Store;
  readonly requestId: string;
  readonly actor: ApprovalActor;
  readonly now: IsoTimestamp;
  readonly detail?: string;
}): ApprovalRequest | null {
  const { store } = options;
  return store.write(() => {
    const ok = store.approvalRequests.resolve(options.requestId, options.now, {
      status: "denied",
      resolvedBy: `${options.actor.kind}:${options.actor.identity}`,
      detail: options.detail,
    });
    return ok ? (store.approvalRequests.find(options.requestId) ?? null) : null;
  });
}

// ---------------------------------------------------------------------------
// Invalidation and consumption
// ---------------------------------------------------------------------------

/**
 * Mark every pending request of a workflow that the world has outrun.
 *
 * Run this after a revision bump, a mode change, a policy-version change or on
 * resume — the same events `applyInvalidation` (#41) applies to granted
 * approvals. Requests and approvals are swept by two functions because they
 * are two different objects: one is a question, one is an authorisation, and
 * conflating them is exactly how a stale question becomes a fresh grant.
 */
export function invalidatePendingRequests(options: {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly now: IsoTimestamp;
  readonly actor?: ApprovalActor;
}): readonly ApprovalRequest[] {
  const { store } = options;
  const by = options.actor === undefined ? "engine:korwf" : `${options.actor.kind}:${options.actor.identity}`;
  return store.write(() => {
    const out: ApprovalRequest[] = [];
    for (const request of store.approvalRequests.pendingForWorkflow(options.workflowId)) {
      const reason = requestStaleness(store, request, options.now);
      if (reason === null) continue;
      store.approvalRequests.resolve(request.requestId, options.now, {
        status: "invalidated",
        reason,
        resolvedBy: by,
        detail: `swept: ${reason}`,
      });
      const resolved = store.approvalRequests.find(request.requestId);
      if (resolved !== undefined) out.push(resolved);
    }
    return out;
  });
}

/**
 * Mark a granted approval used, once its act is recorded as completed.
 *
 * `consumed` is an enumerated invalidation event (#13/#41) whose state effect
 * is "unchanged unless the action is repeated": the completed act stands, and
 * a repeat needs a new approval. The repository refuses a second invalidation,
 * so double-consumption is a storage error rather than a silent no-op.
 */
export function consumeApproval(options: {
  readonly store: Store;
  readonly approvalId: ApprovalId;
  readonly now: IsoTimestamp;
  readonly detail?: string;
}): Approval {
  const { store } = options;
  return store.write(() =>
    store.approvals.invalidate(options.approvalId, {
      reason: "consumed",
      at: options.now,
      detail: options.detail ?? "the approved action completed and was recorded",
    }),
  );
}

/**
 * Revoke a granted approval, and invalidate any pending question it answers.
 * A withdrawn permission cannot authorise a later action (#13 contract row).
 */
export function revokeApproval(options: {
  readonly store: Store;
  readonly approvalId: ApprovalId;
  readonly now: IsoTimestamp;
  readonly detail?: string;
}): Approval {
  const { store } = options;
  return store.write(() =>
    store.approvals.invalidate(options.approvalId, {
      reason: "revoked",
      at: options.now,
      detail: options.detail ?? "withdrawn by the user",
    }),
  );
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

/** One row of the approval queue, as the board and the prompt render it. */
export interface ApprovalQueueRow {
  readonly request: ApprovalRequest;
  /** `true` when the class is one of the seven PLAN §7 classes. */
  readonly highRisk: boolean;
  /** `true` when the phase must stop rather than continue (PLAN §2.6). */
  readonly stopsPhase: boolean;
  /** Non-null when this question no longer matches the world. */
  readonly staleReason: ApprovalGrantRefusal | null;
}

/** The pending queue of a workflow, oldest first, with staleness computed. */
export function approvalQueue(store: Store, workflowId: WorkflowId, now: IsoTimestamp): readonly ApprovalQueueRow[] {
  return store.approvalRequests.pendingForWorkflow(workflowId).map((request) => ({
    request,
    highRisk: request.tier === "high_risk",
    stopsPhase: request.decision === "stop",
    staleReason: requestStaleness(store, request, now),
  }));
}

/**
 * The valid approvals covering one act at the current revisions.
 *
 * This is a *read* over recorded rows with no side effects and no way to pass
 * a claim in. The task gate keeps its own equivalent view (#46 `C3`); this one
 * exists for callers about to perform a non-completion act, e.g. a publish
 * step asking "may I".
 */
export function validApprovalsFor(options: {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly permittedAction: string;
  readonly taskId?: TaskId;
  readonly now: IsoTimestamp;
  /** Refuse anything granted by a non-user actor (every high-risk class). */
  readonly requireUserActor?: boolean;
}): readonly Approval[] {
  const { store } = options;
  const workflow = store.workflows.require(options.workflowId);
  const task = options.taskId === undefined ? null : (store.tasks.get(options.taskId) ?? null);
  return store.approvals
    .findBy("workflowId", options.workflowId)
    .filter((a) => a.permittedAction === options.permittedAction)
    .filter((a) => (options.taskId === undefined ? true : a.scope.kind === "task" && a.scope.taskId === options.taskId))
    .filter((a) => options.requireUserActor !== true || a.actor.kind === "user")
    .filter(
      (a) =>
        approvalInvalidReason(a, {
          task: task === null ? null : { id: task.id, revision: task.revision },
          planRevision: workflow.planRevision,
          now: options.now,
        }) === null,
    );
}

/**
 * May this act proceed right now?
 *
 * `true` only when a valid, user-granted approval record covers it. There is
 * no `force`, no `assumeApproved`, and no text or score input: an approval is
 * a record or it does not exist.
 */
export function isActionApproved(options: Parameters<typeof validApprovalsFor>[0]): boolean {
  return validApprovalsFor({ ...options, requireUserActor: true }).length > 0;
}
