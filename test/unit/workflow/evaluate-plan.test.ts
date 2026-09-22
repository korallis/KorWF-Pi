/**
 * `src/workflow/evaluate-plan.ts` (issue #39).
 *
 * AC: "Task without checks is never `ready` regardless of Jev output (mock
 * returns atomic+covered → still blocked)."
 * AC: "Coverage gaps (intake requirement covered by no task) are listed for
 * the user."
 * AC: "Disabled Jev shows `not_evaluated` for semantic fields in the board."
 */
import { describe, expect, it } from "vitest";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import {
  composeTaskReadiness,
  evaluatePlan,
  formatPlanEvaluation,
  formatSemanticField,
  type IntakeRequirement,
} from "../../../src/workflow/evaluate-plan.ts";
import { taskReadiness } from "../../../src/workflow/plan-schema.ts";
import { planTask } from "../../helpers/plan.ts";

const MODEL = "jev-test";

/** Full-distribution choice answer: `choice` gets 0.9, every other option splits the rest. */
function choiceAnswer(options: readonly string[], choice: string, confidence = 0.9): unknown {
  const rest = options.filter((o) => o !== choice);
  const each = rest.length === 0 ? 0 : (1 - 0.9) / rest.length;
  const probabilities: Record<string, number> = { [choice]: 0.9 };
  for (const o of rest) probabilities[o] = each;
  return { type: "choice", choice, probabilities, confidence };
}

/** Full-distribution score answer: `level` gets 0.9, every other level splits the rest. */
function scoreAnswer(levelCount: number, level: number, confidence = 0.9): unknown {
  const probabilities: Record<string, number> = {};
  const rest = levelCount - 1;
  for (let i = 0; i < levelCount; i += 1) probabilities[String(i)] = i === level ? 0.9 : rest === 0 ? 0 : 0.1 / rest;
  const legend = Object.fromEntries(Array.from({ length: levelCount }, (_, i) => [String(i), `level ${i}`]));
  return { type: "score", score: level, legend, probabilities, confidence };
}

function mockCtx(): AskContext {
  return {
    transport: new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([key, question]) => {
              if (question.type === "choice") {
                const options = Object.keys(question.criteria);
                return [key, choiceAnswer(options, options.includes("atomic") ? "atomic" : options[0] ?? "")];
              }
              if (question.type === "noul") return [key, { type: "noul", noul: 0.95 }];
              return [key, scoreAnswer(question.criteria.length, 0)];
            }),
          ),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req-1",
        attempts: 1,
        elapsedMs: 1,
      }),
    }),
    model: MODEL,
  };
}

function disabledCtx(): AskContext {
  return { transport: new DisabledJevTransport("no key"), model: MODEL };
}

describe("AC: task without checks is never ready regardless of Jev output", () => {
  it("blocked by no_checks even when the mock returns atomic+covered", async () => {
    const task = planTask({ checks: [] });
    const requirement: IntakeRequirement = { id: "r1", text: "add the example module" };
    const evaluation = await evaluatePlan([task], [requirement], mockCtx());
    const [taskEval] = evaluation.tasks;
    expect(taskEval).toBeDefined();
    expect(taskEval!.atomic).toEqual({ evaluated: true, value: "atomic", source: "jev" });
    expect(taskEval!.canBecomeReady).toBe(false);
    expect(taskEval!.blockers).toContain("no_checks");
  });

  it("composeTaskReadiness cannot be overridden by an atomic verdict", () => {
    const readiness = taskReadiness({ id: "t1", checks: [] });
    const composed = composeTaskReadiness(readiness, { evaluated: true, value: "atomic", source: "jev" });
    expect(composed.canBecomeReady).toBe(false);
    expect(composed.blockers).toEqual(["no_checks"]);
  });

  it("a composite verdict blocks a task that does have checks", () => {
    const readiness = taskReadiness({ id: "t1", checks: [{ id: "c1", kind: "command", command: "x", cwd: ".", expectedExitCode: 0, coversCriteria: [], required: true }] });
    const composed = composeTaskReadiness(readiness, { evaluated: true, value: "composite", source: "jev" });
    expect(composed.canBecomeReady).toBe(false);
    expect(composed.blockers).toEqual(["composite_task"]);
  });

  it("checks present and no composite verdict can become ready", () => {
    const readiness = taskReadiness({ id: "t1", checks: [{ id: "c1", kind: "command", command: "x", cwd: ".", expectedExitCode: 0, coversCriteria: [], required: true }] });
    const composed = composeTaskReadiness(readiness, { evaluated: false });
    expect(composed.canBecomeReady).toBe(true);
    expect(composed.blockers).toEqual([]);
  });
});

describe("AC: coverage gaps are listed for the user", () => {
  it("a requirement covered by no task is reported as a gap", async () => {
    const task = planTask();
    const requirements: IntakeRequirement[] = [
      { id: "r1", text: "the example module exports greet" },
      { id: "r2", text: "support dark mode theming across the settings screen" },
    ];
    const evaluation = await evaluatePlan([task], requirements, undefined);
    expect(evaluation.coverageGaps).toEqual(["r2"]);
  });

  it("a covered requirement is not a gap", async () => {
    const task = planTask();
    const requirements: IntakeRequirement[] = [{ id: "r1", text: "the example module exports greet" }];
    const evaluation = await evaluatePlan([task], requirements, undefined);
    expect(evaluation.coverageGaps).toEqual([]);
    expect(evaluation.tasks[0]!.coveredRequirements).toEqual(["r1"]);
  });
});

describe("AC: disabled Jev shows not_evaluated for semantic fields in the board", () => {
  it("atomic/ambiguity are not_evaluated with a disabled transport", async () => {
    const task = planTask();
    const evaluation = await evaluatePlan([task], [], disabledCtx());
    const [taskEval] = evaluation.tasks;
    expect(taskEval!.atomic).toEqual({ evaluated: false });
    expect(taskEval!.ambiguity).toEqual({ evaluated: false });
  });

  it("atomic/ambiguity are not_evaluated with no ctx at all", async () => {
    const task = planTask();
    const evaluation = await evaluatePlan([task], [], undefined);
    const [taskEval] = evaluation.tasks;
    expect(taskEval!.atomic).toEqual({ evaluated: false });
    expect(taskEval!.ambiguity).toEqual({ evaluated: false });
  });

  it("formatSemanticField renders not_evaluated literally", () => {
    expect(formatSemanticField({ evaluated: false }, (v: string) => v)).toBe("not_evaluated");
    expect(formatSemanticField({ evaluated: true, value: "atomic", source: "jev" }, (v: string) => v)).toBe("atomic");
  });

  it("formatPlanEvaluation includes not_evaluated and coverage gaps in the board text", async () => {
    const task = planTask({ checks: [] });
    const requirements: IntakeRequirement[] = [{ id: "r1", text: "support dark mode theming" }];
    const evaluation = await evaluatePlan([task], requirements, disabledCtx());
    const text = formatPlanEvaluation(evaluation);
    expect(text).toContain("not_evaluated");
    expect(text).toContain("Coverage gaps");
    expect(text).toContain("r1");
  });
});

describe("Jev-enabled path: task.atomic/ambiguity/coverage results are labelled source jev", () => {
  it("mock transport answers propagate as evaluated:true, source:jev", async () => {
    const task = planTask();
    const requirements: IntakeRequirement[] = [{ id: "r1", text: "unrelated requirement text with no overlap" }];
    const evaluation = await evaluatePlan([task], requirements, mockCtx());
    const [taskEval] = evaluation.tasks;
    expect(taskEval!.atomic).toEqual({ evaluated: true, value: "atomic", source: "jev" });
    expect(taskEval!.ambiguity).toEqual({ evaluated: true, value: 0, source: "jev" });
    // mock noul answers 0.95 for every coverage pair, so even an unrelated
    // requirement is marked covered by the semantic signal.
    expect(evaluation.coverageGaps).toEqual([]);
  });
});
