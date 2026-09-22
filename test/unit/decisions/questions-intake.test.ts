/**
 * `intake.classify@1` (issue #34): registration, content-hash pin, and the
 * always-unknown deterministic fallback.
 */
import { describe, expect, it } from "vitest";
import { intakeClassifyQuestion, intakeQuestionRegistry } from "../../../src/decisions/questions/intake.ts";

describe("intake.classify@1", () => {
  it("registers under intake.classify@1", () => {
    expect(intakeQuestionRegistry.keys()).toEqual(["intake.classify@1"]);
  });

  it("fallback is always unknown, whatever the reason", () => {
    for (const reason of ["disabled", "transport_error", "abstained", "invalid_response"] as const) {
      expect(intakeClassifyQuestion.fallback({ text: "do the thing" }, reason).value).toBe("unknown");
    }
  });

  it("fallback for empty text is unknown", () => {
    expect(intakeClassifyQuestion.fallback({ text: "" }, "disabled").value).toBe("unknown");
  });

  it("replay round-trips every valid option and rejects garbage", () => {
    for (const opt of ["explanation", "investigation", "implementation", "review", "planning", "clarification", "unknown"]) {
      expect(intakeClassifyQuestion.replay(opt, { text: "x" })).toBe(opt);
    }
    expect(intakeClassifyQuestion.replay("bogus", { text: "x" })).toBeNull();
  });

  it("is not revision-sensitive (free text has no repository revision)", () => {
    expect(intakeClassifyQuestion.revisionSensitive).toBe(false);
  });
});
