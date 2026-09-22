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

describe("AC: malformed planner output produces a retry prompt and is never returned", () => {
  it("retries with the findings and succeeds on the second attempt", async () => {
    const prompts: string[] = [];
    const result = await generatePlan({
      intake: intake(),
      context: [],
      model: (prompt, attempt) => {
        prompts.push(prompt);
        return attempt === 1 ? "not a plan" : minimalPlan();
      },
    });
    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Nothing was saved");
  });

  it("gives up after maxAttempts and returns errors, not a plan", async () => {
    let calls = 0;
    const result = await generatePlan({
      intake: intake(),
      context: [],
      maxAttempts: 2,
      model: () => {
        calls += 1;
        return "{}";
      },
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toHaveLength(2);
    expect(result.message).toContain("nothing was saved");
    expect("plan" in result).toBe(false);
  });

  it("defaults to the documented attempt count", async () => {
    let calls = 0;
    await generatePlan({
      intake: intake(),
      context: [],
      model: () => {
        calls += 1;
        return "nope";
      },
    });
    expect(calls).toBe(DEFAULT_PLAN_ATTEMPTS);
  });

  it("records a thrown model error as an attempt and keeps going", async () => {
    const result = await generatePlan({
      intake: intake(),
      context: [],
      maxAttempts: 2,
      model: (_prompt, attempt) => {
        if (attempt === 1) throw new Error("transport exploded");
        return minimalPlan();
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts[0]?.errors[0]?.message).toContain("transport exploded");
  });

  it("returns the no_checks warning alongside a successful plan", async () => {
    const result = await generatePlan({
      intake: intake(),
      context: [],
      model: () => minimalPlan({ tasks: [planTask({ checks: [] })] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.rule === "no_checks")).toBe(true);
  });
});
