/**
 * `src/workflow/greenfield.ts` (issue #38; PLAN §2.7).
 *
 * Acceptance criterion 1: "Greenfield plan always has Phase 0 with the three
 * mandated tasks and every feature phase depends on it (test)."
 */
import { describe, it, expect } from "vitest";
import {
  GREENFIELD_PHASE0_ROLES,
  featurePhasesDependOnPhase0,
  greenfieldPromptAddendum,
  isValidGreenfieldPlan,
  phase0Coverage,
  validateGreenfieldPlan,
} from "../../../src/workflow/greenfield.ts";
import { planPhase, planTask, minimalPlan } from "../../helpers/plan.ts";
import type { PlanDocument } from "../../../src/workflow/plan-schema.ts";

function repoInitTask() {
  return planTask({
    id: "t0a",
    phaseId: "p0",
    goal: "Initialise version control",
    checks: [
      {
        id: "c0a",
        kind: "command",
        command: "git init",
        cwd: ".",
        expectedExitCode: 0,
        coversCriteria: ["ac1"],
        required: true,
      },
    ],
    ownership: { paths: [], components: ["repo"] },
  });
}

function scaffoldTask() {
  return planTask({
    id: "t0b",
    phaseId: "p0",
    goal: "Scaffold the package",
    checks: [
      {
        id: "c0b",
        kind: "command",
        command: "npm init -y",
        cwd: ".",
        expectedExitCode: 0,
        coversCriteria: ["ac1"],
        required: true,
      },
    ],
    ownership: { paths: ["package.json"], components: ["scaffold"] },
    dependencies: ["t0a"],
  });
}

function testInfraTask() {
  return planTask({
    id: "t0c",
    phaseId: "p0",
    goal: "Set up the test runner",
    checks: [
      {
        id: "c0c",
        kind: "command",
        command: "npm test",
        cwd: ".",
        expectedExitCode: 0,
        coversCriteria: ["ac1"],
        required: true,
      },
    ],
    ownership: { paths: ["test/"], components: ["test-infra"] },
    dependencies: ["t0b"],
  });
}

function featureTask(id: string, dependsOnPhase0: boolean) {
  return planTask({
    id,
    phaseId: "p1",
    goal: `Implement feature ${id}`,
    dependencies: dependsOnPhase0 ? ["t0c"] : [],
    ownership: { paths: [`src/${id}.ts`], components: [id] },
  });
}

function greenfieldPlan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return minimalPlan({
    phases: [planPhase({ id: "p0", order: 0 }), planPhase({ id: "p1", order: 1 })],
    tasks: [repoInitTask(), scaffoldTask(), testInfraTask(), featureTask("t1", true)],
    ...overrides,
  });
}

describe("phase0Coverage", () => {
  it("finds all three mandated roles when present", () => {
    const coverage = phase0Coverage(greenfieldPlan());
    expect(coverage.phaseId).toBe("p0");
    expect([...coverage.rolesCovered].sort()).toEqual([...GREENFIELD_PHASE0_ROLES].sort());
    expect(coverage.missingRoles).toEqual([]);
  });

  it("reports missing roles when phase 0 has no test-infra task", () => {
    const plan = greenfieldPlan({ tasks: [repoInitTask(), scaffoldTask(), featureTask("t1", true)] });
    const coverage = phase0Coverage(plan);
    expect(coverage.missingRoles).toEqual(["test_infra"]);
  });

  it("reports all roles missing when there is no phase with order 0", () => {
    const plan = greenfieldPlan({ phases: [planPhase({ id: "p0", order: 0, goal: "x" })], tasks: [] });
    // remove phase entirely to exercise the null-phase branch
    const noPhase0: PlanDocument = { ...plan, phases: [] };
    const coverage = phase0Coverage(noPhase0);
    expect(coverage.phaseId).toBeNull();
    expect(coverage.missingRoles).toEqual([...GREENFIELD_PHASE0_ROLES]);
  });
});

describe("validateGreenfieldPlan — acceptance criterion 1", () => {
  it("accepts a plan whose phase 0 has all three mandated tasks", () => {
    const plan = greenfieldPlan();
    expect(isValidGreenfieldPlan(plan)).toBe(true);
    const errors = validateGreenfieldPlan(plan).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("rejects a plan missing the repo_init task", () => {
    const plan = greenfieldPlan({ tasks: [scaffoldTask(), testInfraTask(), featureTask("t1", true)] });
    expect(isValidGreenfieldPlan(plan)).toBe(false);
    const errors = validateGreenfieldPlan(plan).filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("repo_init"))).toBe(true);
  });

  it("rejects a plan missing the scaffold task", () => {
    const plan = greenfieldPlan({ tasks: [repoInitTask(), testInfraTask(), featureTask("t1", true)] });
    const errors = validateGreenfieldPlan(plan).filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("scaffold"))).toBe(true);
  });

  it("rejects a plan missing the test_infra task", () => {
    const plan = greenfieldPlan({ tasks: [repoInitTask(), scaffoldTask(), featureTask("t1", true)] });
    const errors = validateGreenfieldPlan(plan).filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("test_infra"))).toBe(true);
  });

  it("rejects a plan with no phase 0 at all", () => {
    const plan: PlanDocument = { ...greenfieldPlan(), phases: [] };
    const errors = validateGreenfieldPlan(plan).filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("no phase with order 0"))).toBe(true);
  });
});

describe("featurePhasesDependOnPhase0 — every feature phase depends on phase 0", () => {
  it("is silent when every feature task depends on a phase 0 task", () => {
    const plan = greenfieldPlan();
    expect(featurePhasesDependOnPhase0(plan)).toEqual([]);
  });

  it("warns when a feature task declares no dependency on phase 0", () => {
    const plan = greenfieldPlan({ tasks: [repoInitTask(), scaffoldTask(), testInfraTask(), featureTask("t1", false)] });
    const issues = featurePhasesDependOnPhase0(plan);
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toContain("t1");
  });
});

describe("greenfieldPromptAddendum", () => {
  it("names all three mandated task roles", () => {
    const text = greenfieldPromptAddendum().join("\n");
    expect(text).toContain("repo_init");
    expect(text).toContain("scaffold");
    expect(text).toContain("test_infra");
    expect(text).toContain("git init");
  });
});
