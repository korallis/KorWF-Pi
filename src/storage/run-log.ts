/**
 * Storage for `Run` rows (issue #74; migration `0012-runs.sql`).
 *
 * A `Run` is the durable identity of one `/korwf run` invocation: minted
 * before `startRun` touches a phase, so the id in the user's terminal is the
 * same id `#72`'s crash reconciliation and this issue's own `stopRun` find
 * afterwards. Not a PLAN §5 record — no revisioned identity, never updated —
 * so it lives here rather than in a repository, like `transition_event`.
 */
import type { Database } from "./sqlite.ts";
import type { IsoTimestamp, PhaseId, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";
import type { RunId } from "../workflow/run.ts";

/** One `/korwf run` invocation. Immutable once written. */
export interface RunRow {
  readonly runId: RunId;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly phaseIds: readonly PhaseId[];
}

interface RawRow {
  payload: string;
}

function hydrate(row: RawRow): RunRow {
  return JSON.parse(row.payload) as RunRow;
}

/** Append-only store of `Run` rows. */
export class RunLogStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insert(row: RunRow): RunRow {
    this.#db
      .prepare("INSERT INTO run (runId, createdAt, workflowId, phaseIds, payload) VALUES (?, ?, ?, ?, ?)")
      .run(row.runId, row.createdAt, row.workflowId, canonicalJson(row.phaseIds), canonicalJson(row));
    return row;
  }

  get(runId: string): RunRow | undefined {
    const row = this.#db.prepare("SELECT payload FROM run WHERE runId = ?").get(runId) as RawRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  }

  forWorkflow(workflowId: string): readonly RunRow[] {
    const rows = this.#db
      .prepare("SELECT payload FROM run WHERE workflowId = ? ORDER BY createdAt, rowid")
      .all(workflowId) as unknown as RawRow[];
    return rows.map(hydrate);
  }
}
