/**
 * `TableSpec` for each of the eleven record types (issue #23).
 *
 * The indexed/foreign-key columns listed here must match
 * `migrations/0001-initial.sql`; `test/unit/storage/schema.test.ts` asserts
 * that they do, so a migration and a spec cannot drift apart.
 */
import type {
  Approval,
  Attempt,
  AuditEntry,
  Decision,
  Evidence,
  LedgerEntry,
  Memory,
  ModelAvailability,
  ModelOutcome,
  Phase,
  Task,
  Workflow,
} from "../records.ts";
import type { TableSpec } from "./base.ts";

export const workflowSpec: TableSpec<Workflow> = {
  table: "workflow",
  appendOnly: false,
  columns: ["status", "mode", "planRevision"],
  extract: (r) => ({ status: r.status, mode: r.mode, planRevision: r.planRevision }),
  workflowIdOf: (r) => r.id,
};

export const phaseSpec: TableSpec<Phase> = {
  table: "phase",
  appendOnly: false,
  columns: ["workflowId", "order", "gateStatus"],
  extract: (r) => ({ workflowId: r.workflowId, order: r.order, gateStatus: r.gateStatus }),
  workflowIdOf: (r) => r.workflowId,
};

export const taskSpec: TableSpec<Task> = {
  table: "task",
  appendOnly: false,
  columns: ["workflowId", "phaseId", "revision", "status", "riskClass"],
  extract: (r) => ({
    workflowId: r.workflowId,
    phaseId: r.phaseId,
    revision: r.revision,
    status: r.status,
    riskClass: r.riskClass,
  }),
  workflowIdOf: (r) => r.workflowId,
};

export const attemptSpec: TableSpec<Attempt> = {
  table: "attempt",
  appendOnly: false,
  columns: ["taskId", "taskRevision", "workerId", "role", "outcome", "handedOffFromAttemptId"],
  extract: (r) => ({
    taskId: r.taskId,
    taskRevision: r.taskRevision,
    workerId: r.workerId,
    role: r.role,
    outcome: r.outcome,
    handedOffFromAttemptId: r.handedOffFromAttemptId,
  }),
  workflowIdOf: () => null,
};

export const decisionSpec: TableSpec<Decision> = {
  table: "decision",
  appendOnly: true,
  columns: ["workflowId", "subjectTaskId", "subjectPhaseId", "stateHash", "questionId", "questionVersion"],
  extract: (r) => ({
    workflowId: r.workflowId,
    subjectTaskId: r.subject !== null && "taskId" in r.subject ? r.subject.taskId : null,
    subjectPhaseId: r.subject !== null && "phaseId" in r.subject ? r.subject.phaseId : null,
    stateHash: r.stateHash,
    questionId: r.questionId,
    questionVersion: r.questionVersion,
  }),
  workflowIdOf: (r) => r.workflowId,
};

export const evidenceSpec: TableSpec<Evidence> = {
  table: "evidence",
  appendOnly: true,
  columns: ["workflowId", "taskId", "taskRevision", "attemptId", "supersedesId", "requirementId", "checkId"],
  extract: (r) => ({
    workflowId: r.workflowId,
    taskId: r.taskId,
    taskRevision: r.taskRevision,
    attemptId: r.attemptId,
    supersedesId: r.supersedesId,
    requirementId: r.requirementId,
    checkId: r.checkId,
  }),
  workflowIdOf: (r) => r.workflowId,
};

export const approvalSpec: TableSpec<Approval> = {
  table: "approval",
  appendOnly: false,
  columns: ["workflowId", "scopeKind", "scopeTaskId", "scopePhaseId", "taskRevision", "planRevision", "riskClass", "invalidated"],
  extract: (r) => ({
    workflowId: r.workflowId,
    scopeKind: r.scope.kind,
    scopeTaskId: r.scope.kind === "task" ? r.scope.taskId : null,
    scopePhaseId: r.scope.kind === "phase" ? r.scope.phaseId : null,
    taskRevision: r.taskRevision,
    planRevision: r.planRevision,
    riskClass: r.riskClass,
    invalidated: r.invalidation === null ? 0 : 1,
  }),
  workflowIdOf: (r) => r.workflowId,
};

export const memorySpec: TableSpec<Memory> = {
  table: "memory",
  appendOnly: false,
  columns: ["workflowId", "sourceAttemptId", "sourceDecisionId", "supersededById", "supersedesId", "type", "status", "pinned"],
  extract: (r) => ({
    workflowId: r.workflowId,
    sourceAttemptId: r.source.kind === "summary" ? r.source.attemptId : null,
    sourceDecisionId: r.source.kind === "decision" ? r.source.decisionId : null,
    supersededById: r.supersession.supersededById,
    supersedesId: r.supersession.supersedesId,
    type: r.type,
    status: r.status,
    pinned: r.pinned ? 1 : 0,
  }),
  workflowIdOf: (r) => r.workflowId,
};

export const modelAvailabilitySpec: TableSpec<ModelAvailability> = {
  table: "model_availability",
  appendOnly: false,
  columns: ["routeId", "providerId", "modelId", "capKind"],
  extract: (r) => ({
    routeId: r.routeId,
    providerId: r.providerId,
    modelId: r.modelId,
    capKind: r.capKind,
  }),
  workflowIdOf: () => null,
};

export const modelOutcomeSpec: TableSpec<ModelOutcome> = {
  table: "model_outcome",
  appendOnly: true,
  columns: ["workflowId", "attemptId", "routeId", "model", "result"],
  extract: (r) => ({
    workflowId: r.workflowId,
    attemptId: r.attemptId,
    routeId: r.routeId,
    model: r.model,
    result: r.result,
  }),
  workflowIdOf: (r) => r.workflowId,
};

export const ledgerEntrySpec: TableSpec<LedgerEntry> = {
  table: "ledger_entry",
  appendOnly: true,
  columns: [
    "workflowId",
    "phaseId",
    "taskId",
    "attemptId",
    "channel",
    "entryKind",
    "reservationId",
    "sessionId",
    "requests",
    "inputTokens",
    "outputTokens",
    "spendUsd",
    "costBasis",
    "elapsedMs",
  ],
  extract: (r) => ({
    workflowId: r.scope.workflowId,
    phaseId: r.scope.phaseId,
    taskId: r.scope.taskId,
    attemptId: r.scope.attemptId,
    channel: r.channel,
    entryKind: r.entryKind,
    reservationId: r.reservationId,
    sessionId: r.sessionId,
    requests: r.usage.requests,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    spendUsd: r.usage.spendUsd,
    costBasis: r.usage.costBasis,
    elapsedMs: r.elapsedMs,
  }),
  workflowIdOf: (r) => r.scope.workflowId,
};

export const auditEntrySpec: TableSpec<AuditEntry> = {
  table: "audit_entry",
  appendOnly: true,
  columns: ["workflowId", "tableName", "recordId", "operation", "actor"],
  extract: (r) => ({
    workflowId: r.workflowId,
    tableName: r.table,
    recordId: r.recordId,
    operation: r.operation,
    actor: r.actor,
  }),
  workflowIdOf: (r) => r.workflowId,
};

/** Every spec, keyed by table name; used by the schema-drift test. */
export const TABLE_SPECS = {
  workflow: workflowSpec,
  phase: phaseSpec,
  task: taskSpec,
  attempt: attemptSpec,
  decision: decisionSpec,
  evidence: evidenceSpec,
  approval: approvalSpec,
  memory: memorySpec,
  model_availability: modelAvailabilitySpec,
  model_outcome: modelOutcomeSpec,
  ledger_entry: ledgerEntrySpec,
  audit_entry: auditEntrySpec,
} as const;
