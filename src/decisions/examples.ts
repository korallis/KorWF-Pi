/**
 * `example.echo@1` and friends (issue #27 deliverable: "one example question
 * used only in tests").
 *
 * These are *not* product question families — the real ones arrive with the
 * stages that need them (#28, #29, #31). They exist so the registry, the
 * composition layer and the version-pin machinery have something concrete to
 * exercise, and so the shape of a well-formed definition is written down
 * once: narrow prompt, explicit none/unknown option, an abstention policy,
 * declared boundary cases, and a deterministic fallback that needs no
 * network.
 *
 * They are registered into their own `exampleRegistry`, never into the
 * shipped `questionRegistry`, so no product code path can reach them.
 */
import { defineChoice, defineNoul, defineScore, type QuestionDefinition } from "./question.ts";
import { QuestionRegistry } from "./registry.ts";

/** Input for the example questions: one short piece of text. */
export interface EchoState {
  readonly text: string;
}

/**
 * `example.echo@1` — a noul question with an explicit abstention band.
 *
 * Deterministic fallback: `text` is non-empty. That is a property code can
 * compute with no model at all, which is exactly what a fallback must be
 * (PLAN §2.4).
 */
export const echoQuestion = defineNoul<EchoState, boolean>({
  id: "example.echo",
  version: "1",
  prompt: "Does the state's `text` field contain a non-empty message?",
  criteria: {
    true: "`text` holds at least one non-whitespace character",
    false: "`text` is empty or whitespace only",
  },
  abstainBand: [0.4, 0.6],
  state: (input) => ({ text: input.text }),
  decide: (noul) => ({
    value: noul >= 0.5,
    rule: noul >= 0.5 ? "echo:present" : "echo:absent",
    action: noul >= 0.5 ? "present" : "absent",
  }),
  fallback: (input) => ({
    value: input.text.trim().length > 0,
    action: input.text.trim().length > 0 ? "present" : "absent",
  }),
  replay: (action) => (action === "present" ? true : action === "absent" ? false : null),
  boundaries: [
    { name: "empty string", state: { text: "" }, expectFallback: false },
    { name: "whitespace only", state: { text: "   " }, expectFallback: false, note: "not a message" },
    { name: "one word", state: { text: "hi" }, expectFallback: true },
  ],
});

/** Classification result, with the mandatory none/unknown outcome. */
export type EchoKind = "question" | "statement" | "unknown";

/**
 * `example.classify@1` — a choice question. Note the explicit `unknown`
 * option: a choice without one forces a guess, and PLAN §6 requires
 * none/unknown outcomes to be available answers.
 */
export const classifyQuestion = defineChoice<EchoState, EchoKind>({
  id: "example.classify",
  version: "1",
  prompt: "Is the state's `text` phrased as a question or as a statement?",
  options: {
    question: "It asks something; it would normally end in a question mark",
    statement: "It asserts something",
    unknown: "Neither reading is supported by the text, or the text is empty",
  },
  minConfidence: 0.5,
  state: (input) => ({ text: input.text }),
  decide: (answer) => ({
    value: (answer.choice === "question" || answer.choice === "statement" ? answer.choice : "unknown") as EchoKind,
    rule: `classify:${answer.choice}`,
    action: answer.choice,
  }),
  fallback: (input) => {
    const value: EchoKind = input.text.trim().endsWith("?") ? "question" : input.text.trim() === "" ? "unknown" : "statement";
    return { value, action: value };
  },
  replay: (action) => (action === "question" || action === "statement" || action === "unknown" ? action : null),
  boundaries: [
    { name: "empty is unknown", state: { text: "" }, expectFallback: "unknown" },
    { name: "trailing question mark", state: { text: "is it?" }, expectFallback: "question" },
    { name: "plain assertion", state: { text: "it is" }, expectFallback: "statement" },
  ],
});

/**
 * `example.length@1` — a score question over ordered levels. The fallback is
 * a pure counter, which is the sort of thing PLAN §6 says belongs in code
 * anyway; the question exists to show a score definition, not to argue that
 * counting needs a model.
 */
export const lengthQuestion = defineScore<EchoState, number>({
  id: "example.length",
  version: "1",
  prompt: "How long is the state's `text`?",
  levels: ["Empty or a single word", "A short phrase", "A full sentence or longer"],
  minConfidence: 0.5,
  state: (input) => ({ text: input.text }),
  decide: (answer) => ({
    value: Math.round(answer.score),
    rule: "length:rounded",
    action: String(Math.round(answer.score)),
  }),
  fallback: (input) => {
    const words = input.text.trim().split(/\s+/).filter((w) => w.length > 0).length;
    const value = words <= 1 ? 0 : words <= 4 ? 1 : 2;
    return { value, rule: "word_count", action: String(value) };
  },
  replay: (action) => (/^[0-9]+$/.test(action) ? Number(action) : null),
  boundaries: [
    { name: "empty", state: { text: "" }, expectFallback: 0 },
    { name: "short phrase", state: { text: "two three four" }, expectFallback: 1 },
    { name: "sentence", state: { text: "one two three four five six" }, expectFallback: 2 },
  ],
});

/**
 * Registry holding only the example questions. Separate from the shipped
 * `questionRegistry` on purpose: nothing in product code can look these up.
 */
export const exampleRegistry = new QuestionRegistry();

/**
 * Hashes as reviewed. Registration below pins against them, so editing any
 * prompt, option or level above without bumping the version throws at import
 * time — and fails the drift test. Regenerate deliberately, in the same
 * commit as a version bump.
 */
export const EXAMPLE_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "example.echo@1": "3a016dcc9c7de6c0c154a180ac2a5d2e5b53cdda0f46aa2b99d524a38b83a880",
  "example.classify@1": "6735b5a9f4bf66188c5870b8074aac7c34b2756a880cca1c10d67f1eec38b047",
  "example.length@1": "bb1a7545925ac7f588813047497be9a5f90e4e53c63ff762c8c68d58febb66aa",
});

const EXAMPLE_QUESTIONS: readonly QuestionDefinition<EchoState, unknown>[] = [
  echoQuestion,
  classifyQuestion,
  lengthQuestion,
];

for (const question of EXAMPLE_QUESTIONS) {
  const pinnedHash = EXAMPLE_QUESTION_HASHES[question.key];
  exampleRegistry.register(question, pinnedHash === undefined ? {} : { pinnedHash });
}
