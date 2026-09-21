/**
 * Storage side of the revision-aware decision cache (issue #29; PLAN §6).
 *
 * This is deliberately not an `AppendOnlyRepository`/`MutableRepository`: a
 * cache row carries no independent truth (it only points at a `Decision`
 * row, which is the truth), so it does not belong in `docs/records.md`'s
 * append-only/mutable taxonomy, is not audited, and may be overwritten or
 * deleted freely. `src/decisions/cache.ts` is the policy layer that computes
 * `cacheKey` and decides whether a hit is usable; this module is only the
 * table.
 */
import type { Database } from "./sqlite.ts";
import type { DecisionId, IsoTimestamp } from "./records.ts";

export interface DecisionCacheRow {
  readonly cacheKey: string;
  readonly questionId: string;
  readonly questionVersion: string;
  readonly decisionId: DecisionId;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp | null;
}

interface RawRow {
  cacheKey: string;
  questionId: string;
  questionVersion: string;
  decisionId: string;
  createdAt: string;
  expiresAt: string | null;
}

function fromRaw(row: RawRow): DecisionCacheRow {
  return {
    cacheKey: row.cacheKey,
    questionId: row.questionId,
    questionVersion: row.questionVersion,
    decisionId: row.decisionId as DecisionId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** Thin table wrapper. `src/decisions/cache.ts` owns all invalidation policy. */
export class DecisionCacheStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Insert or replace a cache row for `cacheKey`. */
  put(row: DecisionCacheRow): void {
    this.#db
      .prepare(
        "INSERT INTO decision_cache (cacheKey, questionId, questionVersion, decisionId, createdAt, expiresAt) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(cacheKey) DO UPDATE SET decisionId = excluded.decisionId, createdAt = excluded.createdAt, expiresAt = excluded.expiresAt",
      )
      .run(row.cacheKey, row.questionId, row.questionVersion, row.decisionId, row.createdAt, row.expiresAt);
  }

  /** The row for this exact key, or `undefined` if there is none. */
  get(cacheKey: string): DecisionCacheRow | undefined {
    const row = this.#db.prepare("SELECT * FROM decision_cache WHERE cacheKey = ?").get(cacheKey) as
      | RawRow
      | undefined;
    return row === undefined ? undefined : fromRaw(row);
  }

  /** Remove one row. Idempotent. */
  delete(cacheKey: string): void {
    this.#db.prepare("DELETE FROM decision_cache WHERE cacheKey = ?").run(cacheKey);
  }

  /** Remove every row for one question id (all versions). Used on manifest drift. */
  deleteByQuestion(questionId: string): number {
    const result = this.#db.prepare("DELETE FROM decision_cache WHERE questionId = ?").run(questionId);
    return Number(result.changes ?? 0);
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM decision_cache").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
