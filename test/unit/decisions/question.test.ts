/**
 * Question definitions and the version rule (issue #27).
 *
 * AC: "Changing a question's prompt without bumping the version fails a test."
 * Everything else here backs PLAN §6: explicit boundary cases, none/unknown
 * outcomes, and a deterministic fallback for every question.
 */
import { describe, it, expect } from "vitest";
import {
  assertBoundaries,
  abstentionOf,
  defineChoice,
  defineNoul,
  defineScore,
  QuestionDefinitionError,
  questionKey,
  type QuestionDefinition,
} from "../../../src/decisions/question.ts";
import { QuestionRegistry } from "../../../src/decisions/registry.ts";
import {
  classifyQuestion,
  echoQuestion,
  exampleRegistry,
  EXAMPLE_QUESTION_HASHES,
  lengthQuestion,
  type EchoState,
} from "../../../src/decisions/examples.ts";

function echoLike(prompt: string, version = "1"): QuestionDefinition<EchoState, boolean> {
  return defineNoul<EchoState, boolean>({
    id: "example.echo",
    version,
    prompt,
    criteria: {
      true: "`text` holds at least one non-whitespace character",
      false: "`text` is empty or whitespace only",
    },
    abstainBand: [0.4, 0.6],
    state: (input) => ({ text: input.text }),
    decide: (noul) => ({ value: noul >= 0.5, rule: "echo", action: noul >= 0.5 ? "present" : "absent" }),
    fallback: (input) => ({ value: input.text.trim().length > 0, action: "present" }),
    boundaries: [{ name: "empty", state: { text: "" }, expectFallback: false }],
  });
}

describe("AC: changing a question's prompt without bumping the version fails", () => {
  it("the content hash changes when the prompt text changes", () => {
    const original = echoLike(echoQuestion.prompt);
    const edited = echoLike(`${echoQuestion.prompt} Please be careful.`);
    expect(original.contentHash).toBe(echoQuestion.contentHash);
    expect(edited.contentHash).not.toBe(original.contentHash);
    expect(edited.version).toBe(original.version);
  });

  it("registering an edited prompt under the same version throws", () => {
    const registry = new QuestionRegistry();
    expect(() => registry.register(echoLike("A different prompt entirely?"), { pinnedHash: echoQuestion.contentHash })).toThrow(
      QuestionDefinitionError,
    );
  });

  it("registering the edited prompt under a bumped version succeeds", () => {
    const registry = new QuestionRegistry();
    const bumped = echoLike("A different prompt entirely?", "2");
    expect(() => registry.register(bumped, { pinnedHash: bumped.contentHash })).not.toThrow();
    expect(registry.keys()).toEqual(["example.echo@2"]);
  });

  it("the shipped example hashes match the live definitions", () => {
    expect(exampleRegistry.manifest()).toEqual(EXAMPLE_QUESTION_HASHES);
    expect(exampleRegistry.diffManifest(EXAMPLE_QUESTION_HASHES)).toEqual({ changed: [], added: [], removed: [] });
  });

  it("diffManifest names the question whose text drifted", () => {
    const stale = { ...EXAMPLE_QUESTION_HASHES, "example.echo@1": "0".repeat(64) };
    expect(exampleRegistry.diffManifest(stale).changed).toEqual(["example.echo@1"]);
  });

  it("a registry refuses two registrations of the same id@version", () => {
    const registry = new QuestionRegistry();
    registry.register(echoLike(echoQuestion.prompt));
    expect(() => registry.register(echoLike(echoQuestion.prompt))).toThrow(/already registered/);
  });

  it("changing only an option label changes the hash", () => {
    const relabelled = defineChoice<EchoState, string>({
      id: "example.classify",
      version: "1",
      prompt: classifyQuestion.prompt,
      options: { question: "asks", statement: "asserts", unknown: "neither" },
      minConfidence: 0.5,
      state: (input) => ({ text: input.text }),
      decide: (answer) => ({ value: answer.choice, rule: "c", action: answer.choice }),
      fallback: () => ({ value: "unknown", action: "unknown" }),
      boundaries: [{ name: "empty", state: { text: "" }, expectFallback: "unknown" }],
    });
    expect(relabelled.contentHash).not.toBe(classifyQuestion.contentHash);
  });
});

describe("PLAN §6: naming and versioning policy is enforced at definition time", () => {
  it.each(["Example.Echo", "echo", "example.Echo", "example echo", ""])(
    "rejects the malformed id %j",
    (id) => {
      expect(() => echoLike("p") && defineNoul({ ...noulSpec(id, "1") })).toThrow(QuestionDefinitionError);
    },
  );

  it.each(["0", "1.0", "v1", "", "-1"])("rejects the malformed version %j", (version) => {
    expect(() => defineNoul({ ...noulSpec("example.ok", version) })).toThrow(QuestionDefinitionError);
  });

  it("questionKey composes id and version", () => {
    expect(questionKey("example.echo", "3")).toBe("example.echo@3");
    expect(echoQuestion.key).toBe("example.echo@1");
  });
});

function noulSpec(id: string, version: string) {
  return {
    id,
    version,
    prompt: "p?",
    state: () => ({}),
    decide: () => ({ value: true, rule: "r", action: "a" }),
    fallback: () => ({ value: true, action: "a" }),
    boundaries: [{ name: "b", state: {} as Record<string, never>, expectFallback: true }],
  };
}

describe("PLAN §6: explicit boundary cases and none/unknown outcomes", () => {
  it("a definition with no boundary examples is rejected", () => {
    expect(() => defineNoul({ ...noulSpec("example.nobound", "1"), boundaries: [] })).toThrow(/boundary examples/);
  });

  it("a boundary example that disagrees with the fallback fails registration", () => {
    const wrong = defineNoul<EchoState, boolean>({
      id: "example.wrong",
      version: "1",
      prompt: "Is `text` non-empty?",
      state: (input) => ({ text: input.text }),
      decide: (noul) => ({ value: noul >= 0.5, rule: "r", action: "a" }),
      fallback: (input) => ({ value: input.text.length > 0, action: "a" }),
      boundaries: [{ name: "empty says true", state: { text: "" }, expectFallback: true }],
    });
    expect(() => assertBoundaries(wrong)).toThrow(/boundary "empty says true"/);
    expect(() => new QuestionRegistry().register(wrong)).toThrow(QuestionDefinitionError);
  });

  it("every shipped example question's fallback satisfies its own boundaries", () => {
    for (const key of exampleRegistry.keys()) {
      expect(() => assertBoundaries(exampleRegistry.require(key))).not.toThrow();
    }
  });

  it("the example choice question offers an explicit unknown option", () => {
    const body = classifyQuestion.buildQuestion();
    expect(body.type).toBe("choice");
    if (body.type !== "choice") throw new Error("unreachable");
    expect(Object.keys(body.criteria)).toContain("unknown");
  });

  it("a score question needs at least two levels", () => {
    expect(() =>
      defineScore({
        id: "example.one_level",
        version: "1",
        prompt: "How long?",
        levels: ["only"],
        state: () => ({}),
        decide: () => ({ value: 0, rule: "r", action: "0" }),
        fallback: () => ({ value: 0, action: "0" }),
        boundaries: [{ name: "b", state: {} as Record<string, never>, expectFallback: 0 }],
      }),
    ).toThrow(/at least two levels/);
  });
});

describe("PLAN §6: abstention bands and confidence floors", () => {
  it("a noul inside the band abstains, outside it does not", () => {
    expect(abstentionOf(echoQuestion, { type: "noul", noul: 0.5 })).toBe("abstained");
    expect(abstentionOf(echoQuestion, { type: "noul", noul: 0.41 })).toBe("abstained");
    expect(abstentionOf(echoQuestion, { type: "noul", noul: 0.4 })).toBeNull();
    expect(abstentionOf(echoQuestion, { type: "noul", noul: 0.95 })).toBeNull();
  });

  it("a choice below the confidence floor abstains", () => {
    const low = { type: "choice", choice: "question", probabilities: { question: 1 }, confidence: 0.2 } as const;
    const high = { ...low, confidence: 0.9 };
    expect(abstentionOf(classifyQuestion, low)).toBe("abstained");
    expect(abstentionOf(classifyQuestion, high)).toBeNull();
  });

  it("a score below the confidence floor abstains", () => {
    const answer = { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.1 } as const;
    expect(abstentionOf(lengthQuestion, answer)).toBe("abstained");
  });

  it("an out-of-range abstain band or confidence floor is rejected", () => {
    expect(() => defineNoul({ ...noulSpec("example.band", "1"), abstainBand: [0.7, 0.3] })).toThrow(/abstain band/);
    expect(() =>
      defineChoice({
        ...noulSpec("example.conf", "1"),
        options: { a: "a", b: "b" },
        minConfidence: 1.5,
        decide: () => ({ value: true, rule: "r", action: "a" }),
      }),
    ).toThrow(/minConfidence/);
  });
});
