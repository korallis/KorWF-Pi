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
import { minimalPlan, planTask, planWithoutChecks } from "../../helpers/plan.ts";

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

describe("AC: a task with checks: [] is flagged no_checks and can never become ready (PLAN §2.3)", () => {
  it("accepts the plan but warns with the no_checks rule", () => {
    const result = validatePlanDocument(planWithoutChecks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.warnings.find((w) => w.rule === "no_checks");
    expect(warning?.path).toBe("tasks[0].checks");
    expect(warning?.severity).toBe("warning");
  });

  it("taskReadiness refuses readiness and names the blocker", () => {
    const readiness = taskReadiness({ id: "t1", checks: [] });
    expect(readiness.canBecomeReady).toBe(false);
    expect(readiness.blocker).toBe(NO_CHECKS_BLOCKER);
  });

  it("taskReadiness allows readiness once one check exists", () => {
    const readiness = taskReadiness(planTask());
    expect(readiness.canBecomeReady).toBe(true);
    expect(readiness.blocker).toBeNull();
  });

  it("there is no option that makes a checkless task ready", () => {
    // The signature takes only the task: no policy, no override, no flag.
    expect(taskReadiness({ id: "x", checks: [] }).canBecomeReady).toBe(false);
  });
});

describe("AC: checks must be executable, not prose (PLAN §2.3)", () => {
  it("rejects a command check whose command is a sentence", () => {
    const bad = planTask({
      checks: [{ ...planTask().checks[0]!, command: "Please run the tests and confirm they pass." }],
    });
    const result = validatePlanDocument(minimalPlan({ tasks: [bad] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: "tasks[0].checks[0].command", rule: "check_shape" });
  });

  it("accepts a human check whose command is an instruction", () => {
    const humanCheck = planTask({
      checks: [
        {
          id: "c1",
          kind: "human" as const,
          command: "Confirm the printed receipt is legible on paper.",
          cwd: ".",
          expectedExitCode: 0,
          coversCriteria: ["ac1"],
          required: true,
        },
      ],
    });
    expect(validatePlanDocument(minimalPlan({ tasks: [humanCheck] })).ok).toBe(true);
  });

  it("rejects coversCriteria that names a criterion not on the task", () => {
    const bad = planTask({ checks: [{ ...planTask().checks[0]!, coversCriteria: ["nope"] }] });
    const result = validatePlanDocument(minimalPlan({ tasks: [bad] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      path: "tasks[0].checks[0].coversCriteria[0]",
      rule: "unknown_reference",
    });
  });

  it("warns about an acceptance criterion no check covers", () => {
    const task = planTask({
      acceptanceCriteria: [
        { id: "ac1", text: "covered" },
        { id: "ac2", text: "not covered" },
      ],
    });
    const result = validatePlanDocument(minimalPlan({ tasks: [task] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.rule === "criterion_coverage")).toBe(true);
  });
});

describe("AC: paths are repository-relative (no machine-specific paths)", () => {
  it("rejects an absolute ownership path", () => {
    const result = validatePlanDocument(
      minimalPlan({ tasks: [planTask({ ownership: { paths: ["/etc/passwd"], components: [] } })] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: "tasks[0].ownership.paths[0]", rule: "path_shape" });
  });

  it("rejects a traversing ownership path", () => {
    const result = validatePlanDocument(
      minimalPlan({ tasks: [planTask({ ownership: { paths: ["../../secrets"], components: [] } })] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.rule).toBe("path_shape");
  });

  it("rejects an absolute check cwd", () => {
    const bad = planTask({ checks: [{ ...planTask().checks[0]!, cwd: "/tmp" }] });
    const result = validatePlanDocument(minimalPlan({ tasks: [bad] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path === "tasks[0].checks[0].cwd")).toBe(true);
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
