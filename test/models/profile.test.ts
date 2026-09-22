/**
 * `src/models/profile.ts` (issue #59) — the task-profile evaluator,
 * independent of model names.
 *
 * AC: "Profile output type has no model-id field (compile-time)."
 * AC: "Fixture tasks map to expected domains with mock Jev and with
 * fallback."
 */
import { describe, expect, it } from "vitest";
import { DisabledJevTransport } from "../../src/jev/disabled.ts";
import { MockJevTransport } from "../../src/jev/mock.ts";
import type { AskContext } from "../../src/decisions/ask.ts";
import {
  buildProfile,
  buildProfileFallback,
  detectModalities,
  UNKNOWN_REASONING_DEPTH,
  type TaskProfileInput,
} from "../../src/models/profile.ts";

const MODEL = "jev-test";

function ctxWith(transport: DisabledJevTransport | MockJevTransport): AskContext {
  return { transport, model: MODEL };
}

function input(overrides: Partial<TaskProfileInput> = {}): TaskProfileInput {
  return {
    goal: "add a logout button to the header",
    acceptanceCriteria: ["clicking logout clears the session"],
    ownershipPaths: ["src/workflow/index.ts"],
    riskClass: "low",
    attachments: [],
    ...overrides,
  };
}

describe("detectModalities", () => {
  it("always includes text, plus declared attachment kinds, deduped and sorted", () => {
    expect(detectModalities([])).toEqual(["text"]);
    expect(detectModalities([{ kind: "image" }, { kind: "IMAGE" }, { kind: "audio" }])).toEqual([
      "audio",
      "image",
      "text",
    ]);
  });
});

describe("AC: fixture tasks map to expected domains — fallback (no Jev)", () => {
  const fixtures: readonly { readonly name: string; readonly ownershipPaths: readonly string[]; readonly domain: string }[] = [
    { name: "test file", ownershipPaths: ["test/models/profile.test.ts"], domain: "testing" },
    { name: "doc file", ownershipPaths: ["docs/adr/0009.md"], domain: "docs" },
    { name: "security module", ownershipPaths: ["src/security/outbound.ts"], domain: "security" },
    { name: "generic src", ownershipPaths: ["src/workflow/index.ts"], domain: "backend" },
    { name: "no paths", ownershipPaths: [], domain: "unknown" },
  ];

  for (const f of fixtures) {
    it(`${f.name} -> ${f.domain}`, () => {
      const result = buildProfileFallback(input({ ownershipPaths: f.ownershipPaths }));
      expect(result.profile.domain).toBe(f.domain);
      expect(result.sources.domain).toBe("fallback");
    });
  }

  it("reasoning depth is unknown (midpoint value, fallback source), never a guess", () => {
    const result = buildProfileFallback(input());
    expect(result.profile.reasoningDepth).toBe(UNKNOWN_REASONING_DEPTH);
    expect(result.sources.reasoningDepth).toBe("fallback");
  });

  it("risk comes straight from riskClass, never inferred", () => {
    const result = buildProfileFallback(input({ riskClass: "high" }));
    expect(result.profile.risk).toBe("high");
  });

  it("modalities come from attachments, not Jev", () => {
    const result = buildProfileFallback(input({ attachments: [{ kind: "image" }] }));
    expect(result.profile.modalities).toEqual(["image", "text"]);
  });

  it("works with a fully disabled transport end to end via buildProfile", async () => {
    const ctx = ctxWith(new DisabledJevTransport());
    const result = await buildProfile(ctx, input({ ownershipPaths: ["docs/x.md"] }));
    expect(result.profile.domain).toBe("docs");
    expect(result.sources.domain).toBe("fallback");
    expect(result.profile.reasoningDepth).toBe(UNKNOWN_REASONING_DEPTH);
    expect(result.sources.reasoningDepth).toBe("fallback");
  });
});

describe("AC: fixture tasks map to expected domains — with mock Jev", () => {
  function evenProbabilities(options: readonly string[], choice: string): Record<string, number> {
    const n = options.length;
    const out: Record<string, number> = {};
    for (const opt of options) out[opt] = opt === choice ? 1 - 0.01 * (n - 1) : 0.01;
    return out;
  }

  function mockAnswering(domainChoice: string, depthScore: number, contextChoice: string): MockJevTransport {
    return new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([key, q]) => {
              if (q.type === "choice") {
                const options = Object.keys(q.criteria);
                const choice = options.includes(domainChoice) ? domainChoice : contextChoice;
                return [key, { type: "choice", choice, probabilities: evenProbabilities(options, choice), confidence: 0.9 }];
              }
              {
                const levelCount = (q as { criteria: readonly unknown[] }).criteria.length;
                const keys = Array.from({ length: levelCount }, (_, i) => String(i));
                const legend = Object.fromEntries(keys.map((k) => [k, "level"]));
                const probabilities = Object.fromEntries(keys.map((k) => [k, k === String(depthScore) ? 0.9 : 0.1 / (levelCount - 1)]));
                return [key, { type: "score", score: depthScore, legend, probabilities, confidence: 0.9 }];
              }
            }),
          ),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req-1",
        attempts: 1,
        elapsedMs: 1,
      }),
    });
  }

  it("frontend domain, deep reasoning, large context all come through as jev-sourced", async () => {
    const ctx = ctxWith(mockAnswering("frontend", 2, "large"));
    const result = await buildProfile(ctx, input());
    expect(result.profile.domain).toBe("frontend");
    expect(result.sources.domain).toBe("jev");
    expect(result.profile.reasoningDepth).toBe(1);
    expect(result.sources.reasoningDepth).toBe("jev");
    expect(result.profile.contextSize).toBe(1);
    expect(result.sources.contextSize).toBe("jev");
  });
});

describe("AC: profile output type has no model-id field (compile-time)", () => {
  it("TaskProfile keys never include a model/provider field", () => {
    const result = buildProfileFallback(input());
    const keys = Object.keys(result.profile);
    expect(keys).toEqual(["domain", "modalities", "reasoningDepth", "contextSize", "risk"]);
    for (const k of keys) {
      expect(k.toLowerCase()).not.toMatch(/model|provider/);
    }
  });

  it("no question state ever contains a model id, provider name, or card text", async () => {
    const transport = new MockJevTransport({
      responder: (request) => {
        // Assert on the state string sent to Jev: must never mention a model/provider/card.
        expect(JSON.stringify(request.state)).not.toMatch(/gpt-6-astra|kimi-k3|mac-mini|anthropic|openai/i);
        return {
          kind: "ok",
          response: {
            model: MODEL,
            answers: Object.fromEntries(
              Object.entries(request.questions).map(([key, q]) =>
                q.type === "choice"
                  ? [key, { type: "choice", choice: Object.keys(q.criteria)[0]!, probabilities: {}, confidence: 0.9 }]
                  : (() => {
                      const levelCount = (q as { criteria: readonly unknown[] }).criteria.length;
                      const keys = Array.from({ length: levelCount }, (_, i) => String(i));
                      const legend = Object.fromEntries(keys.map((k) => [k, "level"]));
                      const probabilities = Object.fromEntries(keys.map((k) => [k, k === "0" ? 0.9 : 0.1 / (levelCount - 1)]));
                      return [key, { type: "score", score: 0, legend, probabilities, confidence: 0.9 }];
                    })(),
              ),
            ),
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          requestId: "req-1",
          attempts: 1,
          elapsedMs: 1,
        };
      },
    });
    await buildProfile(ctxWith(transport), input());
    expect(transport.calls.length).toBeGreaterThan(0);
  });
});
