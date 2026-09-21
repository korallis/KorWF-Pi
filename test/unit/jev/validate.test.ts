/**
 * Response validation for Choice / Score / Noul (issue #25).
 *
 * Every fixture under `test/fixtures/jev/malformed/` must produce a typed
 * rejection, never a throw (acceptance criterion 1). Version mismatch is
 * surfaced as a result and logged once (acceptance criterion 2). All tests
 * go through `MockJevTransport`; no live API calls are made anywhere here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  validateResponse,
  validateNoulAnswer,
  validateChoiceAnswer,
  validateScoreAnswer,
  checkVersion,
  resetVersionMismatchLog,
} from "../../../src/jev/validate.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { createLogger, memorySink } from "../../../src/security/redact.ts";
import type { SystemOneRequest } from "../../../src/jev/transport.ts";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/jev");
const MALFORMED_DIR = path.join(FIXTURES_DIR, "malformed");

interface MalformedFixture {
  readonly description: string;
  readonly questionKey: string;
  readonly expectedCode: string | null;
  readonly expectedVersionStatus?: "match" | "mismatch" | "missing";
  readonly request: SystemOneRequest;
  readonly raw: unknown;
}

function loadFixture(name: string): MalformedFixture {
  return JSON.parse(readFileSync(path.join(MALFORMED_DIR, name), "utf8")) as MalformedFixture;
}

beforeEach(() => {
  resetVersionMismatchLog();
});

describe("malformed fixtures never throw and produce a typed rejection", () => {
  const files = readdirSync(MALFORMED_DIR).filter((f) => f.endsWith(".json")).sort();

  it("has at least 12 malformed fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  for (const file of files) {
    it(`${file}: validateResponse never throws and rejects as expected`, () => {
      const fixture = loadFixture(file);
      let result;
      expect(() => {
        result = validateResponse(fixture.request, fixture.raw);
      }).not.toThrow();
      expect(result).toBeDefined();
      // A malformed response never becomes a decision: overall ok must be false
      // unless the fixture is purely a version-status probe.
      if (fixture.expectedCode !== null) {
        const answer = result!.answers[fixture.questionKey];
        expect(answer).toBeDefined();
        expect(answer!.ok).toBe(false);
        if (!answer!.ok) {
          expect(answer!.code).toBe(fixture.expectedCode);
        }
        expect(result!.ok).toBe(false);
      }
      if (fixture.expectedVersionStatus !== undefined) {
        expect(result!.version.status).toBe(fixture.expectedVersionStatus);
      }
    });
  }
});

describe("well-formed response validates cleanly and preserves raw distributions", () => {
  it("all three answer types validate ok with raw preserved", () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "valid/01-noul-choice-score.json"), "utf8")) as {
      request: SystemOneRequest;
      raw: unknown;
    };
    const result = validateResponse(fixture.request, fixture.raw);
    expect(result.ok).toBe(true);
    expect(result.version.status).toBe("match");
    expect(result.answers["n"]!.ok).toBe(true);
    expect(result.answers["c"]!.ok).toBe(true);
    expect(result.answers["s"]!.ok).toBe(true);
    // raw distribution preserved verbatim
    if (result.answers["c"]!.ok) {
      expect(result.answers["c"]!.value.type).toBe("choice");
    }
    expect(result.answers["n"]!.raw).toEqual({ type: "noul", noul: 0.42 });
  });
});

describe("version mismatch: surfaced as a result, never an exception, logged once", () => {
  it("checkVersion reports mismatch without throwing", () => {
    expect(checkVersion("jev-1.14.0", "jev-1.13.0")).toEqual({
      status: "mismatch",
      expected: "jev-1.13.0",
      actual: "jev-1.14.0",
    });
  });

  it("checkVersion reports missing for an absent/non-string model field", () => {
    expect(checkVersion(undefined, "jev-1.13.0")).toEqual({ status: "missing" });
    expect(checkVersion(42, "jev-1.13.0")).toEqual({ status: "missing" });
  });

  it("validateResponse logs a mismatch exactly once for repeated identical mismatches", () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "version-mismatch.json"), "utf8")) as {
      request: SystemOneRequest;
      raw: unknown;
    };
    const sink = memorySink();
    const logger = createLogger(sink);

    const first = validateResponse(fixture.request, fixture.raw, { logger });
    const second = validateResponse(fixture.request, fixture.raw, { logger });

    expect(first.version).toEqual({ status: "mismatch", expected: "jev-1.13.0", actual: "jev-1.14.0" });
    expect(second.version).toEqual({ status: "mismatch", expected: "jev-1.13.0", actual: "jev-1.14.0" });
    // A version mismatch does not itself invalidate the answers it accompanies.
    expect(first.answers["n"]!.ok).toBe(true);

    const mismatchLogs = sink.records.filter((r) => r.message.includes("model differs from pinned version"));
    expect(mismatchLogs.length).toBe(1);
  });
});

describe("a malformed response never becomes a decision (degrades like a missing key)", () => {
  it("MockJevTransport returning a malformed ok response validates to a clear rejection, not a throw", async () => {
    const request: SystemOneRequest = {
      state: "state",
      model: "jev-1.13.0",
      questions: { n: { type: "noul", instructions: "is it true" } },
    };
    const transport = new MockJevTransport({
      responses: [
        {
          kind: "ok",
          response: { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
          requestId: "req-1",
          attempts: 1,
          elapsedMs: 5,
        },
      ],
    });
    const result = await transport.evaluate(request);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    const validated = validateResponse(request, result.response);
    expect(validated.ok).toBe(false);
    expect(validated.answers["n"]!.ok).toBe(false);
    if (!validated.answers["n"]!.ok) {
      expect(validated.answers["n"]!.code).toBe("missing_answer");
      expect(validated.answers["n"]!.reason).toMatch(/no answer/);
    }
  });
});

describe("per-type validator unit checks (direct calls, no transport)", () => {
  it("validateNoulAnswer rejects a non-object payload", () => {
    const result = validateNoulAnswer("nope", { type: "noul", instructions: "x" });
    expect(result.ok).toBe(false);
  });

  it("validateChoiceAnswer accepts an unknown extra field without leaking it into value", () => {
    const question = { type: "choice" as const, instructions: "x", criteria: { a: null, b: null } };
    const raw = {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.5, b: 0.5 },
      confidence: 0.5,
      unexpected_extra_field: "forward-compat",
    };
    const result = validateChoiceAnswer(raw, question);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("unexpected_extra_field" in (result.value as unknown as Record<string, unknown>)).toBe(false);
      expect(result.raw).toBe(raw);
    }
  });

  it("validateScoreAnswer rejects when level count is below 2", () => {
    const question = { type: "score" as const, instructions: "x", criteria: ["only-one"] };
    const raw = { type: "score", score: 0, legend: { "0": "only-one" }, probabilities: { "0": 1 }, confidence: 1 };
    const result = validateScoreAnswer(raw, question);
    expect(result.ok).toBe(false);
  });
});
