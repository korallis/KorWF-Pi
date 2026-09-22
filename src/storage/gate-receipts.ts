/**
 * Storage for gate receipts (issue #46; migration `0007-gate-receipts.sql`;
 * docs/gates.md §7).
 *
 * A **gate receipt** is the record of one evaluation of the task or phase
 * gate. It is the only thing in the system that may authorise
 * `Task.status = done`, and it can do so exactly once:
 *
 *  - a receipt is written for every evaluation, pass *and* reject, so a
 *    refusal is as visible as a success and `/korwf why` can name the
 *    condition that failed from `reasonCode`/`detail`;
 *  - a passing receipt carries the `inputHash` of the exact gate input, so it
 *    stops authorising anything the moment a record, the task revision or the
 *    Git SHA moves;
 *  - `consumedAt` is stamped in the same transaction as the status write, and
 *    the database refuses a second stamp.
 *
 * Like `transition-log.ts` and `action-log.ts` this is not a PLAN §5 record:
 * a receipt has no revisioned identity and is never rewritten, so it has no
 * repository class and no update path beyond `consume`.
 */
import type { Database } from "./sqlite.ts";
import type { ContentHash, GitSha, IsoTimestamp, Revision, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";

/** Which gate produced the receipt. */
export type GateKind = "task" | "phase";

/** One recorded gate evaluation. */
export interface GateReceipt {
  readonly receiptId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly gate: GateKind;
  readonly subjectId: string;
  /** `Task.revision` for a task gate; `Workflow.planRevision` for a phase gate. */
  readonly subjectRevision: Revision;
  /** Exact Git SHA the gate was evaluated at, read by `src/git/`. */
  readonly revision: GitSha;
  readonly disposition: "pass" | "reject";
  /** Closed-set code from docs/gates.md §7; `null` exactly when passing. */
  readonly reasonCode: string | null;
  readonly detail: string | null;
  /** Hash of the exact gate input this verdict was computed from. */
  readonly inputHash: ContentHash;
  readonly evaluatedAt: IsoTimestamp;
  /** When this receipt authorised a status write; `null` until then. */
  readonly consumedAt: IsoTimestamp | null;
  /** Every condition's verdict, for `/korwf why`. */
  readonly conditions: readonly GateConditionResult[];
}

/** One condition of the gate conjunction and how it came out. */
export interface GateConditionResult {
  /** `C0`…`C3` for the task gate, `P0`…`P4` for the phase gate. */
  readonly id: string;
  readonly satisfied: boolean;
  /** `null` when satisfied. */
  readonly reasonCode: string | null;
  readonly detail: string | null;
}

interface RawRow {
  payload: string;
  consumedAt: string | null;
}

/**
 * Rebuild a receipt from its stored payload, with `consumedAt` taken from the
 * column. The payload is never rewritten (the trigger forbids it), so the
 * column is the authority on consumption.
 */
function hydrate(row: RawRow): GateReceipt {
  const stored = JSON.parse(row.payload) as GateReceipt;
  return { ...stored, consumedAt: row.consumedAt };
}

/** Append-only log of gate evaluations, with single-use consumption. */
export class GateReceiptStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Record one evaluation. Throws if the receipt id was already used. */
  record(receipt: GateReceipt): GateReceipt {
    this.#db
      .prepare(
        "INSERT INTO gate_receipt (receiptId, createdAt, workflowId, gate, subjectId, subjectRevision, " +
          "revision, disposition, reasonCode, detail, inputHash, evaluatedAt, consumedAt, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        receipt.receiptId,
        receipt.createdAt,
        receipt.workflowId,
        receipt.gate,
        receipt.subjectId,
        receipt.subjectRevision,
        receipt.revision,
        receipt.disposition,
        receipt.reasonCode,
        receipt.detail,
        receipt.inputHash,
        receipt.evaluatedAt,
        receipt.consumedAt,
        canonicalJson(receipt),
      );
    return receipt;
  }

  /** One receipt by id, or `undefined`. */
  find(receiptId: string): GateReceipt | undefined {
    const row = this.#db
      .prepare("SELECT payload, consumedAt FROM gate_receipt WHERE receiptId = ?")
      .get(receiptId) as RawRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  }

  #query(where: string, params: readonly (string | number)[]): readonly GateReceipt[] {
    const rows = this.#db
      .prepare(`SELECT payload, consumedAt FROM gate_receipt ${where} ORDER BY evaluatedAt, rowid`)
      .all(...params) as unknown as RawRow[];
    return rows.map(hydrate);
  }

  /** Every receipt for a subject, oldest first. */
  forSubject(gate: GateKind, subjectId: string): readonly GateReceipt[] {
    return this.#query("WHERE gate = ? AND subjectId = ?", [gate, subjectId]);
  }

  /** The most recent receipt for a subject, or `undefined`. */
  latestForSubject(gate: GateKind, subjectId: string): GateReceipt | undefined {
    const all = this.forSubject(gate, subjectId);
    return all[all.length - 1];
  }

  /**
   * An unconsumed passing receipt for exactly this input, or `undefined`.
   *
   * This is the lookup `TaskRepository.beforeUpdate` performs before allowing
   * `status = done`. The `inputHash` match is what makes a stale pass useless:
   * change a record, rerun a check, bump the revision, and no receipt matches.
   */
  findUsablePass(args: {
    readonly gate: GateKind;
    readonly subjectId: string;
    readonly inputHash: ContentHash;
  }): GateReceipt | undefined {
    const rows = this.#query(
      "WHERE gate = ? AND subjectId = ? AND inputHash = ? AND disposition = 'pass' AND consumedAt IS NULL",
      [args.gate, args.subjectId, args.inputHash],
    );
    return rows[0];
  }

  /**
   * Stamp a passing receipt as used. Returns `false` when there was nothing
   * to stamp (already consumed, or not a pass) — the caller must then refuse
   * the status write rather than proceed.
   */
  consume(receiptId: string, at: IsoTimestamp): boolean {
    const result = this.#db
      .prepare(
        "UPDATE gate_receipt SET consumedAt = ? " +
          "WHERE receiptId = ? AND disposition = 'pass' AND consumedAt IS NULL",
      )
      .run(at, receiptId);
    return Number(result.changes) === 1;
  }
}
