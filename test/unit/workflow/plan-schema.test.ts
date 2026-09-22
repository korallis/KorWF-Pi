/**
 * `src/workflow/plan-schema.ts` (issue #37): the plan document contract,
 * path-qualified validation, and the dependency graph.
 */
import { describe, it, expect } from "vitest";
import {
  NO_CHECKS_BLOCKER,
  formatPlanIssues,
  ownershipOverlaps,
  taskReadiness,
  validateDependencyGraph,
  validatePlanDocument,
  type PlanTask,
} from "../../../src/workflow/plan-schema.ts";
import { minimalPlan, planTask } from "../../helpers/plan.ts";

describe("AC: validatePlanDocument accepts a well-formed plan", () => {
  it("accepts the minimal plan and returns it normalised", () => {
    const result = validatePlanDocument(minimalPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.phases).toHaveLength(1);
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.schemaVersion).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("sorts phases by order regardless of document order", () => {
    const plan = minimalPlan({
      phases: [
        { id: "p2", order: 1, goal: "Second", acceptanceCriteria: [{ id: "pac2", text: "done" }] },
        { id: "p1", order: 0, goal: "First", acceptanceCriteria: [{ id: "pac1", text: "done" }] },
      ],
      tasks: [planTask({ id: "t1", phaseId: "p1" }), planTask({ id: "t2", phaseId: "p2" })],
    });
    const result = validatePlanDocument(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.phases.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("AC: malformed planner output is rejected with a path-qualified error", () => {
  it("rejects a non-object document", () => {
    const result = validatePlanDocument([1, 2, 3]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("");
    expect(result.errors[0]?.message).toContain("expected a plan object");
  });

  it("reports the exact index path of a bad task field", () => {
    const plan = minimalPlan({ tasks: [planTask(), planTask({ id: "t2", goal: "" })] });
    const result = validatePlanDocument(plan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toContain("tasks[1].goal");
  });

  it("reports the exact index path of a bad check field", () => {
    const bad = planTask({ checks: [{ ...planTask().checks[0]!, kind: "magic" as never }] });
    const result = validatePlanDocument(minimalPlan({ tasks: [bad] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.errors.find((e) => e.path === "tasks[0].checks[0].kind");
    expect(issue?.rule).toBe("enum");
  });

  it("collects every error rather than stopping at the first", () => {
    const result = validatePlanDocument({ schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path).sort()).toEqual(["architectureSummary", "phases", "tasks"]);
  });

  it("rejects an unsupported schema version rather than guessing", () => {
    const result = validatePlanDocument(minimalPlan({ schemaVersion: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "schemaVersion")).toBe(true);
  });

  it("rejects duplicate task ids", () => {
    const result = validatePlanDocument(minimalPlan({ tasks: [planTask(), planTask()] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.rule === "duplicate_id")).toBe(true);
  });

  it("rejects a task pointing at a phase that does not exist", () => {
    const result = validatePlanDocument(minimalPlan({ tasks: [planTask({ phaseId: "nope" })] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: "tasks[0].phaseId", rule: "unknown_reference" });
  });

  it("rejects a phase order sequence with a gap", () => {
    const plan = minimalPlan({
      phases: [planPhaseAt(0), planPhaseAt(2)],
      tasks: [planTask({ phaseId: "p0" }), planTask({ id: "t2", phaseId: "p2" })],
    });
    const result = validatePlanDocument(plan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.rule === "phase_order")).toBe(true);
  });

  it("formats findings as one path-qualified line each", () => {
    const result = validatePlanDocument({ schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = formatPlanIssues(result.errors);
    expect(text).toContain("! phases:");
    expect(text).toContain("[required]");
  });
});

function planPhaseAt(order: number) {
  return {
    id: `p${order}`,
    order,
    goal: `Phase ${order}`,
    acceptanceCriteria: [{ id: `pac${order}`, text: "done" }],
  };
}
