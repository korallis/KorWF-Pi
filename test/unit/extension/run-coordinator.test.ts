/**
 * `/korwf run` holds the coordinator lock (issue #77).
 *
 * AC1 "Two concurrent `run` invocations: exactly one proceeds" — exercised
 * through the real command, not only the lock primitive, because the point of
 * the lock is that a *second run* is refused.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type {
  ApprovalId,
  PhaseId,
  TaskId,
  WorkflowId,
} from "../../../src/storage/records.ts";
import { runCommand } from "../../../src/extension/commands/run.ts";
import { acquireCoordinatorLock } from "../../../src/workflow/coordinator.ts";
import { resolveCoordinatorLockPath } from "../../../src/storage/paths.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import {
  makeApproval,
  makePhase,
  makeTask,
  makeWorkflow,
} from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;
const newId = () => `id-${(counter += 1)}`;

afterEach(() => {
  while (open.length > 0) {
    const e = open.pop();
    e?.store.close();
    e?.dir.cleanup();
  }
});

/** An approved, runnable workflow in its own storage root. */
function fixture(): { store: Store; root: string } {
  const dir = makeTempDir("korwf-run-coord-");
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => AT,
    newId: () => `a-${(counter += 1)}`,
  });
  open.push({ dir, store });
  store.workflows.insert(
    makeWorkflow({ id: WF, planRevision: 1, status: "ready" }),
  );
  store.phases.insert(
    makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }),
  );
  store.tasks.insert(
    makeTask({
      id: "t1" as TaskId,
      workflowId: WF,
      phaseId: PH,
      status: "ready",
    }),
  );
  store.approvals.insert(
    makeApproval({
      id: "ap-plan" as ApprovalId,
      workflowId: WF,
      scope: { kind: "plan" },
      taskRevision: null,
      planRevision: 1,
      permittedAction: "approve_plan",
    }),
  );
  return { store, root: dir.path };
}

describe("AC1: a second /korwf run in the same project is refused", () => {
  it("proceeds once and refuses the second, naming the holding session", async () => {
    const { store, root } = fixture();
    const live = new Set<number>();
    const acquireFor = (pid: number, sessionId: string) => () => {
      const lease = acquireCoordinatorLock({
        storageRoot: root,
        store,
        pid,
        sessionId,
        isProcessAlive: (p) => live.has(p),
      });
      live.add(pid);
      return lease;
    };

    const first = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => true,
      acquireCoordinator: acquireFor(3101, "session-first"),
    });
    expect(first.ok).toBe(true);
    expect(first.coordinator).not.toBeNull();

    const second = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => true,
      acquireCoordinator: acquireFor(3102, "session-second"),
    });
    expect(second.ok).toBe(false);
    expect(second.runId).toBeNull();
    expect(second.coordinator).toBeNull();
    expect(second.message).toContain(
      "Coordinator active in session session-first since",
    );
    first.coordinator?.release();
  });

  it("releases the lock when the user declines, so the next run can proceed", async () => {
    const { store, root } = fixture();
    const declined = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => false,
      acquireCoordinator: () =>
        acquireCoordinatorLock({
          storageRoot: root,
          store,
          pid: 3201,
          sessionId: "declining",
        }),
    });
    expect(declined.ok).toBe(false);
    expect(declined.coordinator).toBeNull();

    const accepted = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => true,
      acquireCoordinator: () =>
        acquireCoordinatorLock({
          storageRoot: root,
          store,
          pid: 3202,
          sessionId: "accepting",
        }),
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.coordinator?.contents.pid).toBe(3202);
    accepted.coordinator?.release();
  });

  it("does not take the lock at all when no acquirer is supplied", async () => {
    const { store, root } = fixture();
    const result = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.coordinator ?? null).toBeNull();
    expect(existsSync(resolveCoordinatorLockPath(root))).toBe(false);
  });
});
