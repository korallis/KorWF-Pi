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
