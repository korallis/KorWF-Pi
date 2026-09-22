/**
 * `src/workflow/planner.ts` (issue #37): the prompt, the bounded retry loop,
 * output-budget sizing, and the no-model deterministic fallback.
 *
 * No live model or Jev call: `PlannerModel` is a local function in every test.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLAN_ATTEMPTS,
  buildPlannerPrompt,
  deterministicPlanSkeleton,
  generatePlan,
  planSchemaText,
  sizePlanTasks,
  tasksNeedingDecomposition,
  type PlannerIntake,
} from "../../../src/workflow/planner.ts";
import { validatePlanDocument } from "../../../src/workflow/plan-schema.ts";
import { minimalPlan, planTask } from "../../helpers/plan.ts";

const SHA = "c".repeat(40);

function intake(overrides: Partial<PlannerIntake> = {}): PlannerIntake {
  return {
    goal: "Add a greeting module",
    greenfield: false,
    repoName: "sample",
    baseRevision: SHA,
    exclusions: [],
    mode: "supervised",
    clarifications: [],
    ...overrides,
  };
}

describe("planner prompt embeds intake, context and the schema", () => {
  it("includes the goal, mode and exclusions", () => {
    const prompt = buildPlannerPrompt({
      intake: intake({ exclusions: ["vendor/**"] }),
      context: [],
    });
    expect(prompt).toContain("Add a greeting module");
    expect(prompt).toContain("mode: supervised");
    expect(prompt).toContain("vendor/**");
  });

  it("embeds the schema generated from plan-schema.ts, so the two cannot drift", () => {
    const prompt = buildPlannerPrompt({ intake: intake(), context: [] });
    expect(prompt).toContain(planSchemaText());
  });

  it("states the per-task check rule that is enforced in code", () => {
    const prompt = buildPlannerPrompt({ intake: intake(), context: [] });
    expect(prompt).toContain("Every task carries at least one verification check");
  });

  it("carries the full provenance of every excerpt (PLAN §3.B)", () => {
    const prompt = buildPlannerPrompt({
      intake: intake(),
      context: [
        {
          text: "export function greet() {}",
          provenance: {
            revision: SHA,
            path: "src/example.ts",
            range: { startLine: 1, endLine: 3 },
            retrievalMethod: "search",
            contentHash: "d".repeat(64),
          },
        },
      ],
    });
    expect(prompt).toContain("src/example.ts (lines 1-3)");
    expect(prompt).toContain(SHA.slice(0, 12));
    expect(prompt).toContain("retrieved by search");
    expect(prompt).toContain("d".repeat(12));
  });

  it("marks a pinned excerpt as one that must be honoured", () => {
    const prompt = buildPlannerPrompt({
      intake: intake(),
      context: [
        {
          text: "always do this",
          pinned: true,
          provenance: {
            revision: SHA,
            path: "AGENTS.md",
            range: null,
            retrievalMethod: "pinned",
            contentHash: "e".repeat(64),
          },
        },
      ],
    });
    expect(prompt).toContain("pinned (must be honoured)");
  });

  it("tells the planner to bootstrap phase 0 for a greenfield repository", () => {
    const prompt = buildPlannerPrompt({ intake: intake({ greenfield: true }), context: [] });
    expect(prompt).toContain("Phase 0 must bootstrap");
  });
});
