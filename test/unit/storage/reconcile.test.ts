/**
 * Startup reconciliation (issue #23; ADR 0006 rule 7, PLAN §5 "abandoned
 * attempts reconciled on startup").
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { ABANDONED_OUTCOME, assumeWorkersGone } from "../../../src/storage/reconcile.ts";
import type { Attempt, AttemptId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(storageRoot?: string): { store: Store; root: string } {
  const dir = storageRoot === undefined ? makeTempDir("korwf-recon-") : { path: storageRoot, cleanup: () => {} };
  let counter = 0;
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => "2026-02-02T00:00:00.000Z",
    newId: () => `audit-${(counter += 1)}`,
  });
  open.push({ dir, store });
  return { store, root: dir.path };
}

function seed(store: Store): void {
  store.workflows.insert(makeWorkflow());
  store.phases.insert(makePhase());
  store.tasks.insert(makeTask());
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("reconciliation closes attempts whose worker is gone", () => {
  it("marks an open attempt abandoned and stamps endedAt", () => {
    const { store } = freshStore();
    seed(store);
    store.attempts.insert(makeAttempt());
    const report = store.reconcile();
    expect(report.examined).toBe(1);
    expect(report.abandoned).toBe(1);
    expect(report.attempts[0]?.disposition).toBe("abandoned");
    const attempt = store.attempts.require("at-1");
    expect(attempt.outcome).toBe(ABANDONED_OUTCOME);
    expect(attempt.timestamps.endedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("leaves an attempt that already has an outcome alone", () => {
    const { store } = freshStore();
    seed(store);
    store.attempts.insert(makeAttempt({ outcome: "succeeded" }));
    const report = store.reconcile();
    expect(report.examined).toBe(0);
    expect(store.attempts.require("at-1").outcome).toBe("succeeded");
  });

  it("re-attaches an attempt whose worker is still alive", () => {
    const { store } = freshStore();
    seed(store);
    store.attempts.insert(makeAttempt());
    const reattached: string[] = [];
    const report = store.reconcile({
      probe: () => ({ kind: "alive", detail: "worker responded" }),
      onReattach: (attempt: Attempt) => reattached.push(attempt.id),
    });
    expect(report.reattached).toBe(1);
    expect(report.abandoned).toBe(0);
    expect(reattached).toEqual(["at-1"]);
    expect(store.attempts.require("at-1").outcome).toBeNull();
  });

  it("is idempotent: a second run finds nothing", () => {
    const { store } = freshStore();
    seed(store);
    store.attempts.insert(makeAttempt());
    store.reconcile();
    expect(store.reconcile().examined).toBe(0);
  });

  it("records an audit row attributed to the reconciler", () => {
    const { store } = freshStore();
    seed(store);
    store.attempts.insert(makeAttempt());
    store.reconcile();
    const trail = store.audit.forRecord("attempt", "at-1");
    expect(trail.map((e) => e.operation)).toEqual(["insert", "update"]);
    expect(trail[1]?.actor).toBe("korwf:reconciler");
  });

  it("handles a mixed set: some alive, some gone", () => {
    const { store } = freshStore();
    seed(store);
    store.attempts.insert(makeAttempt({ id: "at-1" as AttemptId, workerId: "alive-worker" }));
    store.attempts.insert(makeAttempt({ id: "at-2" as AttemptId, workerId: "dead-worker" }));
    const report = store.reconcile({
      probe: (attempt) => (attempt.workerId === "alive-worker" ? { kind: "alive" } : { kind: "gone" }),
    });
    expect(report.reattached).toBe(1);
    expect(report.abandoned).toBe(1);
    expect(store.attempts.require("at-1").outcome).toBeNull();
    expect(store.attempts.require("at-2").outcome).toBe(ABANDONED_OUTCOME);
  });
});

describe("the default probe is conservative", () => {
  it("reports every worker as gone when no probe is registered", () => {
    expect(assumeWorkersGone(makeAttempt()).kind).toBe("gone");
  });
});

describe("openStore runs reconciliation before returning (ADR 0006 rule 7)", () => {
  it("a restart closes attempts the previous session left open", () => {
    const dir = makeTempDir("korwf-restart-");
    try {
      const first = openStore({ storageRoot: dir.path, now: () => "2026-02-02T00:00:00.000Z" });
      seed(first.store);
      first.store.attempts.insert(makeAttempt());
      expect(first.report.reconciliation?.examined).toBe(0);
      // Simulate a crash: the process goes away without closing the store.
      first.store.close();

      const second = openStore({ storageRoot: dir.path, now: () => "2026-02-03T00:00:00.000Z" });
      expect(second.report.reconciliation?.abandoned).toBe(1);
      expect(second.store.attempts.require("at-1").outcome).toBe(ABANDONED_OUTCOME);
      second.store.close();
    } finally {
      dir.cleanup();
    }
  });

  it("can be skipped so a caller can install its own probe first", () => {
    const dir = makeTempDir("korwf-skip-");
    try {
      const first = openStore({ storageRoot: dir.path });
      seed(first.store);
      first.store.attempts.insert(makeAttempt());
      first.store.close();

      const second = openStore({ storageRoot: dir.path, reconcile: false });
      expect(second.report.reconciliation).toBeNull();
      expect(second.store.attempts.require("at-1").outcome).toBeNull();
      second.store.reconcile({ probe: () => ({ kind: "alive" }) });
      expect(second.store.attempts.require("at-1").outcome).toBeNull();
      second.store.close();
    } finally {
      dir.cleanup();
    }
  });
});
