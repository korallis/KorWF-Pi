/**
 * `/korwf phases` (issue #43): rendering, filters, non-TTY stability.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { phasesMessage, parsePhasesArgs } from "../../../src/extension/commands/phases.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function seededStore(): Store {
  const dir = makeTempDir("korwf-phases-cmd-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `audit-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF }));
  store.phases.insert(
    makePhase({ id: PH, workflowId: WF, gateStatus: "running", goal: "Build the widget", budgetCap: { maxSpendUsd: 5, maxTokens: null, maxRequests: null, maxConcurrency: 1, maxElapsedMs: null } }),
  );
  store.tasks.insert(makeTask({ id: "tk-1" as TaskId, workflowId: WF, phaseId: PH, status: "running" }));
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("AC1: /korwf phases shows every field from PLAN §4 UI", () => {
  it("includes id, gate status, integration, budget, tasks, blockers, goal", () => {
    const store = seededStore();
    const outcome = phasesMessage(store, parsePhasesArgs([]));
    expect(outcome.ok).toBe(true);
    for (const term of ["ph-1", "running", "korwf/phase-0", "$5", "Build the widget"]) {
      expect(outcome.message).toContain(term);
    }
    expect(outcome.message).toContain("tasks");
    expect(outcome.message).toContain("blockers");
  });
});

describe("AC2: filter --status", () => {
  it("filters by gate status", () => {
    const store = seededStore();
    const passed = phasesMessage(store, parsePhasesArgs(["--status", "passed"]));
    expect(passed.message).toBe("Phases\n(none)");
    const running = phasesMessage(store, parsePhasesArgs(["--status", "running"]));
    expect(running.message).toContain("ph-1");
  });
});

describe("AC3: non-TTY output is stable and greppable", () => {
  it("produces identical output across calls", () => {
    const store = seededStore();
    const a = phasesMessage(store, parsePhasesArgs([]));
    const b = phasesMessage(store, parsePhasesArgs([]));
    expect(a.message).toBe(b.message);
  });
});

describe("AC4: the board never mutates state", () => {
  it("leaves phase gate status unchanged after rendering", () => {
    const store = seededStore();
    phasesMessage(store, parsePhasesArgs([]));
    expect(store.phases.require(PH).gateStatus).toBe("running");
  });
});
