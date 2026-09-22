/**
 * Typed repositories, one per record type (issue #23).
 *
 * Append-only types (`decision`, `evidence`, `model_outcome`, `audit_entry`)
 * get an `AppendOnlyRepository`, which has no `update` or `delete` method at
 * all — the type error arrives before the trigger does.
 *
 * Mutable types get a `MutableRepository`; three of them override
 * `beforeUpdate` to enforce the record rules in docs/records.md:
 *
 * - `task`: a patch touching `goal`/`acceptanceCriteria`/`checks` must bump
 *   `revision` by exactly one; a patch that changes `revision` without
 *   touching a revisioned field is rejected (§5.1). And `status = "done"` is
 *   refused unless an unconsumed passing gate receipt exists for this task at
 *   this revision (issue #46; docs/gates.md §7 guarantee 1) — the single
 *   structural reason a worker claim, a `/korwf` command, a bash call, a
 *   resumed session or a migration cannot complete a task.
 * - `attempt`: once `outcome` is non-null the row is frozen (§4).
 * - `approval`: only `invalidation` is patchable, `null → non-null` (§4).
 */
import { RecordRuleError } from "../errors.ts";
import type {
  Approval,
  ApprovalInvalidation,
  Attempt,
  AuditEntry,
  Decision,
  Evidence,
  LedgerEntry,
  Memory,
  ModelAvailability,
  ModelOutcome,
  Phase,
  RouteId,
  Task,
  Workflow,
} from "../records.ts";
import { TASK_REVISIONED_FIELDS } from "../records.ts";
import { GateReceiptStore } from "../gate-receipts.ts";
import { AppendOnlyRepository, MutableRepository, type RepoContext } from "./base.ts";
import {
  approvalSpec,
  attemptSpec,
  auditEntrySpec,
  decisionSpec,
  evidenceSpec,
  ledgerEntrySpec,
  memorySpec,
  modelAvailabilitySpec,
  modelOutcomeSpec,
  phaseSpec,
  taskSpec,
  workflowSpec,
} from "./specs.ts";

export class WorkflowRepository extends MutableRepository<Workflow> {
  constructor(ctx: RepoContext) {
    super(ctx, workflowSpec);
  }
}

export class PhaseRepository extends MutableRepository<Phase> {
  constructor(ctx: RepoContext) {
    super(ctx, phaseSpec);
  }

  /** Phases of a workflow in plan order. */
  forWorkflow(workflowId: string): readonly Phase[] {
    return [...this.findBy("workflowId", workflowId)].sort((a, b) => a.order - b.order);
  }
}

export class TaskRepository extends MutableRepository<Task> {
  readonly #receipts: GateReceiptStore;
  /** One-shot authorisation for the next `status = done` patch. */
  #pendingReceiptId: string | null = null;

  constructor(ctx: RepoContext) {
    super(ctx, taskSpec);
    this.#receipts = new GateReceiptStore(ctx.db);
  }

  forPhase(phaseId: string): readonly Task[] {
    return this.findBy("phaseId", phaseId);
  }

  /**
   * Present a passing gate receipt to authorise **one** `status = done`
   * patch, and consume it (issue #46; docs/gates.md §7 guarantee 1).
   *
   * Callers do not get to say "this task is done"; they get to say "this
   * receipt says so", and the store checks the receipt. The authorisation is
   * cleared by the very next update whatever its outcome, so it cannot leak
   * into a later, unrelated patch.
   *
   * Returns the receipt id on success; throws when the receipt does not
   * exist, is a rejection, was already consumed, or belongs to another task
   * or another task revision.
   */
  authoriseDone(receiptId: string): string {
    return this.ctx.write(() => {
      const receipt = this.#receipts.find(receiptId);
      if (receipt === undefined || receipt.gate !== "task" || receipt.disposition !== "pass") {
        this.reject(
          `status_write_forbidden: receipt ${receiptId} is not a passing task-gate receipt (docs/gates.md §7)`,
        );
      }
      const task = this.require(receipt.subjectId);
      if (receipt.subjectRevision !== task.revision) {
        this.reject(
          `status_write_forbidden: receipt ${receiptId} was issued at task revision ` +
            `${receipt.subjectRevision}, task ${task.id} is at ${task.revision}`,
        );
      }
      if (!this.#receipts.consume(receiptId, this.ctx.now())) {
        this.reject(`status_write_forbidden: gate receipt ${receiptId} was already used`);
      }
      this.#pendingReceiptId = receiptId;
      return receiptId;
    });
  }

  protected override beforeUpdate(before: Task, candidate: Task, patch: Partial<Task>): Task {
    const authorisation = this.#pendingReceiptId;
    this.#pendingReceiptId = null;
    if (patch.status === "done" && before.status !== "done") {
      if (authorisation === null) {
        this.reject(
          `status_write_forbidden: task ${before.id} may only become "done" through a passing ` +
            `task-gate receipt (PLAN §2.4, docs/gates.md §7). A claim is not a receipt.`,
        );
      }
      const receipt = this.#receipts.find(authorisation);
      if (receipt === undefined || receipt.subjectId !== before.id || receipt.subjectRevision !== before.revision) {
        this.reject(`status_write_forbidden: gate receipt ${authorisation} does not authorise task ${before.id}`);
      }
    }
    const touchesRevisioned = TASK_REVISIONED_FIELDS.some((field) => field in patch);
    const revisionChanged = "revision" in patch && patch.revision !== before.revision;
    if (touchesRevisioned && candidate.revision !== before.revision + 1) {
      this.reject(
        `task ${before.id}: changing ${TASK_REVISIONED_FIELDS.join("/")} requires revision ` +
          `${before.revision + 1}, got ${candidate.revision} (docs/records.md §5.1)`,
      );
    }
    if (!touchesRevisioned && revisionChanged) {
      this.reject(
        `task ${before.id}: revision may only change together with ` +
          `${TASK_REVISIONED_FIELDS.join("/")} (docs/records.md §5.1)`,
      );
    }
    return candidate;
  }
}

export class AttemptRepository extends MutableRepository<Attempt> {
  constructor(ctx: RepoContext) {
    super(ctx, attemptSpec);
  }

  /** Attempts with no outcome: what startup reconciliation examines. */
  open(): readonly Attempt[] {
    return this.query("WHERE outcome IS NULL", []);
  }

  forTask(taskId: string): readonly Attempt[] {
    return this.findBy("taskId", taskId);
  }

  protected override beforeUpdate(before: Attempt, candidate: Attempt): Attempt {
    if (before.outcome !== null) {
      this.reject(
        `attempt ${before.id} is frozen: its outcome is already "${before.outcome}" ` +
          `(docs/records.md §4). Record a new attempt instead.`,
      );
    }
    return candidate;
  }
}

export class ApprovalRepository extends MutableRepository<Approval> {
  constructor(ctx: RepoContext) {
    super(ctx, approvalSpec);
  }

  /** The only supported mutation: mark an approval invalid. */
  invalidate(id: string, invalidation: ApprovalInvalidation): Approval {
    return this.update(id, { invalidation });
  }

  protected override beforeUpdate(before: Approval, candidate: Approval, patch: Partial<Approval>): Approval {
    const keys = Object.keys(patch);
    if (keys.some((key) => key !== "invalidation")) {
      this.reject(
        `approval ${before.id}: only \`invalidation\` is patchable, got ${keys.join(", ")} ` +
          `(docs/records.md §4)`,
      );
    }
    if (before.invalidation !== null) {
      this.reject(`approval ${before.id} is already invalidated; invalidation is never cleared or changed.`);
    }
    if (candidate.invalidation === null) {
      this.reject(`approval ${before.id}: invalidation may only move from null to a reason.`);
    }
    return candidate;
  }
}

export class MemoryRepository extends MutableRepository<Memory> {
  constructor(ctx: RepoContext) {
    super(ctx, memorySpec);
  }

  forWorkflow(workflowId: string): readonly Memory[] {
    return this.findBy("workflowId", workflowId);
  }
}

export class ModelAvailabilityRepository extends MutableRepository<ModelAvailability> {
  constructor(ctx: RepoContext) {
    super(ctx, modelAvailabilitySpec);
  }

  /** One row per route (#125), not per model id. */
  byRoute(routeId: RouteId | string): ModelAvailability | undefined {
    return this.findBy("routeId", String(routeId))[0];
  }

  /** Every route currently exposing this model id, across providers (#125). */
  byModelId(modelId: string): readonly ModelAvailability[] {
    return this.findBy("modelId", modelId);
  }

  /** Insert or patch the row for a route. The route id is the upsert key. */
  upsert(record: ModelAvailability): ModelAvailability {
    const existing = this.byRoute(record.routeId);
    if (existing === undefined) return this.insert(record);
    return this.update(existing.id, {
      providerId: record.providerId,
      modelId: record.modelId,
      capKind: record.capKind,
      detectedAt: record.detectedAt,
      estimatedReset: record.estimatedReset,
      lastProbe: record.lastProbe,
    });
  }
}

export class DecisionRepository extends AppendOnlyRepository<Decision> {
  constructor(ctx: RepoContext) {
    super(ctx, decisionSpec);
  }

  /** Cache lookup: the recorded answer for this exact question + state. */
  byStateHash(questionId: string, stateHash: string): readonly Decision[] {
    return this.query("WHERE questionId = ? AND stateHash = ?", [questionId, stateHash]);
  }
}

export class EvidenceRepository extends AppendOnlyRepository<Evidence> {
  constructor(ctx: RepoContext) {
    super(ctx, evidenceSpec);
  }

  /** Evidence produced against one exact task revision. */
  forTaskRevision(taskId: string, taskRevision: number): readonly Evidence[] {
    return this.query("WHERE taskId = ? AND taskRevision = ?", [taskId, taskRevision]);
  }
}

export class ModelOutcomeRepository extends AppendOnlyRepository<ModelOutcome> {
  constructor(ctx: RepoContext) {
    super(ctx, modelOutcomeSpec);
  }

  /** Outcomes attributed to one route (#125): one account never biases another. */
  forRoute(routeId: RouteId | string): readonly ModelOutcome[] {
    return this.findBy("routeId", String(routeId));
  }
}

/** Columns a scope filter may key on. Fixed set; never interpolated from input. */
export type LedgerScopeColumn = "workflowId" | "phaseId" | "taskId" | "attemptId";

/** Summed amounts over a set of ledger rows. `spendUsd` excludes unknown-cost rows. */
export interface LedgerTotals {
  readonly requests: number;
  readonly tokens: number;
  readonly spendUsd: number;
  readonly elapsedMs: number;
  /** Rows whose cost basis is `unknown`: counted, never valued at zero. */
  readonly unknownCostRequests: number;
  /** Rows whose spend came from a pre-call estimate rather than the provider. */
  readonly estimatedRequests: number;
  readonly estimatedSpendUsd: number;
  readonly knownSpendUsd: number;
}

const ZERO_TOTALS: LedgerTotals = {
  requests: 0,
  tokens: 0,
  spendUsd: 0,
  elapsedMs: 0,
  unknownCostRequests: 0,
  estimatedRequests: 0,
  estimatedSpendUsd: 0,
  knownSpendUsd: 0,
};

/**
 * The append-only usage ledger (issue #30).
 *
 * Reads here are the *only* way budget state is derived: there is no running
 * counter to drift. `outstanding` + `settled` is what a scope has committed.
 */
export class LedgerRepository extends AppendOnlyRepository<LedgerEntry> {
  constructor(ctx: RepoContext) {
    super(ctx, ledgerEntrySpec);
  }

  /**
   * Every row of one reservation's life, in insertion order.
   *
   * Ordered by `rowid` rather than `createdAt, id`: a reservation and its
   * settlement are frequently written within the same millisecond, and an id
   * is opaque, so a timestamp tie must not be broken by lexical id order.
   * `rowid` is SQLite's own monotonic insertion counter.
   */
  forReservation(reservationId: string): readonly LedgerEntry[] {
    const rows = this.ctx.db
      .prepare("SELECT payload FROM ledger_entry WHERE reservationId = ? ORDER BY rowid")
      .all(reservationId) as unknown as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as LedgerEntry);
  }

  /** Reservations with no terminal row yet: what reconciliation examines. */
  openReservations(): readonly LedgerEntry[] {
    return this.query(
      "WHERE entryKind = 'reservation' AND reservationId NOT IN " +
        "(SELECT reservationId FROM ledger_entry WHERE entryKind <> 'reservation')",
      [],
    );
  }

  /**
   * Totals committed against a scope: settled/abandoned actuals plus the
   * estimates of reservations that are still open. Released reservations
   * contribute nothing. Read inside the caller's write transaction so the
   * number cannot change between the check and the insert.
   */
  committedTotals(column: LedgerScopeColumn, id: string, channel?: LedgerEntry["channel"]): LedgerTotals {
    const openClause =
      "(entryKind = 'reservation' AND reservationId NOT IN " +
      "(SELECT reservationId FROM ledger_entry WHERE entryKind <> 'reservation'))";
    const where =
      `WHERE "${column}" = ? ${channel === undefined ? "" : "AND channel = ? "}` +
      `AND (entryKind IN ('settlement', 'abandonment') OR ${openClause})`;
    const params = channel === undefined ? [id] : [id, channel];
    return this.sum(where, params);
  }

  /** Reservations open against a scope right now; this is the concurrency count. */
  openCount(column: LedgerScopeColumn, id: string, channel?: LedgerEntry["channel"]): number {
    const sql =
      `SELECT COUNT(*) AS n FROM ledger_entry WHERE "${column}" = ? ` +
      `${channel === undefined ? "" : "AND channel = ? "}` +
      "AND entryKind = 'reservation' AND reservationId NOT IN " +
      "(SELECT reservationId FROM ledger_entry WHERE entryKind <> 'reservation')";
    const params = channel === undefined ? [id] : [id, channel];
    const row = this.ctx.db.prepare(sql).get(...params) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Sum the amount columns over an arbitrary (internally built) WHERE clause. */
  private sum(where: string, params: readonly (string | number)[]): LedgerTotals {
    const row = this.ctx.db
      .prepare(
        "SELECT " +
          "COALESCE(SUM(requests), 0) AS requests, " +
          "COALESCE(SUM(COALESCE(inputTokens, 0) + COALESCE(outputTokens, 0)), 0) AS tokens, " +
          "COALESCE(SUM(COALESCE(spendUsd, 0)), 0) AS spendUsd, " +
          "COALESCE(SUM(elapsedMs), 0) AS elapsedMs, " +
          "COALESCE(SUM(CASE WHEN costBasis = 'unknown' THEN requests ELSE 0 END), 0) AS unknownCostRequests, " +
          "COALESCE(SUM(CASE WHEN costBasis = 'estimated' THEN requests ELSE 0 END), 0) AS estimatedRequests, " +
          "COALESCE(SUM(CASE WHEN costBasis = 'estimated' THEN spendUsd ELSE 0 END), 0) AS estimatedSpendUsd, " +
          "COALESCE(SUM(CASE WHEN costBasis = 'known' THEN spendUsd ELSE 0 END), 0) AS knownSpendUsd " +
          `FROM ledger_entry ${where}`,
      )
      .get(...params) as Record<string, number> | undefined;
    if (row === undefined) return ZERO_TOTALS;
    return {
      requests: Number(row["requests"] ?? 0),
      tokens: Number(row["tokens"] ?? 0),
      spendUsd: Number(row["spendUsd"] ?? 0),
      elapsedMs: Number(row["elapsedMs"] ?? 0),
      unknownCostRequests: Number(row["unknownCostRequests"] ?? 0),
      estimatedRequests: Number(row["estimatedRequests"] ?? 0),
      estimatedSpendUsd: Number(row["estimatedSpendUsd"] ?? 0),
      knownSpendUsd: Number(row["knownSpendUsd"] ?? 0),
    };
  }
}

export class AuditRepository extends AppendOnlyRepository<AuditEntry> {
  constructor(ctx: RepoContext) {
    super(ctx, auditEntrySpec);
  }

  /** Audit trail for one record, oldest first. */
  forRecord(table: string, recordId: string): readonly AuditEntry[] {
    return this.query("WHERE tableName = ? AND recordId = ?", [table, recordId]);
  }
}

export { AppendOnlyRepository, MutableRepository, RecordRuleError };
export type { RepoContext };
