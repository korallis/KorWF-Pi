/**
 * `tasks.coupling@1` (issue #76; PLAN §3.E "Jev adds a semantic-coupling
 * signal; default to serial when coupling is uncertain").
 *
 * The property under test is one-directional: this question may only ever
 * *subtract* concurrency. Its fallback is the constant `unknown`, which
 * `src/workflow/coupling.ts` turns into serial execution, so every no-answer
 * path — no key, abstention, malformed response, deadline — is the safe one.
 */
import { describe, it, expect } from "vitest";
import {
  COUPLING_FALLBACK_VERDICT,
  couplingQuestionRegistry,
  couplingState,
  tasksCouplingQuestion,
  COUPLING_QUESTION_HASHES,
  type CouplingState,
} from "../../../src/decisions/questions/coupling.ts";
import { assertBoundaries } from "../../../src/decisions/question.ts";

const STATE: CouplingState = {
  a: {
    id: "tk-a",
    goal: "add a `total` field to the /orders response",
    acceptanceCriteria: ["the field is present"],
    ownershipPaths: ["src/api/orders.ts"],
    ownershipComponents: ["api"],
  },
  b: {
    id: "tk-b",
    goal: "show the order total on the dashboard",
    acceptanceCriteria: ["the total renders"],
    ownershipPaths: ["src/ui/dashboard.tsx"],
    ownershipComponents: ["ui"],
  },
};

describe("tasks.coupling@1 registration", () => {
  it("is registered at id@version with its reviewed content hash", () => {
    expect(tasksCouplingQuestion.key).toBe("tasks.coupling@1");
    expect(COUPLING_QUESTION_HASHES["tasks.coupling@1"]).toBe(tasksCouplingQuestion.contentHash);
    expect(couplingQuestionRegistry.get("tasks.coupling@1")).toBe(tasksCouplingQuestion);
  });

  it("offers exactly independent / coupled / unknown, with unknown explicit", () => {
    const question = tasksCouplingQuestion.buildQuestion();
    const options = question.type === "choice" ? Object.keys(question.criteria) : [];
    expect(options.sort()).toEqual(["coupled", "independent", "unknown"]);
  });

  it("its declared boundary cases hold against the deterministic fallback", () => {
    expect(() => assertBoundaries(tasksCouplingQuestion)).not.toThrow();
  });
});

describe("AC2: the fallback is unknown, so no key means serial", () => {
  it("falls back to unknown for every reason, never to independent", () => {
    for (const reason of ["disabled", "transport_error", "abstained", "invalid_response"] as const) {
      expect(tasksCouplingQuestion.fallback(STATE, reason).value).toBe("unknown");
    }
    expect(COUPLING_FALLBACK_VERDICT).toBe("unknown");
  });

  it("an out-of-band choice is coerced to unknown, not to a guess", () => {
    const interpreted = tasksCouplingQuestion.interpret(
      { type: "choice", choice: "probably_fine", confidence: 0.99, probabilities: { probably_fine: 1 } },
      STATE,
    );
    expect(interpreted?.value).toBe("unknown");
  });

  it("a weakly-held answer is below minConfidence and therefore abstains", () => {
    expect(tasksCouplingQuestion.minConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("interpretation preserves independent and coupled when they are given", () => {
    for (const choice of ["independent", "coupled"] as const) {
      const interpreted = tasksCouplingQuestion.interpret(
        { type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 1 } },
        STATE,
      );
      expect(interpreted?.value).toBe(choice);
    }
  });

  it("replay round-trips every verdict and rejects anything else", () => {
    for (const action of ["independent", "coupled", "unknown"]) {
      expect(tasksCouplingQuestion.replay(action, STATE)).toBe(action);
    }
    expect(tasksCouplingQuestion.replay("parallel", STATE)).toBeNull();
  });
});

describe("minimal relevant state (PLAN §6): goals, criteria and declared ownership only", () => {
  it("sends exactly two task views and nothing else", () => {
    const state = couplingState(STATE) as Record<string, Record<string, unknown>>;
    expect(Object.keys(state).sort()).toEqual(["taskA", "taskB"]);
    expect(Object.keys(state["taskA"] ?? {}).sort()).toEqual([
      "acceptanceCriteria",
      "goal",
      "id",
      "ownership",
    ]);
  });

  it("orders the pair canonically, so (a,b) and (b,a) hash identically", () => {
    expect(couplingState(STATE)).toEqual(couplingState({ a: STATE.b, b: STATE.a }));
  });

  it("carries no file contents — only the patterns the planner already wrote down", () => {
    const serialised = JSON.stringify(couplingState(STATE));
    expect(serialised).toContain("src/api/orders.ts");
    expect(serialised).not.toContain("export ");
  });
});
