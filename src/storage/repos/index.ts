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
 *   touching a revisioned field is rejected (§5.1).
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
  Memory,
  ModelAvailability,
  ModelOutcome,
  Phase,
  RouteId,
  Task,
  Workflow,
} from "../records.ts";
import { TASK_REVISIONED_FIELDS } from "../records.ts";
import { AppendOnlyRepository, MutableRepository, type RepoContext } from "./base.ts";
import {
  approvalSpec,
  attemptSpec,
  auditEntrySpec,
  decisionSpec,
  evidenceSpec,
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
  constructor(ctx: RepoContext) {
    super(ctx, taskSpec);
  }

  forPhase(phaseId: string): readonly Task[] {
    return this.findBy("phaseId", phaseId);
  }

  protected override beforeUpdate(before: Task, candidate: Task, patch: Partial<Task>): Task {
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
