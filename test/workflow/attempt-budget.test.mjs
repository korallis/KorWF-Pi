/**
 * #124 AC3: "A truncated attempt does not decrement the task's attempt budget, and its
 * feedback to the next attempt describes truncation rather than unmet criteria."
 * #124 AC4: "Repeated truncation is bounded and eventually surfaces as a distinct
 * failure, not an infinite retry."
 * #124 AC6: deterministic with Jev disabled.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ATTEMPT_BUDGET_LIMITS,
  EMPTY_ATTEMPT_BUDGET,
  attemptsRemaining,
  recordTurn,
} from "../../src/workflow/attempt-budget.ts";
import { settleTurn } from "../../src/workflow/attempt-controller.ts";
import { TRUNCATION_FEEDBACK, isHarnessFeedback } from "../../src/workers/truncation.ts";

const truncatedTurn = { stopReason: "length", exitCode: 0, outputTokens: 16_384, finalText: "Now writing docs/gates.md." };
const cleanTurn = { stopReason: "stop", exitCode: 0, outputTokens: 900, finalText: '{"status":"done"}' };
const limits = { ...DEFAULT_ATTEMPT_BUDGET_LIMITS, maxConsecutiveTruncations: 99, maxHarnessRetries: 99 };

test("AC3: a truncated turn does not decrement the attempt budget", () => {
  const decision = recordTurn("truncated", EMPTY_ATTEMPT_BUDGET, limits);
  assert.equal(decision.state.attemptsUsed, 0);
  assert.equal(decision.consumedAttempt, false);
  assert.equal(decision.next, "retry");
  assert.equal(attemptsRemaining(decision.state, limits), limits.maxAttempts);
});

test("AC3: six truncations in a row (the #14 signature) still leave the full attempt budget", () => {
  let state = EMPTY_ATTEMPT_BUDGET;
  for (let i = 0; i < 6; i += 1) state = recordTurn("truncated", state, limits).state;
  assert.equal(state.attemptsUsed, 0);
  assert.equal(state.harnessRetriesUsed, 6);
  assert.equal(attemptsRemaining(state, limits), limits.maxAttempts);
});

test("AC3: a quality failure does consume the attempt budget", () => {
  const decision = recordTurn("gap", EMPTY_ATTEMPT_BUDGET, limits);
  assert.equal(decision.state.attemptsUsed, 1);
  assert.equal(decision.consumedAttempt, true);
  assert.equal(decision.next, "retry");
});

test("AC3: truncation feedback describes truncation, never unmet criteria", () => {
  const settled = settleTurn({ observation: truncatedTurn, limits });
  assert.equal(settled.next, "retry");
  assert.equal(settled.feedback, TRUNCATION_FEEDBACK);
  assert.match(settled.feedback, /cut off at the output-token limit/);
  assert.match(settled.feedback, /nothing was written to disk/);
  assert.match(settled.feedback, /short write/);
  assert.match(settled.feedback, /commit after each file/i);
  assert.equal(isHarnessFeedback(settled.feedback), true);
  assert.equal(/criteri/i.test(settled.feedback.replace(/The criteria were not assessed[^.]*\./, "")), false);
});

test("AC3: a truncated turn's gate result is ignored — there was no work to judge", () => {
  const settled = settleTurn({
    observation: truncatedTurn,
    gate: { passed: false, feedback: "Unmet (p=0.92): worker overclaims, criteria unmet." },
    limits,
  });
  assert.equal(settled.classification.failureClass, "harness");
  assert.equal(settled.telemetry.consumedAttemptBudget, false);
  assert.equal(settled.feedback, TRUNCATION_FEEDBACK);
  assert.equal(settled.feedback.includes("overclaim"), false);
});

test("AC4: repeated truncation is bounded and fails distinctly, never loops forever", () => {
  const bounded = { maxAttempts: 3, maxHarnessRetries: 5, maxConsecutiveTruncations: 2 };
  let state = EMPTY_ATTEMPT_BUDGET;
  const outcomes = [];
  for (let i = 0; i < 20; i += 1) {
    const d = recordTurn("truncated", state, bounded);
    state = d.state;
    outcomes.push(d);
    if (d.next === "fail") break;
  }
  const last = outcomes.at(-1);
  assert.equal(last.next, "fail");
  assert.equal(last.failure, "persistent_truncation");
  assert.equal(outcomes.length, 2, "must stop at maxConsecutiveTruncations, not loop");
  assert.equal(last.consumedAttempt, false);
  assert.match(last.reason, /over-sized/);
});

test("AC4: mixed harness failures are bounded by their own budget, distinct from attempts", () => {
  const bounded = { maxAttempts: 3, maxHarnessRetries: 3, maxConsecutiveTruncations: 99 };
  let state = EMPTY_ATTEMPT_BUDGET;
  const a = recordTurn("timeout", state, bounded); state = a.state;
  const b = recordTurn("truncated", state, bounded); state = b.state;
  const c = recordTurn("transport_error", state, bounded); state = c.state;
  assert.equal(a.next, "retry");
  assert.equal(b.next, "retry");
  assert.equal(c.next, "fail");
  assert.equal(c.failure, "harness_limit");
  assert.equal(state.attemptsUsed, 0);
});

test("AC4: an intervening non-truncated turn resets the consecutive-truncation counter", () => {
  const bounded = { maxAttempts: 5, maxHarnessRetries: 99, maxConsecutiveTruncations: 2 };
  let state = recordTurn("truncated", EMPTY_ATTEMPT_BUDGET, bounded).state;
  assert.equal(state.consecutiveTruncations, 1);
  state = recordTurn("gap", state, bounded).state;
  assert.equal(state.consecutiveTruncations, 0);
  const after = recordTurn("truncated", state, bounded);
  assert.equal(after.next, "retry");
  assert.equal(after.state.consecutiveTruncations, 1);
});

test("AC3/AC4: exhausting the attempt budget on real failures is a distinct terminal failure", () => {
  const bounded = { maxAttempts: 2, maxHarnessRetries: 99, maxConsecutiveTruncations: 99 };
  let state = recordTurn("gap", EMPTY_ATTEMPT_BUDGET, bounded).state;
  state = recordTurn("truncated", state, bounded).state;
  const last = recordTurn("gap", state, bounded);
  assert.equal(last.next, "fail");
  assert.equal(last.failure, "attempt_limit");
  assert.equal(last.state.attemptsUsed, 2);
});

test("AC6: settlement is deterministic and identical run to run with no Jev", () => {
  const once = JSON.stringify(settleTurn({ observation: truncatedTurn, limits }));
  for (let i = 0; i < 5; i += 1) {
    assert.equal(JSON.stringify(settleTurn({ observation: truncatedTurn, limits })), once);
  }
  const clean = settleTurn({ observation: cleanTurn, gate: { passed: true, feedback: "" }, limits });
  assert.equal(clean.next, "pass");
  assert.equal(clean.telemetry.consumedAttemptBudget, true);
});
