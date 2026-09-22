/**
 * Storage for pending human-approval requests (issue #49; migration
 * `0009-approval-requests.sql`; PLAN §2.4 (3), §2.6, §7).
 *
 * The single most important property of this file is what it is **not**: it is
 * not a source of authorisation. An `ApprovalRequest` is a question. The thing
 * that authorises an act is an `Approval` record in `src/storage/records.ts`,
 * created only when a real actor answers. The task gate (#46) reads
 * `store.approvals`; it never reads this table, so no amount of queued,
 * escalated or auto-dispositioned request state can move a gate.
 *
 * Like `transition-log.ts`, `action-log.ts` and `gate-receipts.ts` this is not
 * a PLAN §5 record type: a request has no revisioned identity and is never
 * rewritten. Its only mutation is the one-shot resolution, which the database
 * enforces with `approval_request_resolve_once`.
 */
import type { Database } from "./sqlite.ts";
import type { ApprovalId, IsoTimestamp, PhaseId, Revision, RiskClass, TaskId, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";

/** Lifecycle of one request. `pending` is the only non-terminal state. */
export type ApprovalRequestStatus = "pending" | "granted" | "denied" | "invalidated";

/** What the request is about; mirrors `ApprovalScope` in `records.ts`. */
export type ApprovalRequestScope =
  | { readonly kind: "task"; readonly taskId: TaskId }
  | { readonly kind: "phase"; readonly phaseId: PhaseId }
  | { readonly kind: "plan" }
  | { readonly kind: "workflow" };

/** One queued question. Immutable except for its resolution fields. */
export interface ApprovalRequest {
  readonly requestId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  /** Approval class id from `src/workflow/approval-classes.ts` (#15). */
  readonly classId: string;
  readonly tier: "configurable" | "no_auto" | "high_risk";
  /** `queue` or `stop`; an `auto` class is never a question. */
  readonly decision: "queue" | "stop";
  readonly mode: string;
  readonly policyVersion: string;
  readonly scope: ApprovalRequestScope;
  readonly taskRevision: Revision | null;
  readonly planRevision: Revision;
  readonly permittedAction: string;
  readonly riskClass: RiskClass;
  /** Stable identity of the question (see `requestKeyFor`). */
  readonly requestKey: string;
  /** One redacted line describing the act, for the prompt and notification. */
  readonly summary: string;
  readonly expiresAt: IsoTimestamp | null;
  readonly status: ApprovalRequestStatus;
  readonly resolvedAt: IsoTimestamp | null;
  /** `<actorKind>:<identity>` of whoever answered; `null` while pending. */
  readonly resolvedBy: string | null;
  /** The `Approval` row this request produced, when granted. */
  readonly approvalId: ApprovalId | null;
  /** Why it stopped being answerable, for `invalidated`. */
  readonly invalidationReason: string | null;
  readonly detail: string | null;
}

interface RawRow {
  payload: string;
  status: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  approvalId: string | null;
  invalidationReason: string | null;
  detail: string | null;
}

/**
 * Rebuild a request from its payload, with the resolution taken from the
 * columns. The payload is the question as asked and is never rewritten.
 */
function hydrate(row: RawRow): ApprovalRequest {
  const stored = JSON.parse(row.payload) as ApprovalRequest;
  return {
    ...stored,
    status: row.status as ApprovalRequestStatus,
    resolvedAt: row.resolvedAt as IsoTimestamp | null,
    resolvedBy: row.resolvedBy,
    approvalId: row.approvalId as ApprovalId | null,
    invalidationReason: row.invalidationReason,
    detail: row.detail,
  };
}

const SELECT =
  "SELECT payload, status, resolvedAt, resolvedBy, approvalId, invalidationReason, detail FROM approval_request";

/**
 * Stable identity of a question: the same act at the same revisions under the
 * same policy is the same question, and the partial unique index refuses a
 * second *pending* row for it. Two different acts of the same class (two
 * different tags to publish, say) differ in `permittedAction`, so they are two
 * questions — which is the point of `humanCheckAction`-style namespacing in
 * `src/verification/checks.ts`.
 */
export function requestKeyFor(args: {
  readonly classId: string;
  readonly scope: ApprovalRequestScope;
  readonly permittedAction: string;
  readonly taskRevision: Revision | null;
  readonly planRevision: Revision;
  readonly policyVersion: string;
  readonly mode: string;
}): string {
  const subject =
    args.scope.kind === "task" ? args.scope.taskId : args.scope.kind === "phase" ? args.scope.phaseId : args.scope.kind;
  return [
    args.classId,
    args.scope.kind,
    subject,
    args.permittedAction,
    String(args.taskRevision ?? "-"),
    String(args.planRevision),
    args.policyVersion,
    args.mode,
  ].join("|");
}

/** How a request was resolved. `granted` must carry the `Approval` it made. */
export type ApprovalRequestResolution =
  | {
      readonly status: "granted";
      readonly approvalId: ApprovalId;
      readonly resolvedBy: string;
      readonly detail?: string | undefined;
    }
  | { readonly status: "denied"; readonly resolvedBy: string; readonly detail?: string | undefined }
  | {
      readonly status: "invalidated";
      readonly reason: string;
      readonly resolvedBy: string;
      readonly detail?: string | undefined;
    };

/** Append-and-resolve-once store for the approval queue. */
export class ApprovalRequestStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Queue one question. Throws if an identical question is already pending
   * (the partial unique index), which is how a retry loop is prevented from
   * asking the user the same thing a hundred times.
   */
  insert(request: ApprovalRequest): ApprovalRequest {
    this.#db
      .prepare(
        "INSERT INTO approval_request (requestId, createdAt, workflowId, classId, tier, decision, mode, " +
          "policyVersion, scopeKind, scopeTaskId, scopePhaseId, taskRevision, planRevision, permittedAction, " +
          "riskClass, requestKey, summary, expiresAt, status, resolvedAt, resolvedBy, approvalId, " +
          "invalidationReason, detail, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        request.requestId,
        request.createdAt,
        request.workflowId,
        request.classId,
        request.tier,
        request.decision,
        request.mode,
        request.policyVersion,
        request.scope.kind,
        request.scope.kind === "task" ? request.scope.taskId : null,
        request.scope.kind === "phase" ? request.scope.phaseId : null,
        request.taskRevision,
        request.planRevision,
        request.permittedAction,
        request.riskClass,
        request.requestKey,
        request.summary,
        request.expiresAt,
        request.status,
        request.resolvedAt,
        request.resolvedBy,
        request.approvalId,
        request.invalidationReason,
        request.detail,
        canonicalJson(request),
      );
    return request;
  }

  find(requestId: string): ApprovalRequest | undefined {
    const row = this.#db.prepare(`${SELECT} WHERE requestId = ?`).get(requestId) as RawRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  }

  #query(where: string, params: readonly (string | number)[]): readonly ApprovalRequest[] {
    const rows = this.#db
      .prepare(`${SELECT} ${where} ORDER BY createdAt, rowid`)
      .all(...params) as unknown as RawRow[];
    return rows.map(hydrate);
  }

  /** Every request of a workflow, oldest first. */
  forWorkflow(workflowId: string): readonly ApprovalRequest[] {
    return this.#query("WHERE workflowId = ?", [workflowId]);
  }

  /** Unanswered questions of a workflow, oldest first. */
  pendingForWorkflow(workflowId: string): readonly ApprovalRequest[] {
    return this.#query("WHERE workflowId = ? AND status = 'pending'", [workflowId]);
  }

  /** Unanswered questions about one task. */
  pendingForTask(taskId: string): readonly ApprovalRequest[] {
    return this.#query("WHERE scopeTaskId = ? AND status = 'pending'", [taskId]);
  }

  /** The pending row for exactly this question, if one exists. */
  findPendingByKey(workflowId: string, requestKey: string): ApprovalRequest | undefined {
    return this.#query("WHERE workflowId = ? AND requestKey = ? AND status = 'pending'", [workflowId, requestKey])[0];
  }

  /**
   * Resolve a pending request. Returns `false` when there was nothing pending
   * to resolve — the caller must then refuse rather than proceed, exactly as
   * with `GateReceiptStore.consume`.
   */
  resolve(requestId: string, at: IsoTimestamp, resolution: ApprovalRequestResolution): boolean {
    const result = this.#db
      .prepare(
        "UPDATE approval_request SET status = ?, resolvedAt = ?, resolvedBy = ?, approvalId = ?, " +
          "invalidationReason = ?, detail = ? WHERE requestId = ? AND status = 'pending'",
      )
      .run(
        resolution.status,
        at,
        resolution.resolvedBy,
        resolution.status === "granted" ? resolution.approvalId : null,
        resolution.status === "invalidated" ? resolution.reason : null,
        resolution.detail ?? null,
        requestId,
      );
    return Number(result.changes) === 1;
  }
}
