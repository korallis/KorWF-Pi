/**
 * Regression for the failure documented in docs/PRD.md §3.3: six consecutive attempts on
 * issue #14 (~400k tokens) wrote zero files because each turn hit the 16384 output-token
 * ceiling before emitting its tool call, and the gate then reported "worker overclaims,
 * criteria unmet".
 *
 * Exercises AC1–AC4 together on that exact sequence.
 */
import { describe, it, expect } from "vitest";
import { EMPTY_ATTEMPT_BUDGET, type AttemptBudgetState } from "../../src/workflow/attempt-budget.ts";
import { settleTurn } from "../../src/workflow/attempt-controller.ts";
import { sizeTaskOutput } from "../../src/workflow/output-budget.ts";
import { TRUNCATION_FEEDBACK, isHarnessFeedback } from "../../src/workers/truncation.ts";

/** What #14 actually asked for: one large document in one turn. */
const ISSUE_14_TASK = [{ path: "docs/gates.md", estimate: { unit: "lines" as const, value: 900 } }];
const REGISTRY_MODEL = { maxTokens: 16_384, contextWindow: 200_000 };

/** The observed turn: ceiling hit, 28-character narration, no tool call, clean exit. */
const TRUNCATED_TURN = {
  stopReason: "length",
  exitCode: 0,
  outputTokens: 16_384,
  finalText: "Now writing docs/gates.md.",
};

describe("PRD §3.3 regression: the #14 sequence", () => {
  it("AC1: the task is flagged for decomposition before a worker is ever dispatched", () => {
    const sizing = sizeTaskOutput(ISSUE_14_TASK, REGISTRY_MODEL, "high");
    expect(sizing.mustDecompose).toBe(true);
    expect(sizing.artifacts[0]?.suggestedSteps).toBeGreaterThan(1);
    // The context window would have said this was comfortable.
    expect(sizing.totalEstimatedOutputTokens).toBeLessThan(REGISTRY_MODEL.contextWindow);
  });

  it("AC2–AC4: six truncations never consume an attempt, never claim unmet criteria, and stop", () => {
    let state: AttemptBudgetState = EMPTY_ATTEMPT_BUDGET;
    const settlements = [];
    for (let i = 0; i < 6; i += 1) {
      const settled = settleTurn({ observation: TRUNCATED_TURN, state });
      settlements.push(settled);
      state = settled.budget.state;
      if (settled.next === "fail") break;
    }

    // Bounded: it stopped at the consecutive-truncation limit, it did not run six times.
    const last = settlements.at(-1);
    expect(last?.next).toBe("fail");
    expect(last?.budget.failure).toBe("persistent_truncation");
    expect(settlements.length).toBeLessThan(6);

    // The attempt budget is untouched: nothing was ever judged.
    expect(state.attemptsUsed).toBe(0);

    for (const s of settlements) {
      expect(s.telemetry.stopReason).toBe("length");
      expect(s.telemetry.truncated).toBe(true);
      expect(s.telemetry.failureClass).toBe("harness");
      expect(s.telemetry.consumedAttemptBudget).toBe(false);
      if (s.feedback !== null) {
        expect(s.feedback).toBe(TRUNCATION_FEEDBACK);
        expect(isHarnessFeedback(s.feedback)).toBe(true);
      }
    }
    // The distinct terminal failure names the real cause, not the worker.
    expect(last?.budget.reason).toMatch(/over-sized/);
    expect(last?.budget.reason).toMatch(/never assessed/);
    expect(isHarnessFeedback(last?.budget.reason ?? "")).toBe(true);
  });

  it("AC1: after decomposition each step fits, so the same task can succeed", () => {
    const perStep = [{ path: "docs/gates.md", estimate: { unit: "lines" as const, value: 250 } }];
    expect(sizeTaskOutput(perStep, REGISTRY_MODEL, "high").mustDecompose).toBe(false);
  });
});
