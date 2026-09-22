/**
 * Issue #52 AC1: "Fixture errors for each taxonomy class are classified
 * correctly by rules alone where the class is deterministic (429 → quota,
 * ENOENT → environment)."
 */
import { describe, it, expect } from "vitest";
import {
  FAILURE_CATEGORIES,
  FAILURE_CATEGORY_DESCRIPTIONS,
  classifyFailure,
  classifyFailureByRules,
  signalFromError,
  quotaEventFor,
  parseRetryAfterSeconds,
  routeKey,
  unknownClassification,
  type FailureCategory,
  type FailureSignal,
} from "../../../src/workflow/failure.ts";

interface Fixture {
  readonly name: string;
  readonly signal: FailureSignal;
  readonly expected: FailureCategory;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "429 → quota",
    signal: { httpStatus: 429, errorMessage: "Too Many Requests" },
    expected: "quota",
  },
  {
    name: "rate limit phrase with no status → quota",
    signal: { stderr: "Error: rate limit exceeded for this key" },
    expected: "quota",
  },
  {
    name: "ENOENT → environment",
    signal: { errorCode: "ENOENT", errorMessage: "no such file or directory, open 'x'" },
    expected: "environment",
  },
  {
    name: "exit 127 command not found → environment",
    signal: { exitCode: 127, stderr: "/bin/sh: 1: pnpm: not found" },
    expected: "environment",
  },
  {
    name: "verification status unavailable → environment",
    signal: { checkStatus: "unavailable", stderr: "" },
    expected: "environment",
  },
  {
    name: "HTTP 503 → service",
    signal: { httpStatus: 503, errorMessage: "Service Unavailable" },
    expected: "service",
  },
  {
    name: "ECONNRESET → service (not environment)",
    signal: { errorCode: "ECONNRESET", errorMessage: "socket hang up" },
    expected: "service",
  },
  {
    name: "cannot find module → dependency",
    signal: { exitCode: 1, stderr: "Error: Cannot find module '@scope/pkg'" },
    expected: "dependency",
  },
  {
    name: "obsolete snapshot → test_expectation",
    signal: { exitCode: 1, stdout: "1 obsolete snapshot found" },
    expected: "test_expectation",
  },
  {
    name: "worker marker → missing_information",
    signal: { exitCode: 1, stdout: "Missing information: the issue does not say which format to emit" },
    expected: "missing_information",
  },
  {
    name: "tsc error code → implementation",
    signal: { exitCode: 2, stdout: "src/a.ts(3,1): error TS2322: Type 'x' is not assignable" },
    expected: "implementation",
  },
  {
    name: "truncated turn → harness",
    signal: { turn: { stopReason: "length", exitCode: 0, outputTokens: 16384 } },
    expected: "harness",
  },
  {
    name: "killed for timeout → harness",
    signal: { turn: { stopReason: "stop", exitCode: null, killedForTimeout: true } },
    expected: "harness",
  },
];

describe("AC1 classifyFailure: deterministic rules alone", () => {
  for (const fixture of FIXTURES) {
    it(`AC1 classifies ${fixture.name}`, () => {
      const result = classifyFailure(fixture.signal);
      expect(result.category).toBe(fixture.expected);
      expect(result.source).toBe("rule");
      expect(result.confidence).toBe(1);
      expect(result.needsEvidence).toBe(false);
      expect(result.rule).not.toBe("");
    });
  }

  it("AC1 covers every deterministic taxonomy category at least once", () => {
    const covered = new Set(FIXTURES.map((f) => f.expected));
    const uncovered = FAILURE_CATEGORIES.filter((c) => c !== "unknown" && !covered.has(c));
    expect(uncovered).toEqual([]);
  });

  it("AC1 every category has a description usable as a Jev option", () => {
    for (const category of FAILURE_CATEGORIES) {
      expect(FAILURE_CATEGORY_DESCRIPTIONS[category].length).toBeGreaterThan(20);
    }
  });
});

describe("AC1 unknown is a real category that asks for evidence", () => {
  it("AC1 an unrecognised failure is unknown, never a guess", () => {
    const result = classifyFailure({ exitCode: 1, stderr: "it did not work" });
    expect(result.category).toBe("unknown");
    expect(result.needsEvidence).toBe(true);
    expect(result.evidenceRequests.length).toBeGreaterThan(0);
    expect(result.confidence).toBe(0);
  });

  it("AC1 unknown requests the specific observations that were missing", () => {
    const result = unknownClassification({ stderr: "boom" });
    const joined = result.evidenceRequests.join(" ");
    expect(joined).toContain("exit code");
    expect(joined).toContain("stdout");
    expect(joined).toContain("reproducible or flaky");
  });

  it("AC1 only an unmatched failure asks Jev; a matched rule does not", () => {
    expect(classifyFailureByRules({ httpStatus: 429 }).needsJev).toBe(false);
    expect(classifyFailureByRules({ exitCode: 1, stderr: "unclear" }).needsJev).toBe(true);
  });
});

describe("AC1 truncation is folded in, not reclassified", () => {
  it("AC1 a truncated turn is harness and its reason makes no quality claim", () => {
    const result = classifyFailureByRules({
      turn: { stopReason: "length", exitCode: 0 },
      stderr: "Cannot find module 'x'",
    });
    expect(result.classification.category).toBe("harness");
    expect(result.turn?.consumesAttemptBudget).toBe(false);
    expect(result.classification.reason.toLowerCase()).not.toContain("did not meet");
  });

  it("AC1 a clean turn falls through to the output rules", () => {
    const result = classifyFailureByRules({
      turn: { stopReason: "stop", exitCode: 0 },
      stderr: "Error: Cannot find module 'x'",
    });
    expect(result.classification.category).toBe("dependency");
  });
});

describe("AC1 quota events feed ModelAvailability by route", () => {
  it("AC1 a quota classification produces an event keyed by provider and model", () => {
    const signal: FailureSignal = { httpStatus: 429, errorMessage: "rate limit exceeded; retry-after: 42" };
    const event = quotaEventFor(classifyFailure(signal), signal, { providerId: "p1", modelId: "m1" });
    expect(event).not.toBeNull();
    expect(event?.routeKey).toBe(routeKey("p1", "m1"));
    expect(event?.retryAfterSeconds).toBe(42);
  });

  it("AC1 two providers exposing the same model id get distinct route keys", () => {
    expect(routeKey("subA", "same-model")).not.toBe(routeKey("subB", "same-model"));
  });

  it("AC1 a service failure produces no quota event", () => {
    const signal: FailureSignal = { httpStatus: 503 };
    expect(quotaEventFor(classifyFailure(signal), signal, { providerId: "p", modelId: "m" })).toBeNull();
  });

  it("AC1 parseRetryAfterSeconds rejects nonsense", () => {
    expect(parseRetryAfterSeconds(undefined)).toBeNull();
    expect(parseRetryAfterSeconds("no header here")).toBeNull();
    expect(parseRetryAfterSeconds("Retry-After: 7")).toBe(7);
  });
});

describe("AC1 signalFromError normalises caught exceptions", () => {
  it("AC1 an ErrnoException keeps its code and classifies as environment", () => {
    const error = Object.assign(new Error("open failed"), { code: "EACCES" });
    expect(classifyFailure(signalFromError(error)).category).toBe("environment");
  });

  it("AC1 a non-Error value still yields an unknown rather than throwing", () => {
    expect(classifyFailure(signalFromError({ weird: true })).category).toBe("unknown");
  });
});
