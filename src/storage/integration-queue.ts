/**
 * Storage for the single-owner integration queue (issue #78; migration
 * `0013-integration.sql`; PLAN §3.E).
 *
 * The queue is durable because the thing it serialises is not in one
 * process: two workers can finish in two Pi sessions, and only a row in the
 * store is visible to both. `claimNext` takes the head of the FIFO inside
 * the store's write transaction with a `WHERE status = 'queued'` guard, so
 * two integrators racing for the same item produce exactly one winner and
 * the loser sees an empty queue rather than a second merge.
 *
 * Like `action-log.ts` and `checkpoints.ts`, these are not PLAN §5 records:
 * they carry no revisioned identity and are never rewritten beyond their
 * status transitions, which the database pins with triggers.
 */
import type { Database } from "./sqlite.ts";
import type { IsoTimestamp, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";

/** Lifecycle of one queued integration. */
export type IntegrationStatus =
  | "queued"
  | "integrating"
  | "integrated"
  | "conflicted"
  | "stale_base"
  | "failed"
  | "cancelled";

/** Statuses that still hold a place in the queue. */
export const ACTIVE_INTEGRATION_STATUSES = ["queued", "integrating"] as const;

/** One task's request to be integrated. Never an authorisation to merge. */
export interface IntegrationItemRow {
  readonly itemId: string;
  readonly enqueuedAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly phaseId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly branch: string;
  readonly baseRevision: string;
  readonly verifiedRevision: string;
  readonly status: IntegrationStatus;
  readonly detail: string | null;
}

/** Lifecycle of one recorded merge conflict. */
export type ConflictStatus = "open" | "resolved" | "unresolved";

/** One merge conflict, and the bounded resolution task it produced. */
export interface IntegrationConflictRow {
  readonly conflictId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly itemId: string;
  readonly taskId: string;
  readonly paths: readonly string[];
  readonly resolutionTaskId: string | null;
  readonly status: ConflictStatus;
  readonly resolvedAt: IsoTimestamp | null;
  readonly detail: string | null;
}

interface RawItem {
  payload: string;
  status: string;
  detail: string | null;
}

interface RawConflict {
  payload: string;
  status: string;
  resolutionTaskId: string | null;
  resolvedAt: string | null;
  detail: string | null;
}

function hydrateItem(row: RawItem): IntegrationItemRow {
  const stored = JSON.parse(row.payload) as IntegrationItemRow;
  return { ...stored, status: row.status as IntegrationStatus, detail: row.detail };
}

function hydrateConflict(row: RawConflict): IntegrationConflictRow {
  const stored = JSON.parse(row.payload) as IntegrationConflictRow;
  return {
    ...stored,
    status: row.status as ConflictStatus,
    resolutionTaskId: row.resolutionTaskId,
    resolvedAt: row.resolvedAt as IsoTimestamp | null,
    detail: row.detail,
  };
}

/** The durable integration queue and its conflict records. */
export class IntegrationQueueStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Append one request. Throws on the unique index when the task already has
   * a `queued`/`integrating` item — a task queues once, and a duplicate
   * enqueue is a bug worth hearing about rather than a silent second merge.
   */
  enqueue(row: IntegrationItemRow): IntegrationItemRow {
    this.#db
      .prepare(
        "INSERT INTO integration_item (itemId, enqueuedAt, workflowId, phaseId, taskId, taskRevision, branch, " +
          "baseRevision, verifiedRevision, status, detail, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.itemId,
        row.enqueuedAt,
        row.workflowId,
        row.phaseId,
        row.taskId,
        row.taskRevision,
        row.branch,
        row.baseRevision,
        row.verifiedRevision,
        row.status,
        row.detail,
        canonicalJson(row),
      );
    return row;
  }

  get(itemId: string): IntegrationItemRow | undefined {
    const row = this.#db
      .prepare("SELECT payload, status, detail FROM integration_item WHERE itemId = ?")
      .get(itemId) as RawItem | undefined;
    return row === undefined ? undefined : hydrateItem(row);
  }

  /** Every item for a phase, in FIFO order. */
  forPhase(phaseId: string): readonly IntegrationItemRow[] {
    const rows = this.#db
      .prepare("SELECT payload, status, detail FROM integration_item WHERE phaseId = ? ORDER BY enqueuedAt, rowid")
      .all(phaseId) as unknown as RawItem[];
    return rows.map(hydrateItem);
  }

  /** Items still waiting, in FIFO order. */
  pending(phaseId: string): readonly IntegrationItemRow[] {
    const rows = this.#db
      .prepare(
        "SELECT payload, status, detail FROM integration_item WHERE phaseId = ? AND status = 'queued' " +
          "ORDER BY enqueuedAt, rowid",
      )
      .all(phaseId) as unknown as RawItem[];
    return rows.map(hydrateItem);
  }

  /**
   * Take the head of the FIFO and mark it `integrating`, atomically.
   *
   * The `WHERE ... AND status = 'queued'` clause is the whole point: the
   * update and the selection commit together inside the caller's
   * `BEGIN IMMEDIATE` transaction, so a second integrator either sees the
   * item already `integrating` and skips it, or finds nothing queued.
   * Returns `undefined` when the queue is empty.
   */
  claimNext(phaseId: string, at: IsoTimestamp): IntegrationItemRow | undefined {
    const head = this.#db
      .prepare(
        "SELECT itemId FROM integration_item WHERE phaseId = ? AND status = 'queued' ORDER BY enqueuedAt, rowid LIMIT 1",
      )
      .get(phaseId) as { itemId: string } | undefined;
    if (head === undefined) return undefined;
    const changed = this.#db
      .prepare("UPDATE integration_item SET status = 'integrating', detail = ? WHERE itemId = ? AND status = 'queued'")
      .run(`claimed at ${at}`, head.itemId);
    if (Number(changed.changes) === 0) return undefined;
    return this.get(head.itemId);
  }

  /** Record how an integration ended. */
  settle(itemId: string, status: IntegrationStatus, detail: string | null): IntegrationItemRow | undefined {
    this.#db.prepare("UPDATE integration_item SET status = ?, detail = ? WHERE itemId = ?").run(status, detail, itemId);
    return this.get(itemId);
  }

  // -- conflicts ----------------------------------------------------------

  recordConflict(row: IntegrationConflictRow): IntegrationConflictRow {
    this.#db
      .prepare(
        "INSERT INTO integration_conflict (conflictId, createdAt, workflowId, itemId, taskId, paths, " +
          "resolutionTaskId, status, resolvedAt, detail, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.conflictId,
        row.createdAt,
        row.workflowId,
        row.itemId,
        row.taskId,
        canonicalJson(row.paths),
        row.resolutionTaskId,
        row.status,
        row.resolvedAt,
        row.detail,
        canonicalJson(row),
      );
    return row;
  }

  conflict(conflictId: string): IntegrationConflictRow | undefined {
    const row = this.#db
      .prepare(
        "SELECT payload, status, resolutionTaskId, resolvedAt, detail FROM integration_conflict WHERE conflictId = ?",
      )
      .get(conflictId) as RawConflict | undefined;
    return row === undefined ? undefined : hydrateConflict(row);
  }

  conflictsForItem(itemId: string): readonly IntegrationConflictRow[] {
    const rows = this.#db
      .prepare(
        "SELECT payload, status, resolutionTaskId, resolvedAt, detail FROM integration_conflict " +
          "WHERE itemId = ? ORDER BY createdAt, rowid",
      )
      .all(itemId) as unknown as RawConflict[];
    return rows.map(hydrateConflict);
  }

  openConflictsForWorkflow(workflowId: string): readonly IntegrationConflictRow[] {
    const rows = this.#db
      .prepare(
        "SELECT payload, status, resolutionTaskId, resolvedAt, detail FROM integration_conflict " +
          "WHERE workflowId = ? AND status = 'open' ORDER BY createdAt, rowid",
      )
      .all(workflowId) as unknown as RawConflict[];
    return rows.map(hydrateConflict);
  }

  /** Attach the bounded resolution task created for a conflict. */
  attachResolutionTask(conflictId: string, taskId: string): IntegrationConflictRow | undefined {
    this.#db
      .prepare("UPDATE integration_conflict SET resolutionTaskId = ? WHERE conflictId = ?")
      .run(taskId, conflictId);
    return this.conflict(conflictId);
  }

  settleConflict(
    conflictId: string,
    status: ConflictStatus,
    at: IsoTimestamp,
    detail: string | null,
  ): IntegrationConflictRow | undefined {
    this.#db
      .prepare("UPDATE integration_conflict SET status = ?, resolvedAt = ?, detail = ? WHERE conflictId = ?")
      .run(status, at, detail, conflictId);
    return this.conflict(conflictId);
  }
}
