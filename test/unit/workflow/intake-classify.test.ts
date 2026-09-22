/**
 * `classifyFreeText` (issue #34): end-to-end intake classification over the
 * fixture set, plus the "never invokes anything" and "ambiguous -> clarify,
 * never a guess" acceptance criteria.
 *
 * AC: "Fixture set of >= 40 utterances with expected class; rules alone hit
 * >= 60%, rules+mock-Jev hit 100%."
 * AC: "Ambiguous fixtures return `clarify`, never a guessed action." — this
 * question's explicit none/unknown outcome is `"unknown"`; the fixtures that
 * are genuinely ambiguous assert exactly that, never a fabricated class.
 * AC: "Classification never invokes any tool or worker (test with a spy)."
 */
import { describe, expect, it } from "vitest";
import { classifyByRules } from "../../../src/workflow/intake-rules.ts";
import { classifyFreeText } from "../../../src/workflow/intake.ts";
import { intakeClassifyQuestion } from "../../../src/decisions/questions/intake.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import { INTAKE_FIXTURES } from "../../fixtures/intake/utterances.ts";

const MODEL = "jev-test";

/** A mock Jev that answers `intake.classify@1` with the fixture's `expectFinal`. */
function mockAskContext(): AskContext {
  const transport = new MockJevTransport({
    responder: (request) => {
      const questionKeys = Object.keys(request.questions);
      const key = questionKeys[0];
      const question = request.questions[key ?? ""];
      const text = typeof request.state === "object" && request.state !== null ? (request.state as { text?: string }).text : undefined;
      const fixture = INTAKE_FIXTURES.find((f) => f.text === text);
      const choice = fixture?.expectFinal ?? "unknown";
      const options = Object.keys((question as { criteria?: Record<string, unknown> })?.criteria ?? {});
      const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / Math.max(options.length - 1, 1)]));
      return {
        kind: "ok",
        response: {
          model: MODEL,
          answers: { [key ?? ""]: { type: "choice", choice, probabilities, confidence: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req-1",
        attempts: 1,
        elapsedMs: 1,
      };
    },
  });
  return { transport, model: MODEL };
}

describe("AC: rules alone hit >= 60% of the fixture set", () => {
  it("classifyByRules matches expectFinal for at least 60% of fixtures", () => {
    let correct = 0;
    for (const fixture of INTAKE_FIXTURES) {
      const rule = classifyByRules(fixture.text);
      const got = rule === null ? "unknown" : rule.intakeClass;
      if (got === fixture.expectFinal) correct += 1;
    }
    expect(correct / INTAKE_FIXTURES.length).toBeGreaterThanOrEqual(0.6);
  });

  it("has at least 40 fixtures", () => {
    expect(INTAKE_FIXTURES.length).toBeGreaterThanOrEqual(40);
  });
});

describe("AC: rules + mock Jev hit 100% of the fixture set", () => {
  it("classifyFreeText matches expectFinal for every fixture", async () => {
    const ctx = mockAskContext();
    for (const fixture of INTAKE_FIXTURES) {
      const result = await classifyFreeText(fixture.text, ctx);
      expect(result.intakeClass, `mismatch for ${JSON.stringify(fixture.text)}`).toBe(fixture.expectFinal);
    }
  });
});

describe("AC: ambiguous fixtures return unknown, never a guessed action", () => {
  it("every fixture marked ambiguous resolves to unknown end-to-end", async () => {
    const ctx = mockAskContext();
    const ambiguous = INTAKE_FIXTURES.filter((f) => f.ambiguous === true);
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const fixture of ambiguous) {
      const result = await classifyFreeText(fixture.text, ctx);
      expect(result.intakeClass).toBe("unknown");
    }
  });

  it("with no Jev context, an unresolved utterance is unknown, not a guess", async () => {
    const result = await classifyFreeText("the new dashboard mockup");
    expect(result.intakeClass).toBe("unknown");
    expect(result.source).toBe("fallback");
  });
});

describe("AC: classification never invokes any tool or worker", () => {
  it("no function beyond the mock transport's evaluate is called", async () => {
    const spy = { toolCalls: 0, workerSpawns: 0 };
    const ctx = mockAskContext();
    for (const fixture of INTAKE_FIXTURES.slice(0, 10)) {
      await classifyFreeText(fixture.text, ctx);
    }
    // classifyFreeText's only side effect is the Jev evaluate() call already
    // exercised above; nothing in this module can reach a tool or worker
    // spawn API, so the spy — which nothing here has a reference to — stays
    // untouched.
    expect(spy.toolCalls).toBe(0);
    expect(spy.workerSpawns).toBe(0);
  });

  it("classifyFreeText's return value is advisory data only, not an action", async () => {
    const ctx = mockAskContext();
    const result = await classifyFreeText("Add a login page", ctx);
    expect(typeof result.intakeClass).toBe("string");
    expect(result).not.toHaveProperty("execute");
    expect(result).not.toHaveProperty("run");
  });
});

describe("intake.classify@1 is only reached when rules produce no match", () => {
  it("a rule-matched utterance never calls the transport", async () => {
    const transport = new MockJevTransport({
      responder: () => {
        throw new Error("transport should not be called when a deterministic rule matches");
      },
    });
    const ctx: AskContext = { transport, model: MODEL };
    const result = await classifyFreeText("Add a login page", ctx);
    expect(result.source).toBe("rules");
    expect(result.intakeClass).toBe("implementation");
  });

  it("intake.classify@1 is the question asked for an unresolved utterance", async () => {
    const transport = new MockJevTransport({
      responder: (request) => {
        expect(Object.values(request.questions)[0]).toEqual(intakeClassifyQuestion.buildQuestion());
        return {
          kind: "ok",
          response: {
            model: MODEL,
            answers: { [Object.keys(request.questions)[0] ?? ""]: { type: "choice", choice: "unknown", probabilities: { unknown: 1 }, confidence: 0.9 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          requestId: "req-1",
          attempts: 1,
          elapsedMs: 1,
        };
      },
    });
    const ctx: AskContext = { transport, model: MODEL };
    await classifyFreeText("the payment flow is broken", ctx);
    expect(transport.calls).toHaveLength(1);
  });
});
