/**
 * Compile-time tests for src/storage/records.ts (issue #12).
 *
 * These are type-level assertions: the file must typecheck under `--strict`.
 * Each block names the acceptance criterion it exercises. No runtime, no I/O.
 */
import { describe, it, expect } from "vitest";
import {
  APPEND_ONLY_TABLES,
  MUTABLE_TABLES,
  FOREIGN_KEYS,
  approvalInvalidReason,
  isApprovalValid,
  type Approval,
  type AppendOnlyTable,
  type Attempt,
  type Decision,
  type Evidence,
  type Memory,
  type ModelAvailability,
  type ModelOutcome,
  type Phase,
  type RecordTable,
  type Task,
  type UpdatePatch,
  type Workflow,
  type AuditEntry,
} from "../../src/storage/records.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type HasKeys<T, K extends readonly (keyof T)[]> = K[number] extends keyof T ? true : false;

// ---------------------------------------------------------------------------
// AC1: every field listed in PLAN §5 for every record is present
// ---------------------------------------------------------------------------
type _Envelope = Assert<HasKeys<Workflow, ["id", "createdAt", "updatedAt", "schemaVersion"]>>;
type _Workflow = Assert<
  HasKeys<Workflow, ["goal", "repoIdentity", "baseRevision", "exclusions", "mode", "budgets", "policyVersion", "sessionRefs"]>
>;
type _Phase = Assert<
  HasKeys<Phase, ["id", "order", "goal", "acceptanceCriteria", "budgetCap", "integrationPoint", "gateStatus", "report"]>
>;
type _Task = Assert<
  HasKeys<
    Task,
    ["id", "revision", "phaseId", "goal", "dependencies", "ownership", "acceptanceCriteria", "checks", "riskClass", "status"]
  >
>;
type _Attempt = Assert<
  HasKeys<
    Attempt,
    [
      "workerId",
      "taskProfile",
      "requestedModel",
      "usedModel",
      "fallbackReason",
      "profile",
      "inputs",
      "worktree",
      "timestamps",
      "usage",
      "outcome",
      "artifacts",
    ]
  >
>;
type _Decision = Assert<
  HasKeys<
    Decision,
    ["stateHash", "questionVersion", "jevModelVersion", "rawDistribution", "confidence", "policyRule", "action", "override", "freshness"]
  >
>;
type _Evidence = Assert<
  HasKeys<
    Evidence,
    ["requirementId", "checkId", "artifact", "revision", "commandIdentity", "exitStatus", "reviewer", "caveats", "provenance"]
  >
>;
type _Approval = Assert<
  HasKeys<Approval, ["actor", "scope", "taskRevision", "planRevision", "permittedAction", "expiresAt", "invalidation"]>
>;
type _Memory = Assert<HasKeys<Memory, ["source", "revision", "type", "freshness", "supersession", "status"]>>;
type _ModelAvailability = Assert<
  HasKeys<ModelAvailability, ["routeId", "providerId", "modelId", "capKind", "detectedAt", "estimatedReset", "lastProbe"]>
>;
type _ModelOutcome = Assert<HasKeys<ModelOutcome, ["routeId", "model", "taskProfile", "result", "cost", "latencyMs"]>>;

// Provenance fields (PLAN §3.B) on Evidence and Memory sources.
type _ProvenanceFields = Assert<
  HasKeys<Evidence["provenance"][number], ["revision", "path", "range", "retrievalMethod", "contentHash"]>
>;
type _MemoryExcerptProvenance = Assert<
  HasKeys<Extract<Memory["source"], { kind: "excerpt" }>["provenance"], ["revision", "path", "range", "retrievalMethod", "contentHash"]>
>;

// ---------------------------------------------------------------------------
// AC2: approval invalidation on revision change is expressed in the types
// ---------------------------------------------------------------------------
type _TaskRevisionIsNumber = Assert<Equal<Task["revision"], number>>;
type _ApprovalTaskRevision = Assert<Equal<Approval["taskRevision"], number | null>>;
type _ApprovalPlanRevision = Assert<Equal<Approval["planRevision"], number>>;
type _InvalidationReasonIncludesRevision = Assert<
  "task_revision_changed" extends NonNullable<Approval["invalidation"]>["reason"] ? true : false
>;

// Runtime helper behaves deterministically (checked at type level via literal returns).
const approval: Pick<Approval, "scope" | "taskRevision" | "planRevision" | "expiresAt" | "invalidation"> = {
  scope: { kind: "task", taskId: "t1" as Task["id"] },
  taskRevision: 3,
  planRevision: 1,
  expiresAt: null,
  invalidation: null,
};
const sameRevision = isApprovalValid(approval, {
  task: { id: "t1" as Task["id"], revision: 3 },
  planRevision: 1,
  now: "2026-09-21T00:00:00.000Z",
});
const movedRevision = approvalInvalidReason(approval, {
  task: { id: "t1" as Task["id"], revision: 4 },
  planRevision: 1,
  now: "2026-09-21T00:00:00.000Z",
});
if (sameRevision !== true) throw new Error("approval must be valid at the same revision");
if (movedRevision !== "task_revision_changed") throw new Error("approval must be invalid after revision bump");

// ---------------------------------------------------------------------------
// AC3: append-only records have no update path in the type design
// ---------------------------------------------------------------------------
type _NoDecisionPatch = Assert<Equal<UpdatePatch<Decision>, never>>;
type _NoEvidencePatch = Assert<Equal<UpdatePatch<Evidence>, never>>;
type _NoModelOutcomePatch = Assert<Equal<UpdatePatch<ModelOutcome>, never>>;
type _NoAuditPatch = Assert<Equal<UpdatePatch<AuditEntry>, never>>;
type _TaskPatchExists = Assert<Equal<UpdatePatch<Task>, never> extends true ? false : true>;
type _AppendOnlyTables = Assert<Equal<AppendOnlyTable, "decision" | "evidence" | "model_outcome" | "audit_entry">>;

// The constant tables together cover every RecordTable exactly once.
type _Partition = Assert<
  Equal<(typeof APPEND_ONLY_TABLES)[number] | (typeof MUTABLE_TABLES)[number], RecordTable>
>;

// Every FK targets a known table (checked by the ForeignKey type) and the list is non-empty.
if (FOREIGN_KEYS.length === 0) throw new Error("FOREIGN_KEYS must not be empty");

describe("storage record type assertions (issue #12 compile-time acceptance criteria)", () => {
  it("type-level assertions compile and runtime helper smoke checks pass", () => {
    expect(sameRevision).toBe(true);
    expect(movedRevision).toBe("task_revision_changed");
    expect(FOREIGN_KEYS.length).toBeGreaterThan(0);
  });
});
