/**
 * `src/workflow/plan-parse.ts` (issue #37): turning planner output into a
 * validated plan, and the retry prompt a rejection produces.
 */
import { describe, it, expect } from "vitest";
import { MAX_PLAN_BYTES, buildRetryPrompt, extractJson, parsePlanOutput } from "../../../src/workflow/plan-parse.ts";
import { minimalPlan, planTask, planWithoutChecks } from "../../helpers/plan.ts";

describe("AC: malformed planner output is rejected, never persisted partially", () => {
  it("rejects output that is not JSON at all and returns a retry prompt", () => {
    const result = parsePlanOutput("I had some thoughts about the architecture but no plan.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("not valid JSON");
    expect(result.retryPrompt).toContain("Nothing was saved");
  });

  it("rejects empty output", () => {
    const result = parsePlanOutput("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("no output");
  });

  it("returns no plan object at all on failure (nothing partial escapes)", () => {
    const result = parsePlanOutput({ architectureSummary: "half a plan" });
    expect(result.ok).toBe(false);
    expect("plan" in result).toBe(false);
  });

  it("refuses output larger than the documented ceiling", () => {
    const huge = `{"pad":"${"x".repeat(MAX_PLAN_BYTES)}"}`;
    const result = parsePlanOutput(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("exceeds");
  });
});

describe("AC: the retry prompt quotes the actual findings", () => {
  it("names every failing path so a retry is not a blind re-roll", () => {
    const result = parsePlanOutput(minimalPlan({ tasks: [planTask({ goal: "" })] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryPrompt).toContain("tasks[0].goal");
    expect(result.retryPrompt).toContain("Return only the JSON plan document.");
  });

  it("restates the checks rule in the retry prompt", () => {
    const prompt = buildRetryPrompt(
      [{ rule: "type", path: "tasks", severity: "error", message: "boom" }],
      [{ rule: "no_checks", path: "tasks[0].checks", severity: "warning", message: "no checks" }],
    );
    expect(prompt).toContain("Every task needs at least one check");
    expect(prompt).toContain("tasks[0].checks");
  });

  it("caps the number of quoted findings so the prompt stays small", () => {
    const many = Array.from({ length: 60 }, (_unused, i) => ({
      rule: "type" as const,
      path: `tasks[${i}].goal`,
      severity: "error" as const,
      message: "bad",
    }));
    const prompt = buildRetryPrompt(many, []);
    expect(prompt).toContain("and 35 more error(s)");
  });
});

describe("planner output arrives as an object, a JSON string, or a fenced block", () => {
  it("accepts an already-parsed object (the structured-output tool-call path)", () => {
    expect(parsePlanOutput(minimalPlan()).ok).toBe(true);
  });

  it("accepts a bare JSON string", () => {
    expect(parsePlanOutput(JSON.stringify(minimalPlan())).ok).toBe(true);
  });

  it("accepts a fenced json block with prose around it", () => {
    const fence = "```";
    const text = `Here is the plan.\n\n${fence}json\n${JSON.stringify(minimalPlan())}\n${fence}\n\nLet me know.`;
    expect(parsePlanOutput(text).ok).toBe(true);
  });

  it("does not truncate at a brace inside a check command string", () => {
    const base = planTask();
    const plan = minimalPlan({
      tasks: [planTask({ checks: [{ ...base.checks[0]!, command: 'npm test -- --grep "{a}"' }] })],
    });
    const extracted = extractJson(`preamble ${JSON.stringify(plan)} trailer`);
    expect(extracted.ok).toBe(true);
  });

  it("surfaces the no_checks warning on a successful parse", () => {
    const result = parsePlanOutput(planWithoutChecks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.rule === "no_checks")).toBe(true);
  });
});
