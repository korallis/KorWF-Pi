/**
 * Coordinator takeover is audited and triggers reconciliation
 * (issue #77 Scope: "Takeover audits the previous owner and triggers attempt
 * reconciliation"; ADR 0006 rules 1 and 7).
 *
 * These tests use a real store so the audit row and the reconciliation report
 * are the ones the product writes, not stand-ins.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { ABANDONED_OUTCOME } from "../../../src/storage/reconcile.ts";
import type { AttemptId } from "../../../src/storage/records.ts";
import {
  acquireCoordinatorLock,
  COORDINATOR_LOCK_ACTOR,
} from "../../../src/workflow/coordinator.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import {
  makeAttempt,
  makePhase,
  makeTask,
  makeWorkflow,
} from "../../helpers/records.ts";

const open: { dir: TempDir; store: Store }[] = [];

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

function freshStore(): { store: Store; root: string } {
  const dir = makeTempDir("korwf-coord-takeover-");
  let counter = 0;
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => "2026-03-02T00:00:00.000Z",
    newId: () => `id-${(counter += 1)}`,
  });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow());
  store.phases.insert(makePhase());
  store.tasks.insert(makeTask());
  return { store, root: dir.path };
}

describe("takeover audits the previous owner", () => {
  it("writes an audit row attributed to korwf:coordinator-lock naming the new pid", () => {
    const { store, root } = freshStore();
    const live = new Set([9001]);
    acquireCoordinatorLock({
      storageRoot: root,
      store,
      pid: 9001,
      sessionId: "session-killed",
      isProcessAlive: (p) => live.has(p),
    });
    live.delete(9001);

    const successor = acquireCoordinatorLock({
      storageRoot: root,
      store,
      pid: 9002,
      sessionId: "session-successor",
      isProcessAlive: (p) => p === 9002,
    });
    expect(successor.acquisition).toBe("took_over_stale");

    const trail = store.audit.forRecord("audit_entry", "coordinator-lock:9002");
    expect(trail).toHaveLength(1);
    expect(trail[0]?.actor).toBe(COORDINATOR_LOCK_ACTOR);
    // beforeHash identifies the displaced owner, afterHash the new one; they
    // differ, so the trail shows a change of ownership and not a no-op.
    expect(trail[0]?.beforeHash).not.toBeNull();
    expect(trail[0]?.beforeHash).not.toBe(trail[0]?.afterHash);
    successor.release();
  });

  it("writes no takeover audit row when the lock was simply created", () => {
    const { store, root } = freshStore();
    const lease = acquireCoordinatorLock({
      storageRoot: root,
      store,
      pid: 9101,
    });
    expect(lease.acquisition).toBe("created");
    expect(lease.reconciliation).toBeNull();
    expect(
      store.audit.forRecord("audit_entry", "coordinator-lock:9101"),
    ).toHaveLength(0);
    lease.release();
  });
});

describe("takeover triggers attempt reconciliation", () => {
  it("closes the dead coordinator's open attempts before the successor schedules", () => {
    const { store, root } = freshStore();
    const live = new Set([9201]);
    acquireCoordinatorLock({
      storageRoot: root,
      store,
      pid: 9201,
      sessionId: "session-killed",
      isProcessAlive: (p) => live.has(p),
    });
    // The killed coordinator left an attempt with no outcome.
    store.attempts.insert(makeAttempt({ id: "at-orphan" as AttemptId }));
    live.delete(9201);

    const successor = acquireCoordinatorLock({
      storageRoot: root,
      store,
      pid: 9202,
      isProcessAlive: (p) => p === 9202,
    });
    expect(successor.reconciliation?.examined).toBe(1);
    expect(successor.reconciliation?.abandoned).toBe(1);
    expect(store.attempts.require("at-orphan").outcome).toBe(ABANDONED_OUTCOME);
    successor.release();
  });
});
