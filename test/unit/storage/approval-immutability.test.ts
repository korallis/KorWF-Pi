/**
 * The `approval` table's database-level immutability (migration
 * `0011-approval-immutability.sql`, found by issue #55).
 *
 * `src/workflow/approvals.ts` and `ApprovalRepository` already refuse every
 * patch but `invalidation`. Those guards live in *this process*. The Stage 4
 * adversarial suite found that nothing below them held: a raw
 * `UPDATE approval SET payload = ...` re-pinned a granted approval to a new
 * task revision, and `DELETE FROM approval` erased the record entirely —
 * while the sibling `approval_request` table (0009) had exactly these
 * triggers all along.
 *
 * These tests assert the *database* properties, so the guarantee survives a
 * caller that bypasses `src/workflow/` completely.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { latestSchemaVersion, loadMigrations } from "../../../src/storage/migrations.ts";
import type { Approval, ApprovalId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

function freshStore(): Store {
  const dir = makeTempDir("korwf-approval-immutability-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `id-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "review", revision: 1 }));
  return store;
}

function granted(store: Store, overrides: Partial<Approval> = {}): Approval {
  return store.approvals.insert(
    makeApproval({
      id: `ap-${(counter += 1)}` as ApprovalId,
      workflowId: WF,
      actor: { kind: "user", identity: "owner" },
      scope: { kind: "task", taskId: TK },
      taskRevision: 1,
      planRevision: 1,
      permittedAction: "complete_task",
      riskClass: "high",
      ...overrides,
    }),
  );
}

/** Read the stored payload JSON for an approval. */
function payloadOf(store: Store, id: string): Record<string, unknown> {
  const row = store.connection.prepare("SELECT payload FROM approval WHERE id = ?").get(id) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

/** Write a mutated payload back over raw SQL. */
function writePayload(store: Store, id: string, mutate: (p: Record<string, unknown>) => void): void {
  const payload = payloadOf(store, id);
  mutate(payload);
  store.connection.prepare("UPDATE approval SET payload = ? WHERE id = ?").run(JSON.stringify(payload), id);
}

describe("the approval migration is shipped and ordered", () => {
  it("0011 is a loaded, gap-free migration", () => {
    const migrations = loadMigrations();
    const mine = migrations.find((m) => m.fileName.endsWith("-approval-immutability.sql"));
    expect(mine).toBeDefined();
    expect(mine?.version).toBeLessThanOrEqual(latestSchemaVersion());
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_m, i) => i + 1));
  });
});

describe("an approval's scope and revisions are immutable, even through raw SQL", () => {
  it("the indexed columns cannot be re-pinned", () => {
    const store = freshStore();
    const approval = granted(store);
    expect(() => store.connection.exec("UPDATE approval SET taskRevision = 2")).toThrow(/immutable/);
    expect(() => store.connection.exec("UPDATE approval SET planRevision = 2")).toThrow(/immutable/);
    expect(() => store.connection.exec("UPDATE approval SET riskClass = 'low'")).toThrow(/immutable/);
    expect(() => store.connection.exec("UPDATE approval SET scopeTaskId = NULL")).toThrow(/immutable/);
    expect(() => store.connection.exec("UPDATE approval SET scopeKind = 'phase'")).toThrow(/immutable/);
    expect(() => store.connection.exec("UPDATE approval SET workflowId = 'wf-other'")).toThrow(/immutable/);
    expect(store.approvals.require(approval.id).taskRevision).toBe(1);
  });

  it("the payload — what the repositories actually read — cannot be edited either", () => {
    const store = freshStore();
    const approval = granted(store);
    expect(() => writePayload(store, approval.id, (p) => { p.taskRevision = 2; })).toThrow(/immutable/);
    expect(() => writePayload(store, approval.id, (p) => { p.planRevision = 2; })).toThrow(/immutable/);
    expect(() => writePayload(store, approval.id, (p) => { p.permittedAction = "publish:v1"; })).toThrow(/immutable/);
    expect(() => writePayload(store, approval.id, (p) => { p.riskClass = "low"; })).toThrow(/immutable/);
    expect(() => writePayload(store, approval.id, (p) => { p.expiresAt = "2099-01-01T00:00:00.000Z"; })).toThrow(/immutable/);
    expect(() => writePayload(store, approval.id, (p) => { p.actor = { kind: "user", identity: "somebody-else" }; })).toThrow(/immutable/);
    expect(() => writePayload(store, approval.id, (p) => { p.scope = { kind: "phase", phaseId: "ph-1" }; })).toThrow(/immutable/);

    const stored = store.approvals.require(approval.id);
    expect(stored.taskRevision).toBe(1);
    expect(stored.permittedAction).toBe("complete_task");
    expect(stored.actor).toEqual({ kind: "user", identity: "owner" });
  });

  it("an approval is never deleted", () => {
    const store = freshStore();
    const approval = granted(store);
    expect(() => store.connection.exec("DELETE FROM approval")).toThrow(/never deleted/);
    expect(store.approvals.get(approval.id)).toBeDefined();
  });
});

describe("invalidation is the one supported mutation, and it is final", () => {
  it("the repository can still invalidate through the triggers", () => {
    const store = freshStore();
    const approval = granted(store);
    store.approvals.invalidate(approval.id, { reason: "consumed", at: AT, detail: "the act completed" });
    expect(store.approvals.require(approval.id).invalidation?.reason).toBe("consumed");
  });

  it("a spent approval is never revived, by the repository or by raw SQL", () => {
    const store = freshStore();
    const approval = granted(store);
    store.approvals.invalidate(approval.id, { reason: "revoked", at: AT, detail: "withdrawn" });
    expect(() => store.connection.exec("UPDATE approval SET invalidated = 0")).toThrow(/never revived/);
    expect(() =>
      store.approvals.invalidate(approval.id, { reason: "consumed", at: AT, detail: "second go" }),
    ).toThrow();
    expect(store.approvals.require(approval.id).invalidation?.reason).toBe("revoked");
  });
});
