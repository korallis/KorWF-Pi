/**
 * Composition policy (issue #27; PLAN §6).
 *
 * The decomposition lesson from `scripts/orchestrate/`: a single existential
 * question over a large scope deflates with scope size, so ask one bounded
 * question per criterion and take the conjunction in code. These tests pin
 * the "in code" half — every combinator here is deterministic and Jev-free.
 */
import { describe, it, expect } from "vitest";
import { allTrue, anyTrue, conservative, majority, rankBy } from "../../../src/decisions/compose.ts";
import type { DecisionResult } from "../../../src/decisions/ask.ts";

function part<T>(key: string, value: T, source: "jev" | "fallback" = "jev"): DecisionResult<T> {
  return {
    key,
    value,
    source,
    rule: source === "jev" ? "r" : "fallback",
    action: String(value),
    reason: source === "fallback" ? "disabled" : null,
    distribution: {},
    confidence: null,
    stateHash: "h",
    jevModelVersion: source === "jev" ? "jev-test" : null,
    latencyMs: null,
    decisionId: null,
    reused: false,
  };
}

describe("PLAN §6: one bounded question per criterion, conjunction in code", () => {
  it("allTrue is true only when every criterion holds", () => {
    expect(allTrue([part("a", true), part("b", true)]).value).toBe(true);
    expect(allTrue([part("a", true), part("b", false)]).value).toBe(false);
  });

  it("allTrue over no parts is false, never vacuously true", () => {
    expect(allTrue([]).value).toBe(false);
  });

  it("allTrue names the failing criteria, so a caller can report why", () => {
    const composed = allTrue([part("a", true), part("b", false), part("c", false)]);
    expect(composed.deciding).toEqual(["b", "c"]);
  });

  it("a fallback part marks the composition degraded and names it", () => {
    const composed = allTrue([part("a", true), part("b", true, "fallback")]);
    expect(composed.degraded).toBe(true);
    expect(composed.fellBack).toEqual(["b"]);
  });

  it("anyTrue is the disjunction and names the parts that fired", () => {
    expect(anyTrue([part("a", false), part("b", true)]).value).toBe(true);
    expect(anyTrue([part("a", false)]).value).toBe(false);
    expect(anyTrue([part("a", true), part("b", true)]).deciding).toEqual(["a", "b"]);
  });

  it("majority returns null on a tie rather than guessing", () => {
    const tied = majority([part("a", true), part("b", false)]);
    expect(tied.value).toBeNull();
    expect(tied.rule).toBe("majority:tie");
    expect(majority([part("a", true), part("b", true), part("c", false)]).value).toBe(true);
  });
});

describe("PLAN §6: ranking uses one independent question per candidate", () => {
  it("picks the highest scorer above the threshold", () => {
    const composed = rankBy(
      [
        { candidate: "alpha", result: part("q:alpha", 0.4) },
        { candidate: "beta", result: part("q:beta", 0.81) },
        { candidate: "gamma", result: part("q:gamma", 0.6) },
      ],
      { threshold: 0.5 },
    );
    expect(composed.value).toBe("beta");
    expect(composed.ranking.map((r) => r.candidate)).toEqual(["beta", "gamma", "alpha"]);
    expect(composed.rule).toBe("rank:top");
  });

  it("returns null — an explicit 'none adequate' — when nothing clears the bar", () => {
    const composed = rankBy([{ candidate: "alpha", result: part("q:alpha", 0.2) }], { threshold: 0.5 });
    expect(composed.value).toBeNull();
    expect(composed.rule).toBe("rank:none_above_threshold");
  });

  it("adding a candidate cannot change another candidate's score", () => {
    const two = rankBy(
      [
        { candidate: "alpha", result: part("q:alpha", 0.7) },
        { candidate: "beta", result: part("q:beta", 0.6) },
      ],
      { threshold: 0.5 },
    );
    const three = rankBy(
      [
        { candidate: "alpha", result: part("q:alpha", 0.7) },
        { candidate: "beta", result: part("q:beta", 0.6) },
        { candidate: "gamma", result: part("q:gamma", 0.9) },
      ],
      { threshold: 0.5 },
    );
    expect(two.ranking.find((r) => r.candidate === "alpha")?.score).toBe(
      three.ranking.find((r) => r.candidate === "alpha")?.score,
    );
    expect(three.value).toBe("gamma");
  });
});

describe("AGENTS.md §4 / PLAN §6: conservative default when a part fell back", () => {
  it("a permit built on a fallback is denied unless explicitly allowed", () => {
    const permitted = allTrue([part("a", true), part("b", true, "fallback")]);
    expect(conservative(permitted).value).toBe(false);
    expect(conservative(permitted).rule).toMatch(/degraded_denied$/);
    expect(conservative(permitted, { permitWhenDegraded: true }).value).toBe(true);
  });

  it("a clean permit is untouched and a denial stays a denial", () => {
    const clean = allTrue([part("a", true)]);
    expect(conservative(clean)).toEqual(clean);
    const denied = allTrue([part("a", false, "fallback")]);
    expect(conservative(denied).value).toBe(false);
  });
});
