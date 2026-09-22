/**
 * Issue #52: `failure.classify@1` and `stall.repeated_approach@1` exist,
 * are registered with a pinned hash, and have deterministic fallbacks that
 * never guess (AC1: "unknown must be a real category that asks for
 * evidence").
 */
import { describe, it, expect } from "vitest";
import {
  FAILURE_QUESTION_HASHES,
  failureClassifyQuestion,
  failureQuestionRegistry,
  stallRepeatedApproachQuestion,
  type FailureClassifyState,
  type RepeatedApproachState,
} from "../../../src/decisions/questions/failure.ts";
import { FAILURE_CATEGORIES } from "../../../src/workflow/failure.ts";

const FAILURE_STATE: FailureClassifyState = {
  command: "npm test",
  exitCode: 1,
  stderrTail: "something happened",
  stdoutTail: "",
  taskGoal: "make the test pass",
};

const APPROACH_STATE: RepeatedApproachState = {
  taskGoal: "make the test pass",
  previousApproach: "patched the assertion",
  currentApproach: "patched the assertion differently",
  previousFailure: "assertion still failed",
};

describe("AC1 failure.classify@1", () => {
  it("AC1 is registered at id@version with its reviewed content hash", () => {
    expect(failureClassifyQuestion.key).toBe("failure.classify@1");
    expect(FAILURE_QUESTION_HASHES["failure.classify@1"]).toBe(failureClassifyQuestion.contentHash);
    expect(failureQuestionRegistry.get("failure.classify@1")).toBe(failureClassifyQuestion);
  });

  it("AC1 offers exactly the taxonomy categories as options", () => {
    const question = failureClassifyQuestion.buildQuestion(FAILURE_STATE);
    const options = question.type === "choice" ? Object.keys(question.criteria) : [];
    expect(options.sort()).toEqual([...FAILURE_CATEGORIES].sort());
  });

  it("AC1 falls back to unknown with no key, for every reason", () => {
    for (const reason of ["disabled", "transport_error", "abstained", "invalid_response"] as const) {
      expect(failureClassifyQuestion.fallback(FAILURE_STATE, reason).value).toBe("unknown");
    }
  });

  it("AC1 an out-of-band choice is coerced to unknown, never to a guess", () => {
    const interpreted = failureClassifyQuestion.interpret(
      { type: "choice", choice: "cosmic_rays", confidence: 0.99 },
      FAILURE_STATE,
    );
    expect(interpreted?.value).toBe("unknown");
  });

  it("AC1 state sent outbound is minimal: only the declared fields", () => {
    expect(Object.keys(failureClassifyQuestion.buildState(FAILURE_STATE)).sort()).toEqual([
      "command",
      "exitCode",
      "stderrTail",
      "stdoutTail",
      "taskGoal",
    ]);
  });
});

describe("AC2 stall.repeated_approach@1", () => {
  it("AC2 is registered at id@version with its reviewed content hash", () => {
    expect(stallRepeatedApproachQuestion.key).toBe("stall.repeated_approach@1");
    expect(FAILURE_QUESTION_HASHES["stall.repeated_approach@1"]).toBe(stallRepeatedApproachQuestion.contentHash);
    expect(failureQuestionRegistry.get("stall.repeated_approach@1")).toBe(stallRepeatedApproachQuestion);
  });

  it("AC2 falls back to not_repeated, never inventing a stall without a key", () => {
    for (const reason of ["disabled", "transport_error", "abstained", "invalid_response"] as const) {
      expect(stallRepeatedApproachQuestion.fallback(APPROACH_STATE, reason).value).toBe("not_repeated");
    }
  });

  it("AC2 an unrecognised choice becomes unknown, not repeated", () => {
    const interpreted = stallRepeatedApproachQuestion.interpret(
      { type: "choice", choice: "maybe", confidence: 0.9 },
      APPROACH_STATE,
    );
    expect(interpreted?.value).toBe("unknown");
  });
});
