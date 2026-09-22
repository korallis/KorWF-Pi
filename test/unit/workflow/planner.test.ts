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
  greenfieldScaffoldingIssues,
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

describe("generated tasks are sized against the model's output ceiling (#124)", () => {
  const limits = { maxTokens: 16_384, contextWindow: 200_000 };

  it("marks a task whose single artifact exceeds the decompose fraction", () => {
    const plan = minimalPlan({
      tasks: [
        planTask({
          expectedArtifacts: [{ path: "src/huge.ts", estimate: { unit: "lines", value: 4_000 } }],
        }),
      ],
    });
    const sizing = sizePlanTasks(plan, limits);
    expect(sizing[0]?.sizing.mustDecompose).toBe(true);
    expect(tasksNeedingDecomposition(sizing)).toEqual(["t1"]);
  });

  it("leaves a small artifact alone", () => {
    const plan = minimalPlan({
      tasks: [planTask({ expectedArtifacts: [{ path: "src/small.ts", estimate: { unit: "lines", value: 40 } }] })],
    });
    const sizing = sizePlanTasks(plan, limits);
    expect(sizing[0]?.sizing.verdict).toBe("fits");
    expect(tasksNeedingDecomposition(sizing)).toEqual([]);
  });

  it("produces incremental write-then-edit steps for an over-budget artifact", () => {
    const plan = minimalPlan({
      tasks: [planTask({ expectedArtifacts: [{ path: "docs/big.md", estimate: { unit: "lines", value: 3_000 } }] })],
    });
    const steps = sizePlanTasks(plan, limits)[0]?.decompositions[0]?.steps ?? [];
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0]?.kind).toBe("write");
    expect(steps[1]?.kind).toBe("edit");
  });

  it("still sizes when the model reports no ceiling (unreported is not unlimited)", () => {
    const plan = minimalPlan({
      tasks: [planTask({ expectedArtifacts: [{ path: "src/x.ts", estimate: { unit: "tokens", value: 12_000 } }] })],
    });
    const sizing = sizePlanTasks(plan);
    expect(sizing[0]?.sizing.budget.assumed).toBe(true);
    expect(sizing[0]?.sizing.mustDecompose).toBe(true);
  });

  it("flags rather than splits an artifact the planner declared atomic", () => {
    const plan = minimalPlan({
      tasks: [
        planTask({
          expectedArtifacts: [{ path: "src/blob.bin", estimate: { unit: "tokens", value: 40_000 }, atomic: true }],
        }),
      ],
    });
    expect(sizePlanTasks(plan, limits)[0]?.sizing.verdict).toBe("flag");
  });

  it("generatePlan returns sizing for every task", async () => {
    const result = await generatePlan({
      intake: intake(),
      context: [],
      workerLimits: limits,
      model: () => minimalPlan(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sizing).toHaveLength(1);
  });

  it("puts the worker model's ceiling in the prompt so the planner can size tasks", () => {
    const prompt = buildPlannerPrompt({ intake: intake(), context: [], workerLimits: limits });
    expect(prompt).toContain("16384");
    expect(prompt).toContain("not its context window");
  });
});

describe("AC: greenfield plans need test scaffolding in phase 0 (PLAN §2.3, §2.7)", () => {
  it("warns when phase 0 registers no executable check", () => {
    const plan = minimalPlan({
      tasks: [
        planTask({
          checks: [
            {
              id: "c1",
              kind: "human" as const,
              command: "Look at it and decide whether it seems fine.",
              cwd: ".",
              expectedExitCode: 0,
              coversCriteria: ["ac1"],
              required: true,
            },
          ],
        }),
      ],
    });
    const issues = greenfieldScaffoldingIssues(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("runnable test harness");
  });

  it("does not warn when phase 0 registers a command check", () => {
    expect(greenfieldScaffoldingIssues(minimalPlan())).toEqual([]);
  });

  it("generatePlan surfaces the warning only for a greenfield intake", async () => {
    const humanOnly = minimalPlan({
      tasks: [
        planTask({
          checks: [
            {
              id: "c1",
              kind: "human" as const,
              command: "Inspect the output by hand.",
              cwd: ".",
              expectedExitCode: 0,
              coversCriteria: ["ac1"],
              required: true,
            },
          ],
        }),
      ],
    });
    const green = await generatePlan({ intake: intake({ greenfield: true }), context: [], model: () => humanOnly });
    const brown = await generatePlan({ intake: intake({ greenfield: false }), context: [], model: () => humanOnly });
    expect(green.ok && green.warnings.some((w) => w.message.includes("runnable test harness"))).toBe(true);
    expect(brown.ok && brown.warnings.some((w) => w.message.includes("runnable test harness"))).toBe(false);
  });
});

describe("deterministic fallback: a valid plan with no model call (AGENTS.md §4)", () => {
  it("produces a document that passes its own validator", () => {
    expect(validatePlanDocument(deterministicPlanSkeleton(intake())).ok).toBe(true);
  });

  it("satisfies PLAN §2.3 with an explicitly required human check", () => {
    const plan = deterministicPlanSkeleton(intake());
    expect(plan.tasks[0]?.checks).toHaveLength(1);
    expect(plan.tasks[0]?.checks[0]?.kind).toBe("human");
    expect(plan.tasks[0]?.checks[0]?.required).toBe(true);
  });

  it("says plainly that nothing was analysed rather than inventing work", () => {
    const plan = deterministicPlanSkeleton(intake());
    expect(plan.architectureSummary).toContain("No planner model was available");
    expect(plan.openQuestions?.[0]).toContain("no model call");
  });
});
