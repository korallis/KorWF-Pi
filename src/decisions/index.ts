/**
 * Versioned Jev questions and composition policies (issue #27; PLAN §6;
 * docs/adr/0002-source-layout.md, docs/questions.md).
 *
 * This module sits on top of `src/jev/` (transport #24, validation #25) and
 * `src/storage/` (#23) and adds three things:
 *
 * 1. **Question definitions** — `defineNoul` / `defineChoice` / `defineScore`
 *    produce a versioned artefact carrying its prompt, options, minimal
 *    state, interpretation, abstention policy, boundary examples and a
 *    deterministic fallback.
 * 2. **A registry** keyed by `id@version` with a content-hash pin, so text
 *    cannot change without a version bump.
 * 3. **Composition** — `ask` / `askAll` / `askStaged` batch independent
 *    questions and stage dependent ones, recording a Decision on every path,
 *    plus `compose.ts` for combining narrow answers in code.
 */
export type {
  AbstainBand,
  AnyQuestionDefinition,
  BoundaryExample,
  ChoiceSpec,
  FallbackOutcome,
  FallbackReason,
  NoulSpec,
  Outcome,
  QuestionDefinition,
  QuestionType,
  ScoreSpec,
} from "./question.ts";
export {
  abstentionOf,
  assertBoundaries,
  assertQuestionNaming,
  defineChoice,
  defineNoul,
  defineScore,
  QuestionDefinitionError,
  questionContentHash,
  questionKey,
} from "./question.ts";

export type { RegisteredQuestion } from "./registry.ts";
export { QuestionRegistry, questionRegistry } from "./registry.ts";

export type {
  DecisionDraft,
  DecisionLookup,
  DecisionRecorderOptions,
  DecisionSink,
  DecisionSubject,
} from "./record.ts";
export { DecisionRecorder, FALLBACK_USAGE, MemoryDecisionSink, UNPRICED_JEV_USAGE } from "./record.ts";

export type { AskAllOptions, AskContext, AskItem, DecisionResult, Stage, StagedRun } from "./ask.ts";
export { ask, askAll, askStaged, DEFAULT_CONCURRENCY, distributionOf, hashState, resolveAnswer } from "./ask.ts";

export type { Composed } from "./compose.ts";
export { allTrue, anyTrue, conservative, majority, rankBy } from "./compose.ts";
