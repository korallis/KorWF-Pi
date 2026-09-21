/**
 * Storage side of decision traces (issue #31; PLAN §3.I, §7).
 *
 * Deliberately not an `AppendOnlyRepository`/`MutableRepository`, for the
 * same reason `decision-cache.ts` is not: a trace is observability about a
 * `Decision` row rather than a PLAN §5 record of its own. It is write-once
 * (the trigger in `migrations/0004-decision-trace.sql` rejects UPDATE from
 * any connection) but it *is* deletable, because PLAN §7 requires retention
 * and deletion controls for logging. Deleting a trace never touches the
 * Decision it points at.
 *
 * `src/telemetry/trace.ts` owns what a trace contains; this module is only
 * the table.
 */
import type { Database } from "./sqlite.ts";
import type { DecisionTrace } from "../telemetry/trace-types.ts";
import { canonicalJson } from "./repos/base.ts";

/** Columns that exist for indexing; the whole trace lives in `payload`. */
interface RawRow {
  traceId: string;
  createdAt: string;
  decisionId: string | null;
  attemptId: string | null;
  workflowId: string;
  questionId: string;
  questionVersion: string;
  outcome: string;
  latencyMs: number | null;
  retries: number;
  breakerState: string;
  rawPayloadPath: string | null;
  payload: string;
}

function fromRaw(row: RawRow): DecisionTrace {
  return JSON.parse(row.payload) as DecisionTrace;
}

/** Thin table wrapper. Policy (redaction, retention) lives in `src/telemetry/`. */
export class DecisionTraceStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Append one trace. Returns it exactly as persisted. */
  insert(trace: DecisionTrace): DecisionTrace {
    this.#db
      .prepare(
        "INSERT INTO decision_trace (traceId, createdAt, decisionId, attemptId, workflowId, questionId, " +
          "questionVersion, outcome, latencyMs, retries, breakerState, rawPayloadPath, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        trace.traceId,
        trace.createdAt,
        trace.decisionId,
        trace.attemptId,
        trace.workflowId,
        trace.question.id,
        trace.question.version,
        trace.outcome,
        trace.latencyMs,
        trace.retries,
        trace.breakerState,
        trace.rawPayload === null ? null : trace.rawPayload.relativePath,
        canonicalJson(trace),
      );
    return trace;
  }

  get(traceId: string): DecisionTrace | undefined {
    const row = this.#db.prepare("SELECT * FROM decision_trace WHERE traceId = ?").get(traceId) as
      | RawRow
      | undefined;
    return row === undefined ? undefined : fromRaw(row);
  }

  /** Traces for one recorded Decision, oldest first. */
  forDecision(decisionId: string): readonly DecisionTrace[] {
    const rows = this.#db
      .prepare("SELECT * FROM decision_trace WHERE decisionId = ? ORDER BY rowid")
      .all(decisionId) as unknown as RawRow[];
    return rows.map(fromRaw);
  }

  /** Traces attributed to one attempt, oldest first. */
  forAttempt(attemptId: string): readonly DecisionTrace[] {
    const rows = this.#db
      .prepare("SELECT * FROM decision_trace WHERE attemptId = ? ORDER BY rowid")
      .all(attemptId) as unknown as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every trace, oldest first. Used by reports and by retention sweeps. */
  all(): readonly DecisionTrace[] {
    const rows = this.#db.prepare("SELECT * FROM decision_trace ORDER BY rowid").all() as unknown as RawRow[];
    return rows.map(fromRaw);
  }

  /** Traces written strictly before `cutoff` (ISO-8601), oldest first. */
  olderThan(cutoff: string): readonly DecisionTrace[] {
    const rows = this.#db
      .prepare("SELECT * FROM decision_trace WHERE createdAt < ? ORDER BY rowid")
      .all(cutoff) as unknown as RawRow[];
    return rows.map(fromRaw);
  }

  /** Traces that still name raw payload bytes on disk, oldest first. */
  withRawPayload(): readonly DecisionTrace[] {
    const rows = this.#db
      .prepare("SELECT * FROM decision_trace WHERE rawPayloadPath IS NOT NULL ORDER BY rowid")
      .all() as unknown as RawRow[];
    return rows.map(fromRaw);
  }

  /**
   * Forget that a trace's raw payload exists. Write-once forbids UPDATE, so
   * the row is replaced: same `traceId`, same everything, `rawPayload: null`.
   * Callers are `src/telemetry/retention.ts` only, after the bytes are gone.
   */
  clearRawPayload(traceId: string): void {
    const existing = this.get(traceId);
    if (existing === undefined || existing.rawPayload === null) return;
    this.#db.prepare("DELETE FROM decision_trace WHERE traceId = ?").run(traceId);
    this.insert({ ...existing, rawPayload: null });
  }

  /** Delete traces written before `cutoff`. Returns how many rows went. */
  deleteOlderThan(cutoff: string): number {
    const result = this.#db.prepare("DELETE FROM decision_trace WHERE createdAt < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }

  /** Delete one trace. Idempotent. */
  delete(traceId: string): void {
    this.#db.prepare("DELETE FROM decision_trace WHERE traceId = ?").run(traceId);
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM decision_trace").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
