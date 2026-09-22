/**
 * Storage for bounded-recovery decisions (issue #53; migration
 * `0008-recovery.sql`).
 *
 * PLAN §3.G requires every recovery response to be auditable and bounded.
 * This is the durable half: one append-only row per decision, naming the
 * policy rule that produced it and the attempt count it was taken at. The
 * *policy* — which response follows which failure category at which attempt —
 * lives in `src/workflow/recovery.ts`; this module only stores what was
 * decided.
 *
 * Like `transition-log.ts` and `action-log.ts`, these are not PLAN §5
 * records: a recovery decision has no revisioned identity and is never
 * updated, so there is no repository class and no update path at all. The
 * database enforces that with triggers.
 */
import type { Database } from "./sqlite.ts";
import type { IsoTimestamp, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";

/** What a recovery decision was taken about. */
export type RecoverySubjectKind = "task" | "phase" | "workflow";

/** One recorded recovery decision. Immutable once written. */
export interface RecoveryDecisionRow {
  readonly decisionRowId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly subjectKind: RecoverySubjectKind;
  readonly subjectId: string;
  /** Attempts already spent on this subject when the decision was taken. */
  readonly attemptsUsed: number;
  /** Hard ceiling in force at that moment. */
  readonly maxAttempts: number;
  /** Failure category from `src/workflow/failure.ts` (#52). */
  readonly failureCategory: string;
  /** Rule id of that classification, carried through unchanged. */
  readonly failureRule: string;
  /** Chosen response, one of the PLAN §3.G menu. */
  readonly response: string;
  /** Stable id of the policy rule that chose it. */
  readonly policyRule: string;
  readonly reason: string;
  /** `true` when the response ends recovery for this subject. */
  readonly terminal: boolean;
  /** Reconciliation verdict for a side-effecting step, else `null`. */
  readonly sideEffectStatus: string | null;
  /** Idempotency key of the guarded action, when one was consulted (#42). */
  readonly actionId: string | null;
}

interface RawRow {
  payload: string;
}

/** Append-only log of recovery decisions. No update or delete path exists. */
export class RecoveryLogStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Append one decision exactly as given. */
  insert(row: RecoveryDecisionRow): RecoveryDecisionRow {
    this.#db
      .prepare(
        "INSERT INTO recovery_decision (decisionRowId, createdAt, workflowId, subjectKind, subjectId, " +
          "attemptsUsed, maxAttempts, failureCategory, failureRule, response, policyRule, reason, terminal, " +
          "sideEffectStatus, actionId, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.decisionRowId,
        row.createdAt,
        row.workflowId,
        row.subjectKind,
        row.subjectId,
        row.attemptsUsed,
        row.maxAttempts,
        row.failureCategory,
        row.failureRule,
        row.response,
        row.policyRule,
        row.reason,
        row.terminal ? 1 : 0,
        row.sideEffectStatus,
        row.actionId,
        canonicalJson(row),
      );
    return row;
  }

  #query(where: string, params: readonly (string | number)[]): readonly RecoveryDecisionRow[] {
    const rows = this.#db
      .prepare(`SELECT payload FROM recovery_decision ${where} ORDER BY createdAt, rowid`)
      .all(...params) as unknown as RawRow[];
    return rows.map((r) => JSON.parse(r.payload) as RecoveryDecisionRow);
  }

  /** Every decision about one subject, oldest first. */
  forSubject(subjectKind: RecoverySubjectKind, subjectId: string): readonly RecoveryDecisionRow[] {
    return this.#query("WHERE subjectKind = ? AND subjectId = ?", [subjectKind, subjectId]);
  }

  /** Every decision in one workflow, oldest first. */
  forWorkflow(workflowId: string): readonly RecoveryDecisionRow[] {
    return this.#query("WHERE workflowId = ?", [workflowId]);
  }

  /**
   * How many `retry`-class responses this subject has already been granted.
   *
   * This is the number the bound is enforced against when a caller has no
   * in-memory attempt count — after a resume, for instance. Reading it from
   * the log rather than from a counter is what makes the bound survive a
   * restart: a crashed session cannot forget that it already retried.
   */
  retriesGranted(subjectKind: RecoverySubjectKind, subjectId: string): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM recovery_decision WHERE subjectKind = ? AND subjectId = ? AND response = 'retry'",
      )
      .get(subjectKind, subjectId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM recovery_decision").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
