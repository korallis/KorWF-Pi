/**
 * Append-only enforcement (issue #23; ADR 0006 rule 5, docs/records.md §4).
 *
 * AC: "Attempting to update an audit row throws." The same is asserted for
 * the other three append-only tables, at both levels of defence: the
 * repository has no update/delete method, and the database has triggers.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { AppendOnlyRepository, MutableRepository } from "../../../src/storage/repos/base.ts";
import { APPEND_ONLY_TABLES } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import {
  makeAttempt,
  makeDecision,
  makeEvidence,
  makeModelOutcome,
  makePhase,
  makeTask,
  makeWorkflow,
} from "../../helpers/records.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): Store {
  const dir = makeTempDir("korwf-append-");
  let counter = 0;
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `audit-${(counter += 1)}`,
  });
  open.push({ dir, store });
  return store;
}

function seed(store: Store): void {
  store.workflows.insert(makeWorkflow());
  store.phases.insert(makePhase());
  store.tasks.insert(makeTask());
  store.attempts.insert(makeAttempt());
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("AC: attempting to update an audit row throws", () => {
  it("the database trigger aborts an UPDATE on audit_entry", () => {
    const store = freshStore();
    seed(store);
    const row = store.audit.list()[0];
    expect(row).toBeDefined();
    expect(() =>
      store.connection.prepare("UPDATE audit_entry SET actor = ? WHERE id = ?").run("forged", row!.id),
    ).toThrow(/append-only/);
  });

  it("the database trigger aborts a DELETE on audit_entry", () => {
    const store = freshStore();
    seed(store);
    const row = store.audit.list()[0];
    expect(() => store.connection.prepare("DELETE FROM audit_entry WHERE id = ?").run(row!.id)).toThrow(
      /append-only/,
    );
  });

  it("the audit repository exposes no update or delete method at all", () => {
    const store = freshStore();
    expect(store.audit).toBeInstanceOf(AppendOnlyRepository);
    expect(store.audit).not.toBeInstanceOf(MutableRepository);
    expect("update" in store.audit).toBe(false);
    expect("delete" in store.audit).toBe(false);
  });
});

describe("every append-only table rejects UPDATE and DELETE (ADR 0006 rule 5)", () => {
  it("decision, evidence and model_outcome triggers abort", () => {
    const store = freshStore();
    seed(store);
    store.decisions.insert(makeDecision());
    store.evidence.insert(makeEvidence());
    store.modelOutcomes.insert(makeModelOutcome());

    expect(() => store.connection.exec("UPDATE decision SET stateHash = 'forged'")).toThrow(/append-only/);
    expect(() => store.connection.exec("DELETE FROM decision")).toThrow(/append-only/);
    expect(() => store.connection.exec("UPDATE evidence SET requirementId = 'forged'")).toThrow(/append-only/);
    expect(() => store.connection.exec("DELETE FROM evidence")).toThrow(/append-only/);
    expect(() => store.connection.exec("UPDATE model_outcome SET result = 'succeeded'")).toThrow(/append-only/);
    expect(() => store.connection.exec("DELETE FROM model_outcome")).toThrow(/append-only/);
  });

  it("all four repositories are append-only, matching APPEND_ONLY_TABLES", () => {
    const store = freshStore();
    const repos = [store.decisions, store.evidence, store.modelOutcomes, store.audit];
    expect(repos.map((r) => r.table).sort()).toEqual([...APPEND_ONLY_TABLES].sort());
    for (const repo of repos) {
      expect(repo).not.toBeInstanceOf(MutableRepository);
    }
  });

  it("pins updatedAt to createdAt so no in-place change is observable (§4.4)", () => {
    const store = freshStore();
    seed(store);
    const decision = store.decisions.insert(makeDecision({ updatedAt: "2099-01-01T00:00:00.000Z" }));
    expect(decision.updatedAt).toBe(decision.createdAt);
    expect(store.decisions.require(decision.id).updatedAt).toBe(decision.createdAt);
  });

  it("records a correction as a new row that supersedes the old one (§4.5)", () => {
    const store = freshStore();
    seed(store);
    const first = store.evidence.insert(makeEvidence({ id: "ev-1" as never }));
    const second = store.evidence.insert(
      makeEvidence({ id: "ev-2" as never, supersedesId: first.id, exitStatus: { kind: "exited", code: 1 } }),
    );
    expect(second.supersedesId).toBe("ev-1");
    // The original is still on disk, unchanged.
    expect(store.evidence.require("ev-1").exitStatus).toEqual({ kind: "exited", code: 0 });
    expect(store.evidence.count()).toBe(2);
  });
});

describe("audit rows are written for every mutable change (PLAN §5)", () => {
  it("records insert, update and delete with actor, timestamp and hashes", () => {
    const store = freshStore();
    store.setActor("tester");
    store.workflows.insert(makeWorkflow());
    store.workflows.update("wf-1", { status: "running" });

    const trail = store.audit.forRecord("workflow", "wf-1");
    expect(trail.map((e) => e.operation)).toEqual(["insert", "update"]);
    expect(trail.every((e) => e.actor === "tester")).toBe(true);
    expect(trail[0]?.beforeHash).toBeNull();
    expect(trail[0]?.afterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(trail[1]?.beforeHash).toBe(trail[0]?.afterHash);
    expect(trail[1]?.afterHash).not.toBe(trail[1]?.beforeHash);
    expect(trail.every((e) => e.createdAt === "2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("does not copy record values into the audit row, only hashes", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ goal: "a distinctive secret-looking goal string" }));
    const entry = store.audit.forRecord("workflow", "wf-1")[0];
    expect(JSON.stringify(entry)).not.toContain("distinctive");
  });
});
