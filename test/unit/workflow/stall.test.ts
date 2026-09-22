/**
 * Issue #52 AC2: "Stall fires after N identical failures (N from config) and
 * drift fires on an out-of-ownership write."
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_STALL_THRESHOLDS,
  EMPTY_STALL_STATE,
  attemptMadeProgress,
  detectStalls,
  driftingWrites,
  observeAttempt,
  pathInOwnership,
  resolveStallThresholds,
  type AttemptObservation,
  type CheckObservation,
} from "../../../src/workflow/stall.ts";
import type { Ownership } from "../../../src/storage/records.ts";

const OWNERSHIP: Ownership = { paths: ["src/workflow/"], components: ["workflow"] };

function check(overrides: Partial<CheckObservation> = {}): CheckObservation {
  return {
    checkId: "unit",
    status: "fail",
    check: { kind: "command", command: "npm test -- stall", required: true },
    failureSignature: "sig-a",
    ...overrides,
  };
}

function attempt(id: string, overrides: Partial<AttemptObservation> = {}): AttemptObservation {
  return {
    attemptId: id,
    taskId: "T1",
    approachFingerprint: `fp-${id}`,
    failureKind: "none",
    checks: [check()],
    writes: [],
    toolCalls: 3,
    filesChanged: 1,
    ...overrides,
  };
}

describe("AC2 repeated failures fire after N, with N from config", () => {
  it("AC2 default N=3 identical failures fires repeated_failure on the third", () => {
    const { events } = detectStalls([attempt("a1"), attempt("a2"), attempt("a3")]);
    const fired = events.filter((e) => e.kind === "repeated_failure");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.attemptId).toBe("a3");
    expect(fired[0]?.count).toBe(3);
    expect(fired[0]?.threshold).toBe(DEFAULT_STALL_THRESHOLDS.repeatedFailures);
  });

  it("AC2 N is taken from config: N=2 fires on the second", () => {
    const { events } = detectStalls([attempt("a1"), attempt("a2")], { thresholds: { repeatedFailures: 2 } });
    expect(events.filter((e) => e.kind === "repeated_failure").map((e) => e.attemptId)).toEqual(["a2"]);
  });

  it("AC2 two failures below N do not fire", () => {
    const { events } = detectStalls([attempt("a1"), attempt("a2")]);
    expect(events.some((e) => e.kind === "repeated_failure")).toBe(false);
  });

  it("AC2 differently-failing runs of the same check are not identical failures", () => {
    const { events } = detectStalls([
      attempt("a1", { checks: [check({ failureSignature: "s1" })] }),
      attempt("a2", { checks: [check({ failureSignature: "s2" })] }),
      attempt("a3", { checks: [check({ failureSignature: "s3" })] }),
    ]);
    expect(events.some((e) => e.kind === "repeated_failure")).toBe(false);
  });

  it("AC2 repeated_failure fires once, not on every later attempt", () => {
    const { events } = detectStalls([attempt("a1"), attempt("a2"), attempt("a3"), attempt("a4")]);
    expect(events.filter((e) => e.kind === "repeated_failure")).toHaveLength(1);
  });

  it("AC2 harness (truncated) turns never count as repeated failures (#124)", () => {
    const truncated = (id: string): AttemptObservation => attempt(id, { failureKind: "truncated" });
    const { events } = detectStalls([truncated("a1"), truncated("a2"), truncated("a3")]);
    expect(events.some((e) => e.kind === "repeated_failure")).toBe(false);
  });

  it("AC2 thresholds are clamped to at least 1", () => {
    expect(resolveStallThresholds({ repeatedFailures: 0 }).repeatedFailures).toBe(1);
    expect(resolveStallThresholds(undefined)).toEqual(DEFAULT_STALL_THRESHOLDS);
  });
});

describe("AC2 repeated approaches", () => {
  it("AC2 two attempts with the same approach fingerprint fire repeated_approach", () => {
    const { events } = detectStalls([
      attempt("a1", { approachFingerprint: "same" }),
      attempt("a2", { approachFingerprint: "same" }),
    ]);
    const fired = events.filter((e) => e.kind === "repeated_approach");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.attemptIds).toEqual(["a1", "a2"]);
  });

  it("AC2 distinct fingerprints do not fire", () => {
    const { events } = detectStalls([attempt("a1"), attempt("a2")]);
    expect(events.some((e) => e.kind === "repeated_approach")).toBe(false);
  });

  it("AC2 a null fingerprint is not treated as a repeat of another null", () => {
    const { events } = detectStalls([
      attempt("a1", { approachFingerprint: null }),
      attempt("a2", { approachFingerprint: null }),
    ]);
    expect(events.some((e) => e.kind === "repeated_approach")).toBe(false);
  });
});

describe("AC2 drift fires on an out-of-ownership write", () => {
  it("AC2 a single write outside ownership fires scope_drift", () => {
    const { events } = detectStalls(
      [attempt("a1", { writes: [{ path: "src/security/outbound.ts", kind: "modify" }] })],
      { ownership: OWNERSHIP },
    );
    const fired = events.filter((e) => e.kind === "scope_drift");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.detail).toContain("src/security/outbound.ts");
    expect(fired[0]?.detail).toContain("write_outside_ownership");
  });

  it("AC2 writes inside ownership do not fire", () => {
    const { events } = detectStalls(
      [attempt("a1", { writes: [{ path: "src/workflow/stall.ts", kind: "create" }] })],
      { ownership: OWNERSHIP },
    );
    expect(events.some((e) => e.kind === "scope_drift")).toBe(false);
  });

  it("AC2 a sibling path sharing a prefix is outside ownership", () => {
    expect(pathInOwnership("src/workflow-extra.ts", OWNERSHIP)).toBe(false);
    expect(pathInOwnership("./src/workflow/failure.ts", OWNERSHIP)).toBe(true);
  });

  it("AC2 a deletion outside ownership is drift too", () => {
    const drifted = driftingWrites(attempt("a1", { writes: [{ path: "docs/gates.md", kind: "delete" }] }), OWNERSHIP);
    expect(drifted).toHaveLength(1);
  });
});

describe("AC2 no measurable progress", () => {
  const noChange = (id: string, overrides: Partial<AttemptObservation> = {}): AttemptObservation =>
    attempt(id, { filesChanged: 0, approachFingerprint: `fp-${id}`, ...overrides });

  it("AC2 two consecutive attempts changing nothing fire no_progress", () => {
    const { events } = detectStalls([noChange("a1"), noChange("a2")]);
    const fired = events.filter((e) => e.kind === "no_progress");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.attemptId).toBe("a2");
  });

  it("AC2 a file change resets the no-progress streak", () => {
    const { events } = detectStalls([noChange("a1"), attempt("a2"), noChange("a3")]);
    expect(events.some((e) => e.kind === "no_progress")).toBe(false);
  });

  it("AC2 many tool calls with no file change fire no_progress within one attempt", () => {
    const { events } = detectStalls([noChange("a1", { toolCalls: 40 })]);
    expect(events.filter((e) => e.kind === "no_progress")).toHaveLength(1);
  });

  it("AC2 harness turns do not accumulate a no-progress streak (#124)", () => {
    const { events } = detectStalls([
      noChange("a1", { failureKind: "truncated", toolCalls: 0 }),
      noChange("a2", { failureKind: "truncated", toolCalls: 0 }),
      noChange("a3", { failureKind: "truncated", toolCalls: 0 }),
    ]);
    expect(events.some((e) => e.kind === "no_progress")).toBe(false);
  });

  it("AC2 a verifying check going from failing to passing is progress", () => {
    const previous = attempt("a1", { checks: [check({ status: "fail" })] });
    const current = attempt("a2", { filesChanged: 0, checks: [check({ status: "pass" })] });
    expect(attemptMadeProgress(current, previous).progressed).toBe(true);
  });

  it("AC2 a check that cannot fail flipping to pass is not progress (isVerifyingCheck, #44)", () => {
    const weak = { kind: "command", command: "echo ok", required: true };
    const previous = attempt("a1", { checks: [check({ checkId: "weak", check: weak, status: "fail" })] });
    const current = attempt("a2", {
      filesChanged: 0,
      checks: [check({ checkId: "weak", check: weak, status: "pass" })],
    });
    const progress = attemptMadeProgress(current, previous);
    expect(progress.progressed).toBe(false);
    expect(progress.reason).toContain("isVerifyingCheck");
  });
});

describe("AC2 detector state", () => {
  it("AC2 observeAttempt is a pure fold: the empty state is unchanged", () => {
    const before = JSON.stringify(EMPTY_STALL_STATE);
    observeAttempt(EMPTY_STALL_STATE, attempt("a1"), { ownership: OWNERSHIP });
    expect(JSON.stringify(EMPTY_STALL_STATE)).toBe(before);
  });

  it("AC2 with no ownership supplied, drift is never claimed", () => {
    const { events } = detectStalls([attempt("a1", { writes: [{ path: "anywhere.ts", kind: "modify" }] })]);
    expect(events.some((e) => e.kind === "scope_drift")).toBe(false);
  });
});
