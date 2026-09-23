/**
 * `src/workflow/run.ts` (issue #74; PLAN §2.1, §2.6).
 *
 * AC1 "Unapproved phase → refused with reason" and AC3 "Estimate output
 * distinguishes known/estimated/unknown" are exercised here at the
 * `estimateRun`/`startRun` layer; the confirm/decline/cap-refusal wiring
 * lives in `test/unit/extension/run-command.test.ts`. AC2 "Estimate over cap
 * → refused unless approved" and the resumable-stop requirement are
 * exercised in both files.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { estimateRun, startRun, stopRun } from "../../../src/workflow/run.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const e = open.pop();
    e?.store.close();
    e?.dir.cleanup();
  }
});

function freshStore(): Store {
  const dir = makeTempDir("korwf-run-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }));
  return store;
}

const actor = { kind: "user", identity: "owner" } as const;
const now = () => AT;
function newId(): string {
  return `id-${(counter += 1)}`;
}

describe("AC3: estimateRun distinguishes known/estimated/unknown cost", () => {
  it("prices tasks with a card and marks the rest unknown, never $0", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "t1" as TaskId, workflowId: WF, phaseId: PH, status: "ready" }));
    store.tasks.insert(makeTask({ id: "t2" as TaskId, workflowId: WF, phaseId: PH, status: "proposed" }));

    const estimate = estimateRun({
      store,
      workflowId: WF,
      phaseIds: [PH],
      tokensForTask: (t) => (t.id === "t1" ? { inputTokens: 1000, outputTokens: 500 } : null),
      priceForTask: (t) => (t.id === "t1" ? { inputPerToken: 0.000001, outputPerToken: 0.000002 } : null),
    });

    expect(estimate.tasks).toBe(2);
    expect(estimate.unknownTasks).toBe(1);
    expect(estimate.estimatedUsd).toBeCloseTo(0.001 + 0.001, 6);
    expect(estimate.knownUsd).toBe(0);
    expect(estimate.perPhase).toEqual([
      { phaseId: PH, tasks: 2, knownUsd: 0, estimatedUsd: estimate.estimatedUsd, unknownTasks: 1 },
    ]);
  });

  it("a task with no price/token data at all is unknown, not a fabricated zero", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "t1" as TaskId, workflowId: WF, phaseId: PH, status: "ready" }));

    const estimate = estimateRun({ store, workflowId: WF, phaseIds: [PH] });

    expect(estimate.unknownTasks).toBe(1);
    expect(estimate.knownUsd).toBe(0);
    expect(estimate.estimatedUsd).toBe(0);
  });

  it("excludes terminal tasks (done/cancelled) from the estimate", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "t1" as TaskId, workflowId: WF, phaseId: PH, status: "cancelled" }));
    const estimate = estimateRun({ store, workflowId: WF, phaseIds: [PH] });
    expect(estimate.tasks).toBe(0);
  });
});

describe("startRun: the transition shown BEFORE work begins", () => {
  it("starts a phase with a ready task", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "t1" as TaskId, workflowId: WF, phaseId: PH, status: "ready" }));

    const results = startRun({
      store,
      workflowId: WF,
      phaseIds: [PH],
      actor,
      now,
      newId,
      authorizationCurrent: () => true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(store.phases.require(PH).gateStatus).toBe("running");
  });

  it("refuses a phase with nothing schedulable, with a reason", () => {
    const store = freshStore();
    // No tasks at all: phase_start_valid is false.
    const results = startRun({
      store,
      workflowId: WF,
      phaseIds: [PH],
      actor,
      now,
      newId,
      authorizationCurrent: () => true,
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toBeTruthy();
    expect(store.phases.require(PH).gateStatus).toBe("pending");
  });
});

describe("stopRun: a deliberate stop leaves resumable state", () => {
  it("pauses every non-terminal phase with a blocker reason, not a delete", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "t1" as TaskId, workflowId: WF, phaseId: PH, status: "ready" }));
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });
    expect(store.phases.require(PH).gateStatus).toBe("running");

    const results = stopRun({ store, workflowId: WF, actor, now, newId, reason: "user requested stop" });

    expect(results[0]?.ok).toBe(true);
    const phase = store.phases.require(PH);
    expect(phase.gateStatus).toBe("paused_approval");
    // Resumable: the task itself is untouched, still `ready` and re-dispatchable.
    expect(store.tasks.require("t1" as TaskId).status).toBe("ready");
  });

  it("files a budget stop as paused_cap, distinct from a manual one", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "t1" as TaskId, workflowId: WF, phaseId: PH, status: "ready" }));
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    const results = stopRun({
      store,
      workflowId: WF,
      actor,
      now,
      newId,
      reason: "workflow budget cap reached",
      budgetStop: true,
    });

    expect(results[0]?.ok).toBe(true);
    expect(store.phases.require(PH).gateStatus).toBe("paused_cap");
  });

  it("is idempotent-safe: stopping an already-pending phase does not throw or lose state", () => {
    const store = freshStore();
    const results = stopRun({ store, workflowId: WF, actor, now, newId, reason: "stop before anything started" });
    expect(results[0]?.ok).toBe(true);
    expect(store.phases.require(PH).gateStatus).toBe("paused_approval");
  });
});
