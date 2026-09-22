/**
 * `src/workflow/boards.ts` (issue #43): read-only task/phase board rows.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { buildTaskBoard, buildPhaseBoard } from "../../../src/workflow/boards.ts";
import { raiseTaskBlocker } from "../../../src/workflow/blockers.ts";
import { applyCapPause } from "../../../src/models/cap-pause.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeAttempt, makeEvidence, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function freshStore(): Store {
  const dir = makeTempDir("korwf-boards-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `audit-${(counter += 1)}` });
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

describe("AC: task board shows dependencies, blockers, evidence, and model", () => {
  it("marks an unmet dependency and reports the blocker reason", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ id: WF }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF }));
    store.tasks.insert(makeTask({ id: "tk-1" as TaskId, workflowId: WF, phaseId: PH, status: "done" }));
    store.tasks.insert(
      makeTask({
        id: "tk-2" as TaskId,
        workflowId: WF,
        phaseId: PH,
        status: "proposed",
        dependencies: ["tk-1" as TaskId],
      }),
    );
    raiseTaskBlocker({
      store,
      taskId: "tk-2" as TaskId,
      kind: "information",
      detail: "waiting on the user to confirm scope",
      actor: { kind: "engine", identity: "test" },
      now: () => AT,
      newId: () => `blk-${(counter += 1)}`,
    });

    const rows = buildTaskBoard(store, WF);
    const blocked = rows.find((r) => r.task.id === "tk-2");
    expect(blocked?.unmetDependencies).toEqual([]);
    expect(blocked?.blockers[0]?.detail).toContain("waiting on the user");
  });

  it("shows the most recent attempt's used model and evidence count", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ id: WF }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF }));
    store.tasks.insert(makeTask({ id: "tk-1" as TaskId, workflowId: WF, phaseId: PH, status: "running" }));
    store.attempts.insert(makeAttempt({ id: "at-1" as never, taskId: "tk-1" as TaskId, usedModel: "example/model-a" }));
    store.evidence.insert(makeEvidence({ id: "ev-1" as never, taskId: "tk-1" as TaskId }));

    const rows = buildTaskBoard(store, WF);
    const row = rows.find((r) => r.task.id === "tk-1");
    expect(row?.lastModel).toBe("example/model-a");
    expect(row?.evidenceCount).toBe(1);
  });

  it("filters by phase, status and blockedOnly", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ id: WF }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF }));
    store.tasks.insert(makeTask({ id: "tk-1" as TaskId, workflowId: WF, phaseId: PH, status: "ready" }));
    store.tasks.insert(makeTask({ id: "tk-2" as TaskId, workflowId: WF, phaseId: PH, status: "proposed" }));

    expect(buildTaskBoard(store, WF, { status: "ready" }).map((r) => r.task.id)).toEqual(["tk-1"]);
    expect(buildTaskBoard(store, WF, { blockedOnly: true })).toHaveLength(0);
  });
});

describe("AC: phase board shows gate status, budget, and task counts", () => {
  it("counts tasks by status and reports unresolved phase blockers", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ id: WF }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "running" }));
    store.tasks.insert(makeTask({ id: "tk-1" as TaskId, workflowId: WF, phaseId: PH, status: "done" }));
    store.tasks.insert(makeTask({ id: "tk-2" as TaskId, workflowId: WF, phaseId: PH, status: "running" }));

    const rows = buildPhaseBoard(store, WF);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.taskTotal).toBe(2);
    expect(rows[0]?.taskCounts.done).toBe(1);
    expect(rows[0]?.taskCounts.running).toBe(1);
    expect(rows[0]?.blockers).toEqual([]);
  });

  it("filters by gate status", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ id: WF }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }));

    expect(buildPhaseBoard(store, WF, { status: "pending" })).toHaveLength(1);
    expect(buildPhaseBoard(store, WF, { status: "passed" })).toHaveLength(0);
  });

  it("surfaces the earliest estimated cap reset for a cap-paused phase (#63)", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "running" }));
    store.tasks.insert(makeTask({ id: "tk-1" as TaskId, workflowId: WF, phaseId: PH, status: "running" }));

    applyCapPause(
      {
        store,
        taskId: "tk-1" as TaskId,
        phaseId: PH,
        actor: { kind: "engine", identity: "engine" },
        now: () => AT,
        newId: () => `id-${(counter += 1)}`,
      },
      {
        kind: "pause",
        reason: "all_capped",
        earliestReset: "2026-01-01T00:30:00.000Z",
        blocker: "all eligible candidates capped",
        watchRoutes: [],
      },
    );

    const rows = buildPhaseBoard(store, WF);
    expect(rows[0]?.phase.gateStatus).toBe("paused_cap");
    expect(rows[0]?.earliestCapReset).toBe("2026-01-01T00:30:00.000Z");
  });

  it("reports null earliestCapReset for a phase that is not cap-paused", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow({ id: WF }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "running" }));

    const rows = buildPhaseBoard(store, WF);
    expect(rows[0]?.earliestCapReset).toBeNull();
  });
});
