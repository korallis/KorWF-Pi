/**
 * `task.atomic@1`, `task.coverage@1`, `task.ambiguity@1` (issue #39):
 * registration, content-hash pin, and deterministic structural fallbacks.
 */
import { describe, expect, it } from "vitest";
import {
  ambiguityFallbackScore,
  atomicFallbackVerdict,
  coverageFallbackVerdict,
  taskAmbiguityQuestion,
  taskAtomicQuestion,
  taskCoverageQuestion,
  taskQuestionRegistry,
} from "../../../src/decisions/questions/task.ts";

describe("task questions registry", () => {
  it("registers all three under task.*@1", () => {
    expect(taskQuestionRegistry.keys()).toEqual(["task.ambiguity@1", "task.atomic@1", "task.coverage@1"]);
  });
});

describe("task.atomic@1", () => {
  it("atomicFallbackVerdict: 0-1 criteria is atomic, 2-3 unclear, 4+ composite", () => {
    expect(atomicFallbackVerdict(0)).toBe("atomic");
    expect(atomicFallbackVerdict(1)).toBe("atomic");
    expect(atomicFallbackVerdict(2)).toBe("unclear");
    expect(atomicFallbackVerdict(3)).toBe("unclear");
    expect(atomicFallbackVerdict(4)).toBe("composite");
  });

  it("fallback delegates to atomicFallbackVerdict for every reason", () => {
    for (const reason of ["disabled", "transport_error", "abstained"] as const) {
      const result = taskAtomicQuestion.fallback({ goal: "g", acceptanceCriteria: ["a", "b", "c", "d"] }, reason);
      expect(result.value).toBe("composite");
    }
  });

  it("replay round-trips every verdict and rejects garbage", () => {
    for (const v of ["atomic", "composite", "unclear"]) {
      expect(taskAtomicQuestion.replay(v, { goal: "g", acceptanceCriteria: [] })).toBe(v);
    }
    expect(taskAtomicQuestion.replay("bogus", { goal: "g", acceptanceCriteria: [] })).toBeNull();
  });
});

describe("task.coverage@1", () => {
  it("coverageFallbackVerdict requires at least two shared tokens", () => {
    expect(coverageFallbackVerdict("support dark mode theming", "fix the login button", [])).toBe(false);
    expect(
      coverageFallbackVerdict(
        "support dark mode theming across the app",
        "add dark mode theming support to the settings screen",
        [],
      ),
    ).toBe(true);
  });

  it("empty requirement text never counts as covered", () => {
    expect(coverageFallbackVerdict("", "add dark mode", [])).toBe(false);
  });

  it("replay round-trips covered/not_covered and rejects garbage", () => {
    expect(taskCoverageQuestion.replay("covered", { requirement: "r", taskGoal: "g", taskCriteria: [] })).toBe(true);
    expect(taskCoverageQuestion.replay("not_covered", { requirement: "r", taskGoal: "g", taskCriteria: [] })).toBe(false);
    expect(taskCoverageQuestion.replay("bogus", { requirement: "r", taskGoal: "g", taskCriteria: [] })).toBeNull();
  });
});

describe("task.ambiguity@1", () => {
  it("ambiguityFallbackScore: no criteria is maximally ambiguous", () => {
    expect(ambiguityFallbackScore("do something", 0)).toBe(2);
  });

  it("ambiguityFallbackScore counts vague-language markers", () => {
    expect(ambiguityFallbackScore("add a logout button to the header", 1)).toBe(0);
    expect(ambiguityFallbackScore("make the header nice", 1)).toBe(1);
    expect(ambiguityFallbackScore("improve the header appropriately, somehow, with various nice touches", 1)).toBe(2);
  });

  it("replay round-trips scores and rejects garbage", () => {
    expect(taskAmbiguityQuestion.replay("1", { goal: "g", acceptanceCriteria: [] })).toBe(1);
    expect(taskAmbiguityQuestion.replay("bogus", { goal: "g", acceptanceCriteria: [] })).toBeNull();
  });
});
