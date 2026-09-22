/**
 * Storage for the runtime transition log and first-class blockers (issue #41;
 * migration `0005-transitions.sql`).
 *
 * Like `trace-store.ts` and `decision-cache.ts`, these are not PLAN §5
 * records and so are not `AppendOnlyRepository`/`MutableRepository`
 * subclasses. A transition event is the audit of an *attempt* to change a
 * subject — including attempts that changed nothing — and a blocker is a
 * reason attached to a subject rather than a record with its own revisioned
 * identity.
 *
 * This module is only the tables. What a transition means, which guards it
 * needs and what it is allowed to change lives in `src/workflow/state.ts`.
 */
import type { Database } from "./sqlite.ts";
import type { ContentHash, IsoTimestamp, Revision, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";

/** Subject a transition or blocker applies to. */
export type TransitionSubjectKind = "task" | "phase";

/** Who asked for a transition. `engine` is the only actor that may commit one. */
export interface TransitionActor {
  readonly kind: "engine" | "user" | "worker";
  readonly identity: string;
}

/** One attempted transition, accepted or rejected. Immutable once written. */
export interface TransitionEvent {
  readonly eventId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly subjectKind: TransitionSubjectKind;
  readonly subjectId: string;
  readonly fromState: string;
  readonly toState: string;
  /** `Transition.id` of the matched edge, or `null` when none matched. */
  readonly transitionId: string | null;
  readonly trigger: string;
  readonly actor: TransitionActor;
  readonly disposition: "accepted" | "rejected";
  /** Stable reason code; `null` exactly when accepted. */
  readonly reasonCode: string | null;
  readonly taskRevision: Revision | null;
  readonly planRevision: Revision;
  readonly gitRevision: string | null;
  readonly mode: string;
  readonly policyVersion: string;
  readonly failedGuards: readonly string[];
  /** Sanitised references only — never raw payloads or credentials (§6). */
  readonly evidenceRefs: readonly string[];
  readonly beforeHash: ContentHash;
  readonly afterHash: ContentHash;
}

/** A reason a subject cannot progress. Resolved, never deleted. */
export interface BlockerRow {
  readonly blockerId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly subjectKind: TransitionSubjectKind;
  readonly subjectId: string;
  readonly kind: string;
  readonly detail: string;
  readonly raisedBy: string;
  readonly resolvedAt: IsoTimestamp | null;
  readonly resolvedBy: string | null;
  readonly resolutionDetail: string | null;
}

interface RawEventRow {
  eventId: string;
  payload: string;
}

/** Append-only transition log. No update or delete path exists, by SQL trigger. */
export class TransitionLogStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Append one event exactly as given. */
  insert(event: TransitionEvent): TransitionEvent {
    this.#db
      .prepare(
        "INSERT INTO transition_event (eventId, createdAt, workflowId, subjectKind, subjectId, fromState, " +
          "toState, transitionId, trigger, actorKind, actorIdentity, disposition, reasonCode, taskRevision, " +
          "planRevision, gitRevision, mode, policyVersion, failedGuards, evidenceRefs, beforeHash, afterHash, " +
          "payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventId,
        event.createdAt,
        event.workflowId,
        event.subjectKind,
        event.subjectId,
        event.fromState,
        event.toState,
        event.transitionId,
        event.trigger,
        event.actor.kind,
        event.actor.identity,
        event.disposition,
        event.reasonCode,
        event.taskRevision,
        event.planRevision,
        event.gitRevision,
        event.mode,
        event.policyVersion,
        canonicalJson(event.failedGuards),
        canonicalJson(event.evidenceRefs),
        event.beforeHash,
        event.afterHash,
        canonicalJson(event),
      );
    return event;
  }

  get(eventId: string): TransitionEvent | undefined {
    const row = this.#db.prepare("SELECT eventId, payload FROM transition_event WHERE eventId = ?").get(eventId) as
      | RawEventRow
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.payload) as TransitionEvent);
  }

  #query(where: string, params: readonly (string | number)[]): readonly TransitionEvent[] {
    const rows = this.#db
      .prepare(`SELECT eventId, payload FROM transition_event ${where} ORDER BY createdAt, rowid`)
      .all(...params) as unknown as RawEventRow[];
    return rows.map((row) => JSON.parse(row.payload) as TransitionEvent);
  }

  /** Every attempted transition on one subject, oldest first. */
  forSubject(subjectKind: TransitionSubjectKind, subjectId: string): readonly TransitionEvent[] {
    return this.#query("WHERE subjectKind = ? AND subjectId = ?", [subjectKind, subjectId]);
  }

  /** Every attempted transition in one workflow, oldest first. */
  forWorkflow(workflowId: string): readonly TransitionEvent[] {
    return this.#query("WHERE workflowId = ?", [workflowId]);
  }

  /** Rejections only — what `/korwf why` shows when a task refuses to advance. */
  rejectionsForSubject(subjectKind: TransitionSubjectKind, subjectId: string): readonly TransitionEvent[] {
    return this.#query("WHERE subjectKind = ? AND subjectId = ? AND disposition = 'rejected'", [
      subjectKind,
      subjectId,
    ]);
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM transition_event").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}

const BLOCKER_COLUMNS =
  "blockerId, createdAt, workflowId, subjectKind, subjectId, kind, detail, raisedBy, resolvedAt, " +
  "resolvedBy, resolutionDetail";

function toBlocker(row: Record<string, unknown>): BlockerRow {
  return {
    blockerId: String(row.blockerId),
    createdAt: String(row.createdAt),
    workflowId: String(row.workflowId) as WorkflowId,
    subjectKind: String(row.subjectKind) as TransitionSubjectKind,
    subjectId: String(row.subjectId),
    kind: String(row.kind),
    detail: String(row.detail),
    raisedBy: String(row.raisedBy),
    resolvedAt: row.resolvedAt === null || row.resolvedAt === undefined ? null : String(row.resolvedAt),
    resolvedBy: row.resolvedBy === null || row.resolvedBy === undefined ? null : String(row.resolvedBy),
    resolutionDetail:
      row.resolutionDetail === null || row.resolutionDetail === undefined ? null : String(row.resolutionDetail),
  };
}

/**
 * Blocker rows. A blocker is raised once and resolved once; the SQL triggers
 * refuse deletion and refuse to reopen a resolved row, so "the blocker went
 * away" can never erase why the subject stopped.
 */
export class BlockerStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insert(blocker: BlockerRow): BlockerRow {
    this.#db
      .prepare(
        `INSERT INTO blocker (${BLOCKER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        blocker.blockerId,
        blocker.createdAt,
        blocker.workflowId,
        blocker.subjectKind,
        blocker.subjectId,
        blocker.kind,
        blocker.detail,
        blocker.raisedBy,
        blocker.resolvedAt,
        blocker.resolvedBy,
        blocker.resolutionDetail,
      );
    return blocker;
  }

  get(blockerId: string): BlockerRow | undefined {
    const row = this.#db.prepare(`SELECT ${BLOCKER_COLUMNS} FROM blocker WHERE blockerId = ?`).get(blockerId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toBlocker(row);
  }

  #query(where: string, params: readonly (string | number)[]): readonly BlockerRow[] {
    const rows = this.#db
      .prepare(`SELECT ${BLOCKER_COLUMNS} FROM blocker ${where} ORDER BY createdAt, rowid`)
      .all(...params) as unknown as Record<string, unknown>[];
    return rows.map(toBlocker);
  }

  /** All blockers ever raised on a subject, oldest first. */
  forSubject(subjectKind: TransitionSubjectKind, subjectId: string): readonly BlockerRow[] {
    return this.#query("WHERE subjectKind = ? AND subjectId = ?", [subjectKind, subjectId]);
  }

  /** Unresolved blockers on a subject — the set that makes `blocked` true. */
  unresolvedForSubject(subjectKind: TransitionSubjectKind, subjectId: string): readonly BlockerRow[] {
    return this.#query("WHERE subjectKind = ? AND subjectId = ? AND resolvedAt IS NULL", [subjectKind, subjectId]);
  }

  /** Unresolved blockers anywhere in a workflow, for the boards. */
  unresolvedForWorkflow(workflowId: string): readonly BlockerRow[] {
    return this.#query("WHERE workflowId = ? AND resolvedAt IS NULL", [workflowId]);
  }

  /**
   * Mark one blocker resolved. Throws (via the SQL trigger) if it already is:
   * resolution is final, and a second resolution would overwrite the first
   * actor and timestamp.
   */
  resolve(
    blockerId: string,
    resolution: { readonly at: IsoTimestamp; readonly by: string; readonly detail: string },
  ): BlockerRow {
    const existing = this.get(blockerId);
    if (existing === undefined) throw new Error(`unknown blocker ${blockerId}`);
    this.#db
      .prepare("UPDATE blocker SET resolvedAt = ?, resolvedBy = ?, resolutionDetail = ? WHERE blockerId = ?")
      .run(resolution.at, resolution.by, resolution.detail, blockerId);
    return { ...existing, resolvedAt: resolution.at, resolvedBy: resolution.by, resolutionDetail: resolution.detail };
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM blocker").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
