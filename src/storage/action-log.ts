/**
 * Storage for completed-action receipts and refused replays (issue #42;
 * migration `0006-actions.sql`).
 *
 * This is the durable half of PLAN §5's "never replays completed actions".
 * A conversation can be rewound — `/fork`, `/tree`, resuming an older
 * session — and Pi will happily replay the turn that asked for a commit, a
 * merge or a push. The repository, however, was never rewound. The receipt
 * written here is what turns the second request into a refusal.
 *
 * Like `transition-log.ts`, these are not PLAN §5 records: a receipt has no
 * revisioned identity and is never updated, so there is no repository class
 * and no update path at all. The database enforces that with triggers.
 */
import { createHash } from "node:crypto";
import type { Database } from "./sqlite.ts";
import type { IsoTimestamp, WorkflowId } from "./records.ts";
import { canonicalJson } from "./repos/base.ts";

/** What an action was performed on. `workflow` covers plan-wide effects. */
export type ActionSubjectKind = "task" | "phase" | "workflow";

/** A receipt for an action that actually happened. Immutable once written. */
export interface CompletedAction {
  /**
   * Idempotency key, chosen by the caller **before** the action runs, from
   * facts that identify the action rather than the moment it was requested
   * (see `actionIdFor`). Two requests for the same effect share it; two
   * genuinely different effects must not.
   */
  readonly actionId: string;
  readonly recordedAt: IsoTimestamp;
  readonly workflowId: WorkflowId;
  /** Caller-defined family, e.g. `git_commit`, `git_push`, `publish`. */
  readonly kind: string;
  readonly subjectKind: ActionSubjectKind | null;
  readonly subjectId: string | null;
  /** Pi session that performed it; a fork has a different id. */
  readonly sessionId: string;
  readonly gitRevision: string | null;
  readonly approvalId: string | null;
  /** `true` when the effect left this repository (push, publish, deploy). */
  readonly externalEffect: boolean;
  readonly summary: string;
}

/** A refused re-execution, recorded so a no-op is never silent. */
export interface ActionReplayAttempt {
  readonly attemptRowId: string;
  readonly createdAt: IsoTimestamp;
  readonly actionId: string;
  readonly workflowId: WorkflowId;
  readonly sessionId: string;
  /** Stable reason code from `src/workflow/reconcile.ts`. */
  readonly reasonCode: string;
  readonly detail: string;
}

interface RawRow {
  payload: string;
}

/**
 * Append-only log of completed actions and the replays it refused.
 *
 * `record` is deliberately *not* an upsert: inserting a second receipt for an
 * `actionId` that already has one throws on the primary key, which is the
 * behaviour we want — the caller was about to perform an effect twice.
 * Callers ask `find` first, and `find` is the refusal.
 */
export class ActionLogStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Write a receipt. Throws if this `actionId` already completed. */
  record(action: CompletedAction): CompletedAction {
    this.#db
      .prepare(
        "INSERT INTO completed_action (actionId, recordedAt, workflowId, kind, subjectKind, subjectId, " +
          "sessionId, gitRevision, approvalId, externalEffect, summary, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        action.actionId,
        action.recordedAt,
        action.workflowId,
        action.kind,
        action.subjectKind,
        action.subjectId,
        action.sessionId,
        action.gitRevision,
        action.approvalId,
        action.externalEffect ? 1 : 0,
        action.summary,
        canonicalJson(action),
      );
    return action;
  }

  /** The receipt for an action id, or `undefined` if it never completed. */
  find(actionId: string): CompletedAction | undefined {
    const row = this.#db
      .prepare("SELECT payload FROM completed_action WHERE actionId = ?")
      .get(actionId) as RawRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.payload) as CompletedAction);
  }

  /** Has this exact action already been performed? */
  isCompleted(actionId: string): boolean {
    return this.find(actionId) !== undefined;
  }

  #query(where: string, params: readonly (string | number)[]): readonly CompletedAction[] {
    const rows = this.#db
      .prepare(`SELECT payload FROM completed_action ${where} ORDER BY recordedAt, rowid`)
      .all(...params) as unknown as RawRow[];
    return rows.map((row) => JSON.parse(row.payload) as CompletedAction);
  }

  /** Every completed action in one workflow, oldest first. */
  forWorkflow(workflowId: string): readonly CompletedAction[] {
    return this.#query("WHERE workflowId = ?", [workflowId]);
  }

  /** Completed actions on one subject, oldest first. */
  forSubject(subjectKind: ActionSubjectKind, subjectId: string): readonly CompletedAction[] {
    return this.#query("WHERE subjectKind = ? AND subjectId = ?", [subjectKind, subjectId]);
  }

  /**
   * Actions whose effect left this repository. These are the ones a resumed
   * or forked session can never redo on its own authority.
   */
  externalEffectsFor(workflowId: string): readonly CompletedAction[] {
    return this.#query("WHERE workflowId = ? AND externalEffect = 1", [workflowId]);
  }

  /** Record a refused replay. */
  recordReplayAttempt(attempt: ActionReplayAttempt): ActionReplayAttempt {
    this.#db
      .prepare(
        "INSERT INTO action_replay_attempt (attemptRowId, createdAt, actionId, workflowId, sessionId, " +
          "reasonCode, detail, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        attempt.attemptRowId,
        attempt.createdAt,
        attempt.actionId,
        attempt.workflowId,
        attempt.sessionId,
        attempt.reasonCode,
        attempt.detail,
        canonicalJson(attempt),
      );
    return attempt;
  }

  /** Every refused replay of one action, oldest first. */
  replayAttempts(actionId: string): readonly ActionReplayAttempt[] {
    const rows = this.#db
      .prepare("SELECT payload FROM action_replay_attempt WHERE actionId = ? ORDER BY createdAt, rowid")
      .all(actionId) as unknown as RawRow[];
    return rows.map((row) => JSON.parse(row.payload) as ActionReplayAttempt);
  }

  /** Every refused replay in one workflow, oldest first. */
  replayAttemptsForWorkflow(workflowId: string): readonly ActionReplayAttempt[] {
    const rows = this.#db
      .prepare("SELECT payload FROM action_replay_attempt WHERE workflowId = ? ORDER BY createdAt, rowid")
      .all(workflowId) as unknown as RawRow[];
    return rows.map((row) => JSON.parse(row.payload) as ActionReplayAttempt);
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM completed_action").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}

/**
 * Derive an idempotency key from what the action *is*, not when it was asked
 * for.
 *
 * Using a random id or a timestamp would defeat the entire mechanism: the
 * replayed turn would mint a fresh id and the receipt would never match. The
 * key is therefore a stable hash over the caller's identifying facts, so the
 * same effect requested twice — including from a forked conversation —
 * produces the same id.
 */
export function actionIdFor(facts: {
  readonly workflowId: string;
  readonly kind: string;
  readonly subjectId?: string | null;
  /** Anything else that distinguishes this effect: paths, refs, digests. */
  readonly discriminator?: unknown;
}): string {
  const canonical = canonicalJson({
    workflowId: facts.workflowId,
    kind: facts.kind,
    subjectId: facts.subjectId ?? null,
    discriminator: facts.discriminator ?? null,
  });
  return `act-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
