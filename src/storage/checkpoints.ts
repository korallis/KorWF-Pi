/**
 * Storage for checkpoints and rollback proposals (issue #54; migration
 * `0010-checkpoints.sql`; PLAN §3.G, §10).
 *
 * ADR 0001 row 5 records exactly what was wrong with the Pi example this
 * extends: its stash refs lived in an in-memory `Map` that was cleared after
 * every agent run and lost on reload. This module is the fix — a checkpoint
 * is a durable row keyed by attempt and task, so a session that is resumed,
 * forked or rewound can still find the work a previous session snapshotted.
 *
 * A `RollbackProposal` is the second half, and it is deliberately *not* an
 * approval: it is the description of a destructive act, and it carries an
 * `approvalId` that stays `null` until a human grants one. The database
 * refuses to move a proposal to `applied` while that column is null, and
 * refuses it outright when the target is the user's main tree.
 *
 * Like `action-log.ts` and `recovery-log.ts`, these are not PLAN §5 records:
 * they have no revisioned identity and are never rewritten (a proposal has
 * one single-use status transition and nothing else).
 */
import type { Database } from "./sqlite.ts";
import type { IsoTimestamp, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";

/** Why a checkpoint was taken. */
export type CheckpointRecordKind = "pre_attempt" | "post_step" | "pre_rollback_preservation" | "manual";

/** Lifecycle of a rollback proposal. `proposed`/`approved` are non-terminal. */
export type RollbackProposalStatus = "proposed" | "approved" | "applied" | "refused" | "superseded";

/** One durable checkpoint. Immutable once written. */
export interface CheckpointRow {
  readonly checkpointId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  /** Attempt the checkpoint is tagged with; `null` for a manual one. */
  readonly attemptId: string | null;
  readonly taskId: string | null;
  readonly kind: CheckpointRecordKind;
  readonly worktreePath: string;
  /** `git rev-parse --git-common-dir`; shared by a repo and its worktrees. */
  readonly repoCommonDir: string;
  /** `true` when this captured the user's main tree (capturable, never restorable). */
  readonly isMainTree: boolean;
  readonly ref: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly parentCommit: string | null;
  readonly branch: string | null;
  /** `true` when the tree had uncommitted changes when captured. */
  readonly dirty: boolean;
  readonly changedPaths: number;
  readonly summary: string;
}

/** One rollback proposal. Never an authorisation. */
export interface RollbackProposalRow {
  readonly proposalId: string;
  readonly createdAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  readonly checkpointId: string;
  readonly taskId: string | null;
  readonly attemptId: string | null;
  readonly worktreePath: string;
  readonly targetIsMainTree: boolean;
  readonly diffSummary: string;
  readonly wouldLoseCount: number;
  /** `true` when the target tree holds uncommitted work the restore would discard. */
  readonly wouldLoseUncommitted: boolean;
  /** `actionIdFor` key (#42) of the restore; its receipt refuses a replay. */
  readonly actionId: string;
  readonly classId: string;
  readonly requestId: string | null;
  readonly approvalId: string | null;
  readonly status: RollbackProposalStatus;
  readonly resolvedAt: IsoTimestamp | null;
  readonly reasonCode: string | null;
  readonly detail: string | null;
}

interface RawRow {
  payload: string;
}

interface RawProposalRow extends RawRow {
  status: string;
  requestId: string | null;
  approvalId: string | null;
  resolvedAt: string | null;
  reasonCode: string | null;
  detail: string | null;
}

/** Rebuild a proposal from its payload with the mutable columns applied. */
function hydrateProposal(row: RawProposalRow): RollbackProposalRow {
  const stored = JSON.parse(row.payload) as RollbackProposalRow;
  return {
    ...stored,
    status: row.status as RollbackProposalStatus,
    requestId: row.requestId,
    approvalId: row.approvalId,
    resolvedAt: row.resolvedAt as IsoTimestamp | null,
    reasonCode: row.reasonCode,
    detail: row.detail,
  };
}

/** Append-only store of checkpoints and rollback proposals. */
export class CheckpointStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Record a checkpoint. Throws if this id already exists. */
  insert(row: CheckpointRow): CheckpointRow {
    this.#db
      .prepare(
        "INSERT INTO checkpoint (checkpointId, createdAt, workflowId, attemptId, taskId, kind, worktreePath, " +
          "repoCommonDir, isMainTree, ref, commitSha, treeSha, parentCommit, branch, dirty, changedPaths, " +
          "summary, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.checkpointId,
        row.createdAt,
        row.workflowId,
        row.attemptId,
        row.taskId,
        row.kind,
        row.worktreePath,
        row.repoCommonDir,
        row.isMainTree ? 1 : 0,
        row.ref,
        row.commitSha,
        row.treeSha,
        row.parentCommit,
        row.branch,
        row.dirty ? 1 : 0,
        row.changedPaths,
        row.summary,
        canonicalJson(row),
      );
    return row;
  }

  find(checkpointId: string): CheckpointRow | undefined {
    const row = this.#db
      .prepare("SELECT payload FROM checkpoint WHERE checkpointId = ?")
      .get(checkpointId) as RawRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.payload) as CheckpointRow);
  }

  #query(where: string, params: readonly (string | number)[]): readonly CheckpointRow[] {
    const rows = this.#db
      .prepare(`SELECT payload FROM checkpoint ${where} ORDER BY createdAt, rowid`)
      .all(...params) as unknown as RawRow[];
    return rows.map((r) => JSON.parse(r.payload) as CheckpointRow);
  }

  /** Every checkpoint in a workflow, oldest first. */
  forWorkflow(workflowId: string): readonly CheckpointRow[] {
    return this.#query("WHERE workflowId = ?", [workflowId]);
  }

  /** Checkpoints tagged with one attempt id (issue #54 Scope). */
  forAttempt(attemptId: string): readonly CheckpointRow[] {
    return this.#query("WHERE attemptId = ?", [attemptId]);
  }

  forTask(taskId: string): readonly CheckpointRow[] {
    return this.#query("WHERE taskId = ?", [taskId]);
  }

  /** The most recent checkpoint for a task, or `undefined`. */
  latestForTask(taskId: string): CheckpointRow | undefined {
    const all = this.forTask(taskId);
    return all[all.length - 1];
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM checkpoint").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}

/** Append-only store of rollback proposals with a single-use resolution. */
export class RollbackProposalStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Record a proposal. Always inserted as `proposed` or `approved`. */
  insert(row: RollbackProposalRow): RollbackProposalRow {
    this.#db
      .prepare(
        "INSERT INTO rollback_proposal (proposalId, createdAt, workflowId, checkpointId, taskId, attemptId, " +
          "worktreePath, targetIsMainTree, diffSummary, wouldLoseCount, wouldLoseUncommitted, actionId, " +
          "classId, requestId, approvalId, status, resolvedAt, reasonCode, detail, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.proposalId,
        row.createdAt,
        row.workflowId,
        row.checkpointId,
        row.taskId,
        row.attemptId,
        row.worktreePath,
        row.targetIsMainTree ? 1 : 0,
        row.diffSummary,
        row.wouldLoseCount,
        row.wouldLoseUncommitted ? 1 : 0,
        row.actionId,
        row.classId,
        row.requestId,
        row.approvalId,
        row.status,
        row.resolvedAt,
        row.reasonCode,
        row.detail,
        canonicalJson(row),
      );
    return row;
  }

  find(proposalId: string): RollbackProposalRow | undefined {
    const row = this.#db
      .prepare(
        "SELECT payload, status, requestId, approvalId, resolvedAt, reasonCode, detail " +
          "FROM rollback_proposal WHERE proposalId = ?",
      )
      .get(proposalId) as RawProposalRow | undefined;
    return row === undefined ? undefined : hydrateProposal(row);
  }

  #query(where: string, params: readonly (string | number)[]): readonly RollbackProposalRow[] {
    const rows = this.#db
      .prepare(
        "SELECT payload, status, requestId, approvalId, resolvedAt, reasonCode, detail " +
          `FROM rollback_proposal ${where} ORDER BY createdAt, rowid`,
      )
      .all(...params) as unknown as RawProposalRow[];
    return rows.map(hydrateProposal);
  }

  forWorkflow(workflowId: string): readonly RollbackProposalRow[] {
    return this.#query("WHERE workflowId = ?", [workflowId]);
  }

  forCheckpoint(checkpointId: string): readonly RollbackProposalRow[] {
    return this.#query("WHERE checkpointId = ?", [checkpointId]);
  }

  /** Proposals still awaiting an answer, oldest first. */
  openForWorkflow(workflowId: string): readonly RollbackProposalRow[] {
    return this.#query("WHERE workflowId = ? AND status IN ('proposed','approved')", [workflowId]);
  }

  /**
   * Attach the approval a human granted.
   *
   * Separate from `resolve` on purpose: recording *that* a grant exists is
   * not the same act as performing the rollback, and the gap between them is
   * where the restore actually runs. A failed restore therefore leaves an
   * `approved` row that never became `applied`, which is visible.
   */
  attachApproval(proposalId: string, approvalId: string, at: IsoTimestamp): boolean {
    const result = this.#db
      .prepare(
        "UPDATE rollback_proposal SET status = 'approved', approvalId = ?, detail = " +
          "COALESCE(detail, '') || ? WHERE proposalId = ? AND status = 'proposed'",
      )
      .run(approvalId, `approved at ${at}`, proposalId);
    return Number(result.changes) === 1;
  }

  /** Record the queued approval request this proposal is waiting on. */
  attachRequest(proposalId: string, requestId: string): boolean {
    const result = this.#db
      .prepare("UPDATE rollback_proposal SET requestId = ? WHERE proposalId = ? AND status = 'proposed'")
      .run(requestId, proposalId);
    return Number(result.changes) === 1;
  }

  /**
   * Move a proposal to a terminal status. The database refuses `applied`
   * without an `approvalId` and refuses any second resolution.
   */
  resolve(
    proposalId: string,
    at: IsoTimestamp,
    outcome: {
      readonly status: Exclude<RollbackProposalStatus, "proposed" | "approved">;
      readonly reasonCode?: string | null;
      readonly detail?: string | null;
    },
  ): boolean {
    const result = this.#db
      .prepare(
        "UPDATE rollback_proposal SET status = ?, resolvedAt = ?, reasonCode = ?, detail = ? " +
          "WHERE proposalId = ? AND status IN ('proposed','approved')",
      )
      .run(outcome.status, at, outcome.reasonCode ?? null, outcome.detail ?? null, proposalId);
    return Number(result.changes) === 1;
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM rollback_proposal").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}
