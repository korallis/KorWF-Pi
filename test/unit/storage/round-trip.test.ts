/**
 * Round-trip tests for the store (issue #23).
 *
 * AC: "All ten record types round-trip." (Eleven with `audit_entry`, which
 * docs/records.md defines alongside the PLAN §5 ten.)
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import {
  makeApproval,
  makeAttempt,
  makeDecision,
  makeEvidence,
  makeMemory,
  makeModelAvailability,
  makeModelOutcome,
  makePhase,
  makeTask,
  makeWorkflow,
} from "../../helpers/records.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): Store {
  const dir = makeTempDir("korwf-store-");
  let counter = 0;
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `audit-${(counter += 1)}`,
  });
  open.push({ dir, store });
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

/** Insert a consistent workflow → phase → task → attempt chain. */
function seed(store: Store) {
  const workflow = store.workflows.insert(makeWorkflow());
  const phase = store.phases.insert(makePhase());
  const task = store.tasks.insert(makeTask());
  const attempt = store.attempts.insert(makeAttempt());
  return { workflow, phase, task, attempt };
}

describe("AC: all record types round-trip", () => {
  it("workflow round-trips unchanged", () => {
    const store = freshStore();
    const written = store.workflows.insert(makeWorkflow());
    expect(store.workflows.require(written.id)).toEqual(written);
  });

  it("phase round-trips unchanged", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    const written = store.phases.insert(makePhase());
    expect(store.phases.require(written.id)).toEqual(written);
  });

  it("task round-trips unchanged", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    store.phases.insert(makePhase());
    const written = store.tasks.insert(makeTask());
    expect(store.tasks.require(written.id)).toEqual(written);
  });

  it("attempt round-trips unchanged", () => {
    const store = freshStore();
    const { attempt } = seed(store);
    expect(store.attempts.require(attempt.id)).toEqual(attempt);
  });

  it("decision round-trips unchanged", () => {
    const store = freshStore();
    seed(store);
    const written = store.decisions.insert(makeDecision());
    expect(store.decisions.require(written.id)).toEqual(written);
  });

  it("evidence round-trips unchanged", () => {
    const store = freshStore();
    seed(store);
    const written = store.evidence.insert(makeEvidence());
    expect(store.evidence.require(written.id)).toEqual(written);
  });

  it("approval round-trips unchanged", () => {
    const store = freshStore();
    seed(store);
    const written = store.approvals.insert(makeApproval());
    expect(store.approvals.require(written.id)).toEqual(written);
  });

  it("memory round-trips unchanged", () => {
    const store = freshStore();
    seed(store);
    const written = store.memories.insert(makeMemory());
    expect(store.memories.require(written.id)).toEqual(written);
  });

  it("model_availability round-trips unchanged", () => {
    const store = freshStore();
    const written = store.modelAvailability.insert(makeModelAvailability());
    expect(store.modelAvailability.require(written.id)).toEqual(written);
  });

  it("model_outcome round-trips unchanged", () => {
    const store = freshStore();
    seed(store);
    const written = store.modelOutcomes.insert(makeModelOutcome());
    expect(store.modelOutcomes.require(written.id)).toEqual(written);
  });

  it("audit_entry round-trips unchanged", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    const written = store.recordAudit({
      table: "workflow",
      recordId: "wf-1",
      operation: "insert",
      afterHash: "c".repeat(64),
      workflowId: "wf-1",
      actor: "test",
    });
    expect(store.audit.require(written.id)).toEqual(written);
  });

  it("preserves nested structures, nulls and discriminated unions", () => {
    const store = freshStore();
    seed(store);
    const evidence = store.evidence.insert(
      makeEvidence({ exitStatus: { kind: "flaky", runs: [0, 1, 0] }, checkId: null, caveats: ["retried"] }),
    );
    const read = store.evidence.require(evidence.id);
    expect(read.exitStatus).toEqual({ kind: "flaky", runs: [0, 1, 0] });
    expect(read.checkId).toBeNull();
    expect(read.caveats).toEqual(["retried"]);
    expect(read.provenance[0]?.range).toEqual({ startLine: 1, endLine: 10 });
  });
});

describe("foreign keys declared in docs/records.md §9 are enforced by SQLite", () => {
  it("rejects a phase whose workflow does not exist", () => {
    const store = freshStore();
    expect(() => store.phases.insert(makePhase())).toThrow(/FOREIGN KEY/i);
  });

  it("cascades task deletion from its phase", () => {
    const store = freshStore();
    seed(store);
    store.attempts.delete("at-1");
    store.phases.delete("ph-1");
    expect(store.tasks.count()).toBe(0);
    expect(store.phases.count()).toBe(0);
  });

  it("restricts deleting a workflow that append-only rows reference (§9)", () => {
    // Every mutable write produces an audit row, and `audit_entry.workflowId`
    // is `restrict` — so an audited workflow can never be deleted, exactly as
    // docs/records.md §9 says of append-only children.
    const store = freshStore();
    seed(store);
    store.evidence.insert(makeEvidence());
    expect(() => store.workflows.delete("wf-1")).toThrow(/FOREIGN KEY/i);
  });
});

describe("route-keyed model availability (#125)", () => {
  it("keeps one row per route, so two providers exposing one model id stay independent", () => {
    const store = freshStore();
    store.modelAvailability.upsert(makeModelAvailability({ id: "ma-a", routeId: "route-a", providerId: "provider-a" }));
    store.modelAvailability.upsert(
      makeModelAvailability({ id: "ma-b", routeId: "route-b", providerId: "provider-b" }),
    );
    store.modelAvailability.upsert(
      makeModelAvailability({ id: "ignored", routeId: "route-a", providerId: "provider-a", capKind: "rate_limited" }),
    );
    expect(store.modelAvailability.count()).toBe(2);
    expect(store.modelAvailability.byRoute("route-a")?.capKind).toBe("rate_limited");
    expect(store.modelAvailability.byRoute("route-b")?.capKind).toBe("none");
    expect(store.modelAvailability.byModelId("example-model")).toHaveLength(2);
  });
});
