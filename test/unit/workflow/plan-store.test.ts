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
import { makeApproval, makeWorkflow } from "../../helpers/records.ts";
import { sizePlanTasks, tasksNeedingDecomposition } from "../../../src/workflow/planner.ts";
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
  recordCounter = 0;
  store.workflows.insert(makeWorkflow({ planRevision: 0, status: "planning" }));
  return store;
}

/**
 * Record-id generator. Ids must be unique across every call in one store, so
 * the counter lives at module scope and is reset per store, not per call.
 */
let recordCounter = 0;
function idFactory(): (kind: "phase" | "task") => string {
  return (kind) => `${kind === "phase" ? "ph" : "tk"}-${(recordCounter += 1)}`;
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

describe("AC: an invalid dependency graph cannot be persisted (#40; PLAN §3.C)", () => {
  it("rejects a plan whose tasks form a dependency cycle, even bypassing plan-schema validation", () => {
    const store = freshStore();
    const plan = minimalPlan({
      tasks: [
        planTask({ id: "t1", dependencies: ["t2"] }),
        planTask({ id: "t2", goal: "Second", dependencies: ["t1"] }),
      ],
    });
    expect(() => persistPlan({ store, workflowId: WF, plan, now: () => AT, newId: idFactory() })).toThrow(
      PlanPersistError,
    );
    expect(store.tasks.findBy("workflowId", WF)).toHaveLength(0);
  });
});

describe("AC: a task with checks: [] persists as proposed with the no_checks blocker (PLAN §2.3)", () => {
  it("stores status proposed and blocker no_checks", () => {
    const store = freshStore();
    const result = persistPlan({
      store,
      workflowId: WF,
      plan: planWithoutChecks(),
      now: () => AT,
      newId: idFactory(),
    });
    const task = store.tasks.require(result.tasks[0]!.id);
    expect(task.status).toBe("proposed");
    expect(task.blocker).toBe(NO_CHECKS_BLOCKER);
    expect(result.blockedForNoChecks).toEqual([task.id]);
  });

  it("stores a task that does have checks as proposed with no blocker", () => {
    const store = freshStore();
    const result = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const task = store.tasks.require(result.tasks[0]!.id);
    expect(task.status).toBe("proposed");
    expect(task.blocker).toBeNull();
    expect(result.blockedForNoChecks).toEqual([]);
  });

  it("never writes a `ready` task, even for a fully specified plan", () => {
    const store = freshStore();
    persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(store.tasks.findBy("workflowId", WF).every((t) => t.status === "proposed")).toBe(true);
  });

  it("clears the blocker when a revision adds checks to the task", () => {
    const store = freshStore();
    const first = persistPlan({
      store,
      workflowId: WF,
      plan: planWithoutChecks(),
      now: () => AT,
      newId: idFactory(),
    });
    revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(store.tasks.require(first.tasks[0]!.id).blocker).toBeNull();
  });

  it("names the blocked tasks in the summary text", () => {
    const store = freshStore();
    const result = persistPlan({
      store,
      workflowId: WF,
      plan: planWithoutChecks(),
      now: () => AT,
      newId: idFactory(),
    });
    expect(summarisePersistedPlan(result)).toContain(NO_CHECKS_BLOCKER);
  });
});

describe("a task that cannot fit one worker turn persists with the output_budget blocker (#124)", () => {
  it("blocks the task named by the sizing pass", () => {
    const store = freshStore();
    const plan = minimalPlan({
      tasks: [planTask({ expectedArtifacts: [{ path: "src/huge.ts", estimate: { unit: "lines", value: 4_000 } }] })],
    });
    const blocked = tasksNeedingDecomposition(sizePlanTasks(plan, { maxTokens: 16_384, contextWindow: 200_000 }));
    expect(blocked).toEqual(["t1"]);
    const result = persistPlan({
      store,
      workflowId: WF,
      plan,
      now: () => AT,
      newId: idFactory(),
      outputBudgetBlocked: blocked,
    });
    const task = store.tasks.require(result.tasks[0]!.id);
    expect(task.status).toBe("proposed");
    expect(task.blocker).toBe("output_budget");
    expect(result.blockedForOutputBudget).toEqual([task.id]);
  });

  it("lets no_checks win when a task has neither checks nor a feasible size", () => {
    const store = freshStore();
    const plan = minimalPlan({
      tasks: [
        planTask({
          checks: [],
          expectedArtifacts: [{ path: "src/huge.ts", estimate: { unit: "lines", value: 4_000 } }],
        }),
      ],
    });
    const result = persistPlan({
      store,
      workflowId: WF,
      plan,
      now: () => AT,
      newId: idFactory(),
      outputBudgetBlocked: ["t1"],
    });
    expect(store.tasks.require(result.tasks[0]!.id).blocker).toBe(NO_CHECKS_BLOCKER);
  });

  it("clears the blocker when a revision splits the task", () => {
    const store = freshStore();
    const plan = minimalPlan({
      tasks: [planTask({ expectedArtifacts: [{ path: "src/huge.ts", estimate: { unit: "lines", value: 4_000 } }] })],
    });
    const first = persistPlan({
      store,
      workflowId: WF,
      plan,
      now: () => AT,
      newId: idFactory(),
      outputBudgetBlocked: ["t1"],
    });
    revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(store.tasks.require(first.tasks[0]!.id).blocker).toBeNull();
  });
});

describe("AC: re-running produces revision N+1 and marks superseded tasks", () => {
  it("bumps Workflow.planRevision", () => {
    const store = freshStore();
    persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const revised = revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(revised.planRevision).toBe(2);
    expect(store.workflows.require(WF).planRevision).toBe(2);
  });

  it("keeps the record id of a task whose goal is unchanged", () => {
    const store = freshStore();
    const first = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const second = revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(second.tasks[0]?.id).toBe(first.tasks[0]?.id);
  });

  it("bumps Task.revision when the definition of done changes", () => {
    const store = freshStore();
    const first = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(first.tasks[0]?.revision).toBe(1);
    const changed = minimalPlan({
      tasks: [planTask({ acceptanceCriteria: [{ id: "ac1", text: "It exports greet() and farewell()." }] })],
    });
    const second = revisePlan({ store, workflowId: WF, plan: changed, now: () => AT, newId: idFactory() });
    expect(second.revisedTasks).toEqual([first.tasks[0]!.id]);
    expect(store.tasks.require(first.tasks[0]!.id).revision).toBe(2);
  });

  it("does not bump Task.revision when only ownership or dependencies change", () => {
    const store = freshStore();
    const first = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const moved = minimalPlan({
      tasks: [planTask({ ownership: { paths: ["src/moved.ts"], components: ["moved"] } })],
    });
    const second = revisePlan({ store, workflowId: WF, plan: moved, now: () => AT, newId: idFactory() });
    expect(second.revisedTasks).toEqual([]);
    const task = store.tasks.require(first.tasks[0]!.id);
    expect(task.revision).toBe(1);
    expect(task.ownership.paths).toEqual(["src/moved.ts"]);
  });

  it("cancels a dropped task with the superseded blocker rather than deleting it", () => {
    const store = freshStore();
    const plan = minimalPlan({ tasks: [planTask({ id: "t1" }), planTask({ id: "t2", goal: "Drop me" })] });
    const first = persistPlan({ store, workflowId: WF, plan, now: () => AT, newId: idFactory() });
    const dropped = first.tasks.find((t) => t.goal === "Drop me")!;
    const second = revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(second.supersededTasks).toEqual([dropped.id]);
    const stored = store.tasks.require(dropped.id);
    expect(stored.status).toBe("cancelled");
    expect(stored.blocker).toBe(SUPERSEDED_BLOCKER);
  });

  it("gives a genuinely new piece of work a new record id", () => {
    const store = freshStore();
    const first = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const grown = minimalPlan({
      tasks: [planTask({ id: "t1" }), planTask({ id: "t2", goal: "Add farewell", ownership: { paths: ["src/bye.ts"], components: [] } })],
    });
    const second = revisePlan({ store, workflowId: WF, plan: grown, now: () => AT, newId: idFactory() });
    expect(second.tasks).toHaveLength(2);
    expect(new Set(second.tasks.map((t) => t.id)).size).toBe(2);
    expect(second.tasks.map((t) => t.id)).toContain(first.tasks[0]!.id);
  });

  it("persistOrRevisePlan picks the right path automatically", () => {
    const store = freshStore();
    expect(persistOrRevisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() }).planRevision).toBe(1);
    expect(persistOrRevisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() }).planRevision).toBe(2);
  });

  it("refuses revisePlan on a workflow with no plan yet", () => {
    const store = freshStore();
    expect(() => revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() })).toThrow(
      PlanPersistError,
    );
  });
});

describe("AC: a revision bump invalidates approvals on changed tasks (Stage 1 rules)", () => {
  function approve(store: Store, taskId: string, taskRevision: number, planRevision: number) {
    return store.approvals.insert(
      makeApproval({
        id: `ap-${taskId}-${taskRevision}` as never,
        scope: { kind: "task", taskId: taskId as never },
        taskRevision,
        planRevision,
      }),
    );
  }

  it("invalidates a task approval with task_revision_changed when its definition changed", () => {
    const store = freshStore();
    const first = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const approval = approve(store, first.tasks[0]!.id, 1, 1);
    const changed = minimalPlan({
      tasks: [planTask({ acceptanceCriteria: [{ id: "ac1", text: "It exports greet() and farewell()." }] })],
    });
    const second = revisePlan({ store, workflowId: WF, plan: changed, now: () => AT, newId: idFactory() });
    expect(second.invalidatedApprovals).toEqual([{ approvalId: approval.id, reason: "task_revision_changed" }]);
    expect(store.approvals.require(approval.id).invalidation?.reason).toBe("task_revision_changed");
  });

  it("invalidates an unchanged task's approval with plan_revision_changed", () => {
    const store = freshStore();
    const first = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const approval = approve(store, first.tasks[0]!.id, 1, 1);
    revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(store.approvals.require(approval.id).invalidation?.reason).toBe("plan_revision_changed");
  });

  it("invalidates the approval of a task this revision dropped", () => {
    const store = freshStore();
    const plan = minimalPlan({ tasks: [planTask({ id: "t1" }), planTask({ id: "t2", goal: "Drop me" })] });
    const first = persistPlan({ store, workflowId: WF, plan, now: () => AT, newId: idFactory() });
    const dropped = first.tasks.find((t) => t.goal === "Drop me")!;
    const approval = approve(store, dropped.id, 1, 1);
    revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(store.approvals.require(approval.id).invalidation?.reason).toBe("task_revision_changed");
  });

  it("invalidates nothing when the first plan is written", () => {
    const store = freshStore();
    const result = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(result.invalidatedApprovals).toEqual([]);
  });

  it("never reactivates an already-invalidated approval", () => {
    const store = freshStore();
    const first = persistPlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const approval = approve(store, first.tasks[0]!.id, 1, 1);
    revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    const second = revisePlan({ store, workflowId: WF, plan: minimalPlan(), now: () => AT, newId: idFactory() });
    expect(second.invalidatedApprovals).toEqual([]);
    expect(store.approvals.require(approval.id).invalidation?.reason).toBe("plan_revision_changed");
  });
});

describe("a persisted plan can be read back and inspected", () => {
  it("returns phases in order with their tasks", () => {
    const store = freshStore();
    const plan = minimalPlan({
      phases: [
        { id: "p1", order: 0, goal: "First", acceptanceCriteria: [{ id: "pac1", text: "done" }] },
        { id: "p2", order: 1, goal: "Second", acceptanceCriteria: [{ id: "pac2", text: "done" }] },
      ],
      tasks: [planTask({ id: "t1", phaseId: "p1" }), planTask({ id: "t2", phaseId: "p2", goal: "Second task" })],
    });
    persistPlan({ store, workflowId: WF, plan, now: () => AT, newId: idFactory() });
    const stored = readStoredPlan(store, WF);
    expect(stored.phases.map((p) => p.phase.goal)).toEqual(["First", "Second"]);
    expect(stored.phases[1]?.tasks[0]?.goal).toBe("Second task");
    expect(stored.workflow.planRevision).toBe(1);
  });
});
