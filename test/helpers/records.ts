/**
 * Valid sample rows for every persistent record type (issue #23).
 *
 * The store round-trip tests (acceptance criterion "all ten record types
 * round-trip" — eleven with `audit_entry`, twelve with `ledger_entry` from
 * #30) build a complete, foreign-key consistent workflow from these factories. Every value is fabricated; no
 * machine paths, no provider names, no credentials.
 */
import type {
  Approval,
  ApprovalId,
  Attempt,
  AttemptId,
  Decision,
  DecisionId,
  Evidence,
  EvidenceId,
  LedgerEntry,
  LedgerEntryId,
  Memory,
  MemoryId,
  ModelAvailability,
  ModelAvailabilityId,
  ModelOutcome,
  ModelOutcomeId,
  Phase,
  ReservationId,
  PhaseId,
  Provenance,
  RouteId,
  Task,
  TaskId,
  TaskProfile,
  Usage,
  Workflow,
  WorkflowId,
} from "../../src/storage/records.ts";
import { RECORDS_SCHEMA_VERSION } from "../../src/storage/records.ts";

export const AT = "2026-01-01T00:00:00.000Z";
export const SHA = "a".repeat(40);
export const HASH = "b".repeat(64);

const usage: Usage = {
  inputTokens: 100,
  outputTokens: 50,
  requests: 1,
  spendUsd: null,
  costBasis: "unknown",
};

const profile: TaskProfile = {
  domain: "backend",
  modalities: ["text"],
  reasoningDepth: 0.5,
  contextSize: 0.4,
  risk: "low",
};

const provenance: Provenance = {
  revision: SHA,
  path: "src/example.ts",
  range: { startLine: 1, endLine: 10 },
  retrievalMethod: "explicit",
  contentHash: HASH,
};

export function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1" as WorkflowId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    goal: "Add a feature",
    repoIdentity: { remoteUrl: null, rootCommit: SHA, name: "sample" },
    baseRevision: SHA,
    exclusions: [],
    mode: "supervised",
    budgets: { maxSpendUsd: null, maxTokens: null, maxRequests: null, maxConcurrency: 2, maxElapsedMs: null },
    policyVersion: "1",
    sessionRefs: { coordinatorSessionId: "session-1", workerSessionIds: [] },
    planRevision: 1,
    status: "planning",
    ...overrides,
  };
}

export function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    id: "ph-1" as PhaseId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    workflowId: "wf-1" as WorkflowId,
    order: 0,
    goal: "Scaffold",
    acceptanceCriteria: [{ id: "ac-1", text: "It builds" }],
    budgetCap: { maxSpendUsd: null, maxTokens: null, maxRequests: null, maxConcurrency: 1, maxElapsedMs: null },
    integrationPoint: { branch: "korwf/phase-0", baseRevision: SHA },
    gateStatus: "pending",
    report: null,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "tk-1" as TaskId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    workflowId: "wf-1" as WorkflowId,
    phaseId: "ph-1" as PhaseId,
    revision: 1,
    goal: "Write the thing",
    dependencies: [],
    ownership: { paths: ["src/example.ts"], components: ["example"] },
    acceptanceCriteria: [{ id: "ac-1", text: "It builds" }],
    checks: [
      {
        id: "chk-1",
        kind: "command",
        command: "npm test",
        cwd: ".",
        expectedExitCode: 0,
        coversCriteria: ["ac-1"],
        required: true,
      },
    ],
    riskClass: "low",
    status: "ready",
    blocker: null,
    ...overrides,
  };
}

export function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "at-1" as AttemptId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    taskId: "tk-1" as TaskId,
    taskRevision: 1,
    workerId: "worker-1",
    role: "implementer",
    taskProfile: profile,
    requestedModel: "example-provider/example-model",
    usedModel: "example-provider/example-model",
    fallbackReason: null,
    profile: "implementer-default",
    inputs: {
      taskRevision: 1,
      contextProvenance: [provenance],
      pinnedPaths: [],
      skills: [],
      bundleHash: HASH,
    },
    worktree: { relativePath: "wt/tk-1", branch: "korwf/tk-1", baseRevision: SHA },
    timestamps: { startedAt: AT, endedAt: null, lastActivityAt: AT },
    usage,
    outcome: null,
    artifacts: [],
    handedOffFromAttemptId: null,
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dc-1" as DecisionId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "append_only",
    workflowId: "wf-1" as WorkflowId,
    subject: { taskId: "tk-1" as TaskId, taskRevision: 1 },
    stateHash: HASH,
    questionId: "task_ready",
    questionVersion: "1.0.0",
    jevModelVersion: null,
    rawDistribution: { yes: 0.8, no: 0.2 },
    confidence: null,
    policyRule: "deterministic_fallback",
    action: "proceed",
    override: null,
    freshness: { revision: SHA, decidedAt: AT, expiresAt: null },
    usage,
    latencyMs: null,
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev-1" as EvidenceId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "append_only",
    workflowId: "wf-1" as WorkflowId,
    taskId: "tk-1" as TaskId,
    taskRevision: 1,
    attemptId: "at-1" as AttemptId,
    requirementId: "ac-1",
    checkId: "chk-1",
    artifact: null,
    revision: SHA,
    commandIdentity: { command: "npm test", cwd: ".", environmentHash: HASH },
    exitStatus: { kind: "exited", code: 0 },
    reviewer: { kind: "deterministic" },
    caveats: [],
    provenance: [provenance],
    supersedesId: null,
    ...overrides,
  };
}

export function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "ap-1" as ApprovalId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    workflowId: "wf-1" as WorkflowId,
    actor: { kind: "user", identity: "owner" },
    scope: { kind: "task", taskId: "tk-1" as TaskId },
    taskRevision: 1,
    planRevision: 1,
    permittedAction: "apply_changes",
    riskClass: "low",
    expiresAt: null,
    invalidation: null,
    ...overrides,
  };
}

export function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mm-1" as MemoryId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    workflowId: "wf-1" as WorkflowId,
    source: { kind: "excerpt", provenance },
    revision: SHA,
    type: "durable_decision",
    content: "The store has one writer.",
    contentHash: HASH,
    freshness: { observedAt: AT, staleAfter: null, lastValidatedAt: null },
    supersession: { supersededById: null, supersedesId: null },
    status: "active",
    pinned: true,
    ...overrides,
  };
}

export function makeModelAvailability(overrides: Partial<ModelAvailability> = {}): ModelAvailability {
  return {
    id: "ma-1" as ModelAvailabilityId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "mutable",
    routeId: "route-a" as RouteId,
    providerId: "provider-a",
    modelId: "example-model",
    capKind: "none",
    detectedAt: null,
    estimatedReset: null,
    lastProbe: null,
    ...overrides,
  };
}

export function makeLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "le-1" as LedgerEntryId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "append_only",
    scope: {
      workflowId: "wf-1" as WorkflowId,
      phaseId: "ph-1" as PhaseId,
      taskId: "tk-1" as TaskId,
      attemptId: "at-1" as AttemptId,
    },
    channel: "model",
    entryKind: "reservation",
    reservationId: "rsv-1" as ReservationId,
    sessionId: "session-1",
    // Default fixture is an unknown-cost call: the honest default (#30).
    usage,
    elapsedMs: 0,
    label: null,
    reason: null,
    ...overrides,
  };
}

export function makeModelOutcome(overrides: Partial<ModelOutcome> = {}): ModelOutcome {
  return {
    id: "mo-1" as ModelOutcomeId,
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "append_only",
    workflowId: "wf-1" as WorkflowId,
    attemptId: "at-1" as AttemptId,
    routeId: "route-a" as RouteId,
    model: "example-provider/example-model",
    taskProfile: profile,
    result: "succeeded",
    cost: usage,
    latencyMs: 1234,
    wasFallback: false,
    ...overrides,
  };
}
