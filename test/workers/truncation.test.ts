/**
 * #124 AC2: "`stopReason: \"length\"` is recorded on the attempt and classified as a
 * harness failure, distinct from a quality failure."
 * #124 AC6: deterministic with Jev disabled.
 */
import { describe, it, expect } from "vitest";
import {
  HARNESS_FAILURE_KINDS,
  TRUNCATION_STOP_REASON,
  classifyTurn,
  isHarnessFailure,
  isHarnessFeedback,
  isTruncated,
} from "../../src/workers/truncation.ts";
import { settleTurn } from "../../src/workflow/attempt-controller.ts";

describe("AC2: stopReason capture and classification", () => {
  it("records the stop reason verbatim on the classification", () => {
    for (const stopReason of ["length", "stop", "tool_use", "aborted", "error"] as const) {
      expect(classifyTurn({ stopReason, exitCode: 0 }).stopReason).toBe(stopReason);
    }
    expect(classifyTurn({ stopReason: null, exitCode: 0 }).stopReason).toBeNull();
  });

  it("classifies stopReason 'length' as truncated and harness-class", () => {
    const c = classifyTurn({ stopReason: TRUNCATION_STOP_REASON, exitCode: 0, outputTokens: 16_384 });
    expect(c.kind).toBe("truncated");
    expect(c.failureClass).toBe("harness");
    expect(c.truncated).toBe(true);
    expect(c.consumesAttemptBudget).toBe(false);
    expect(c.reason).toMatch(/before the tool call was emitted/);
    expect(c.reason).toMatch(/harness failure, not a quality failure/);
  });

  it("does not classify a clean short turn as truncated, however short its text", () => {
    // The #14 signature was a 28-character final message. Text length is not the
    // signal; the recorded stop reason is.
    const c = classifyTurn({ stopReason: "stop", exitCode: 0, finalText: "Done." });
    expect(c.truncated).toBe(false);
    expect(c.kind).toBe("none");
    expect(c.failureClass).toBe("none");
    expect(isTruncated({ stopReason: "stop" })).toBe(false);
    expect(isTruncated({ stopReason: "length" })).toBe(true);
  });

  it("separates harness failure kinds from quality ones", () => {
    for (const kind of HARNESS_FAILURE_KINDS) expect(isHarnessFailure(kind)).toBe(true);
    expect(isHarnessFailure("gap")).toBe(false);
    expect(isHarnessFailure("none")).toBe(false);
  });

  it("classifies a killed worker and a nonzero exit as harness failures too", () => {
    expect(classifyTurn({ stopReason: null, exitCode: null, killedForTimeout: true }).kind).toBe("timeout");
    expect(classifyTurn({ stopReason: "stop", exitCode: 1 }).failureClass).toBe("harness");
  });

  it("checks truncation before anything that inspects worker output", () => {
    // A turn that was truncated AND exited nonzero is still 'truncated': the
    // ceiling is the explanation, and mislabelling it loses the diagnosis.
    const c = classifyTurn({ stopReason: "length", exitCode: 1, killedForTimeout: true });
    expect(c.kind).toBe("truncated");
  });

  it("records truncation distinctly in telemetry, not as a quality failure", () => {
    const t = settleTurn({ observation: { stopReason: "length", exitCode: 0, outputTokens: 16_384 } }).telemetry;
    expect(t).toMatchObject({
      stopReason: "length",
      truncated: true,
      failureKind: "truncated",
      failureClass: "harness",
      consumedAttemptBudget: false,
      attemptsUsed: 0,
      harnessRetriesUsed: 1,
      consecutiveTruncations: 1,
    });
    const q = settleTurn({
      observation: { stopReason: "stop", exitCode: 0 },
      gate: { passed: false, feedback: "Unmet: criterion 2." },
    }).telemetry;
    expect(q).toMatchObject({ truncated: false, failureKind: "gap", failureClass: "quality", consumedAttemptBudget: true });
  });

  it("AC6: recognises quality-judgement wording so harness feedback cannot smuggle it in", () => {
    expect(isHarnessFeedback("Your turn was cut off at the output-token limit.")).toBe(true);
    expect(isHarnessFeedback("Report appears to overclaim (p=0.92).")).toBe(false);
    expect(isHarnessFeedback("Unmet criteria: 1, 3.")).toBe(false);
  });
});
