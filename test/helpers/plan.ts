/**
 * Plan document fixtures (issue #37).
 *
 * Every value is fabricated: no machine paths, no provider names, no
 * credentials. `minimalPlan()` is the smallest document that passes
 * `validatePlanDocument` with no warnings.
 */
import type { PlanDocument, PlanPhase, PlanTask } from "../../src/workflow/plan-schema.ts";

export function planTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: "t1",
    phaseId: "p1",
    goal: "Add the example module",
    acceptanceCriteria: [{ id: "ac1", text: "The example module exports greet()." }],
    checks: [
      {
        id: "c1",
        kind: "command",
        command: "npm test -- example",
        cwd: ".",
        expectedExitCode: 0,
        coversCriteria: ["ac1"],
        required: true,
      },
    ],
    ownership: { paths: ["src/example.ts"], components: ["example"] },
    dependencies: [],
    riskClass: "low",
    ...overrides,
  };
}

export function planPhase(overrides: Partial<PlanPhase> = {}): PlanPhase {
  return {
    id: "p1",
    order: 0,
    goal: "Build the example",
    acceptanceCriteria: [{ id: "pac1", text: "The example builds and its tests pass." }],
    ...overrides,
  };
}

export function minimalPlan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    schemaVersion: 1,
    architectureSummary: "One module, one test file.",
    phases: [planPhase()],
    tasks: [planTask()],
    ...overrides,
  };
}

/** A plan whose single task declares no checks — the PLAN §2.3 case. */
export function planWithoutChecks(): PlanDocument {
  return minimalPlan({ tasks: [planTask({ checks: [] })] });
}
