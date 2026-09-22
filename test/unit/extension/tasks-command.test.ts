/**
 * `/korwf tasks` (issue #43): rendering, non-TTY stability, filters, and the
 * "never mutates" guarantee.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { tasksMessage, parseTasksArgs } from "../../../src/extension/commands/tasks.ts";
import { raiseTaskBlocker } from "../../../src/workflow/blockers.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function seededStore(): Store {
  const dir = makeTempDir("korwf-tasks-cmd-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `audit-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF }));
  store.tasks.insert(makeTask({ id: "tk-1" as TaskId, workflowId: WF, phaseId: PH, status: "ready", goal: "Ship it" }));
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("AC1: /korwf tasks shows every field from PLAN §4 UI", () => {
  it("includes id, status, phase, dependencies, blockers, evidence, model, goal", () => {
    const store = seededStore();
    const outcome = tasksMessage(store, parseTasksArgs([]));
    expect(outcome.ok).toBe(true);
    for (const term of ["tk-1", "ready", "ph-1", "Ship it"]) {
      expect(outcome.message).toContain(term);
    }
    expect(outcome.message).toContain("evidence");
    expect(outcome.message).toContain("model");
    expect(outcome.message).toContain("blockers");
  });

  it("shows why a task is blocked", () => {
    const store = seededStore();
    raiseTaskBlocker({
      store,
      taskId: "tk-1" as TaskId,
      kind: "information",
      detail: "needs the API contract confirmed",
      actor: { kind: "engine", identity: "test" },
      now: () => AT,
      newId: () => `blk-${(counter += 1)}`,
    });
    const outcome = tasksMessage(store, parseTasksArgs([]));
    expect(outcome.message).toContain("needs the API contract confirmed");
  });
});

describe("AC2: filters --phase, --status, --blocked", () => {
  it("applies --status", () => {
    const store = seededStore();
    store.tasks.insert(makeTask({ id: "tk-2" as TaskId, workflowId: WF, phaseId: PH, status: "proposed", goal: "Other" }));
    const outcome = tasksMessage(store, parseTasksArgs(["--status", "proposed"]));
    expect(outcome.message).toContain("tk-2");
    expect(outcome.message).not.toContain("tk-1");
  });

  it("applies --blocked", () => {
    const store = seededStore();
    const outcome = tasksMessage(store, parseTasksArgs(["--blocked"]));
    expect(outcome.message).toBe("Tasks (dependency* = not yet done)\n(none)");
  });
});

describe("AC3: non-TTY output is stable and greppable", () => {
  it("produces the same output twice and greps for a task id", () => {
    const store = seededStore();
    const first = tasksMessage(store, parseTasksArgs([]));
    const second = tasksMessage(store, parseTasksArgs([]));
    expect(first.message).toBe(second.message);
    expect(first.message.split("\n").some((line) => line.includes("tk-1"))).toBe(true);
  });
});

describe("AC4: the board never mutates state", () => {
  it("leaves task status unchanged after rendering", () => {
    const store = seededStore();
    tasksMessage(store, parseTasksArgs([]));
    expect(store.tasks.require("tk-1" as TaskId).status).toBe("ready");
  });
});
