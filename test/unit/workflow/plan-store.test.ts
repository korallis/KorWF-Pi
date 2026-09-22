/**
 * `src/workflow/plan-store.ts` (issue #37): persisting a plan into Phase and
 * Task records, plan revision N+1, superseded tasks, and approval
 * invalidation.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { WorkflowId } from "../../../src/storage/records.ts";
import { NO_CHECKS_BLOCKER, SUPERSEDED_BLOCKER } from "../../../src/workflow/plan-schema.ts";
import {
  PlanPersistError,
  persistOrRevisePlan,
  persistPlan,
  readStoredPlan,
  revisePlan,
  summarisePersistedPlan,
} from "../../../src/workflow/plan-store.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeWorkflow } from "../../helpers/records.ts";
import { minimalPlan, planTask, planWithoutChecks } from "../../helpers/plan.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): Store {
  const dir = makeTempDir("korwf-plan-");
  let counter = 0;
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => AT,
    newId: () => `audit-${(counter += 1)}`,
  });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ planRevision: 0, status: "planning" }));
  return store;
}

function idFactory(): (kind: "phase" | "task") => string {
  const counters = { phase: 0, task: 0 };
  return (kind) => `${kind === "phase" ? "ph" : "tk"}-${(counters[kind] += 1)}`;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("AC: a plan persists into Phase and Task records", () => {
  it("writes one phase and one task at plan revision 1", () => {
    const store = freshStore();
    const result = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(result.planRevision).toBe(1);
    expect(store.phases.forWorkflow(WF)).toHaveLength(1);
    expect(store.tasks.findBy("workflowId", WF)).toHaveLength(1);
    expect(store.workflows.require(WF).planRevision).toBe(1);
  });

  it("stores every check the planner emitted on the Task record", () => {
    const store = freshStore();
    const result = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const task = store.tasks.require(result.tasks[0]!.id);
    expect(task.checks).toHaveLength(1);
    expect(task.checks[0]?.command).toBe("npm test -- example");
    expect(task.checks[0]?.required).toBe(true);
  });

  it("gives a phase a default integration branch derived from its order", () => {
    const store = freshStore();
    const result = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(result.phases[0]?.integrationPoint.branch).toBe("korwf/phase-0");
  });

  it("resolves planner-local dependency ids to record ids", () => {
    const store = freshStore();
    const plan = minimalPlan({
      tasks: [planTask({ id: "t1" }), planTask({ id: "t2", goal: "Wire it up", dependencies: ["t1"] })],
    });
    const result = persistPlan({ store, workflowId: WF, plan, now: () => AT, newId: idFactory() });
    const second = result.tasks.find((t) => t.goal === "Wire it up");
    expect(second?.dependencies).toEqual([result.idMapping.tasks.get("t1")]);
  });

  it("refuses a second persistPlan on a workflow that already has a plan", () => {
    const store = freshStore();
    persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(() =>
      persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() }),
    ).toThrow(PlanPersistError);
  });
});
