/**
 * Versioned question definitions (issue #27; PLAN §6 "Jev decision design").
 *
 * A question is a *shipped, versioned artefact*: a stable id, a version, one
 * narrow prompt, its option/level set, the minimal state it is evaluated
 * over, how a validated answer maps to a typed result, the boundary cases it
 * is expected to get right, and — always — a deterministic fallback for when
 * Jev is disabled, unreachable, or abstains (PLAN §2.4 "every Jev-assisted
 * decision has a deterministic fallback").
 *
 * This module composes ON TOP of `src/jev/` and never re-implements it:
 * `buildQuestion()` returns the `JevQuestion` shapes from `jev/transport.ts`,
 * and `interpret()` consumes the `JevAnswer` shapes produced by
 * `jev/validate.ts` (#24, #25). Transport, retries and validation stay where
 * they are.
 *
 * Naming and versioning policy (docs/questions.md):
 * - id is `family.question`, lower snake case, e.g. `task.atomic`.
 * - version is an integer string, bumped whenever the *content hash* changes:
 *   prompt text, option labels, level text, or the abstention policy.
 * - the pair `id@version` is the registry key and is recorded on every
 *   `Decision` row, so an answer can always be traced to the exact wording
 *   that produced it.
 */
import { createHash } from "node:crypto";
import type { ChoiceQuestion, JevQuestion, JevState, NoulQuestion, ScoreQuestion } from "../jev/transport.ts";
import type { ChoiceAnswer, JevAnswer, NoulAnswer, ScoreAnswer } from "../jev/validate.ts";
import { canonicalJson } from "../storage/repos/base.ts";

export type QuestionType = "noul" | "choice" | "score";

/** Why a decision fell back to its deterministic answer. Never "unknown". */
export type FallbackReason =
  | "disabled"
  | "transport_error"
  | "cancelled"
  | "invalid_response"
  | "missing_answer"
  | "abstained"
  | "answer_type_mismatch";

/** An answered question: the typed result plus the rule that produced it. */
export interface Outcome<TResult> {
  readonly value: TResult;
  /** Policy rule id recorded on the Decision (`Decision.policyRule`). */
  readonly rule: string;
  /** What code will do with it (`Decision.action`). */
  readonly action: string;
}

/**
 * A fallback outcome. `rule` is optional: when omitted the recorded
 * `policyRule` is exactly `"fallback"` (issue #27 acceptance criterion),
 * otherwise `fallback:<rule>`.
 */
export interface FallbackOutcome<TResult> {
  readonly value: TResult;
  readonly rule?: string;
  readonly action: string;
}

/**
 * An explicit boundary case (PLAN §6 "explicit boundary cases and
 * none/unknown outcomes"). Every definition must carry at least one, and
 * `assertBoundaries` checks the deterministic fallback against them — so the
 * no-key path is exercised by construction rather than by hope.
 */
export interface BoundaryExample<TState, TResult> {
  readonly name: string;
  readonly state: TState;
  /** Expected *fallback* result for this state. */
  readonly expectFallback: TResult;
  readonly note?: string;
}

/** Abstention band for a noul question: answers strictly inside fall back. */
export type AbstainBand = readonly [low: number, high: number];

export interface QuestionDefinition<TState, TResult> {
  readonly id: string;
  readonly version: string;
  /** `id@version`; the registry key and the value recorded on a Decision. */
  readonly key: string;
  readonly type: QuestionType;
  readonly prompt: string;
  /** sha256 over the version-relevant content. Changing text changes this. */
  readonly contentHash: string;
  /** Minimum confidence for choice/score answers; below it, fall back. */
  readonly minConfidence: number | null;
  /** Noul answers inside this open interval are treated as abstentions. */
  readonly abstainBand: AbstainBand | null;
  readonly boundaries: readonly BoundaryExample<TState, TResult>[];
  /** Minimal relevant state for one evaluation (PLAN §6). */
  buildState(input: TState): JevState;
  /** The static question body sent to Jev. Never depends on state. */
  buildQuestion(): JevQuestion;
  /** Map a validated answer to a result; `null` if the answer type is wrong. */
  interpret(answer: JevAnswer, input: TState): Outcome<TResult> | null;
  /** Deterministic answer used whenever Jev did not supply a usable one. */
  fallback(input: TState, reason: FallbackReason): FallbackOutcome<TResult>;
  /**
   * Rebuild the typed result from a *recorded* `Decision.action`, so a
   * decision whose complete versioned state hash still matches can be
   * replayed instead of re-asked (docs/records.md §10 rule 4). Returns `null`
   * when the question cannot rebuild it, in which case the question is simply
   * asked again — reuse is an optimisation, never a correctness dependency.
   */
  replay(action: string, input: TState): TResult | null;
}

/**
 * Any definition, for registries and heterogeneous batches. Methods (not
 * arrow properties) are bivariant, so every concrete definition is assignable
 * here without `any`.
 */
export type AnyQuestionDefinition = QuestionDefinition<unknown, unknown>;

// ---------------------------------------------------------------------------
// content hashing and the version rule
// ---------------------------------------------------------------------------

/**
 * Hash of everything that changes the *meaning* of a question: its id, type,
 * prompt, option/level wording, and its abstention policy. Deliberately not
 * the version — that is the whole point. A registry whose recorded hash no
 * longer matches its pinned hash means someone edited the text and did not
 * bump the version (issue #27 acceptance criterion).
 */
export function questionContentHash(parts: {
  readonly id: string;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly criteria: unknown;
  readonly minConfidence: number | null;
  readonly abstainBand: AbstainBand | null;
}): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

/** `id@version` — the registry key, and `Decision.questionId`/`questionVersion`. */
export function questionKey(id: string, version: string): string {
  return `${id}@${version}`;
}

const ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const VERSION_PATTERN = /^[1-9][0-9]*$/;

/** Enforce the naming/versioning policy at definition time, not at review time. */
export function assertQuestionNaming(id: string, version: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new QuestionDefinitionError(
      `question id ${JSON.stringify(id)} must be "family.question" in lower snake case (docs/questions.md §1)`,
    );
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new QuestionDefinitionError(
      `question version ${JSON.stringify(version)} must be a positive integer string (docs/questions.md §1)`,
    );
  }
}

/** Thrown only for programmer error in a question definition; never for input. */
export class QuestionDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionDefinitionError";
  }
}

// ---------------------------------------------------------------------------
// definition builders, one per question type
// ---------------------------------------------------------------------------

interface CommonSpec<TState, TResult> {
  readonly id: string;
  readonly version: string;
  readonly prompt: string;
  /** Minimal relevant state for one evaluation (PLAN §6). */
  state: (input: TState) => JevState;
  fallback: (input: TState, reason: FallbackReason) => FallbackOutcome<TResult>;
  readonly boundaries: readonly BoundaryExample<TState, TResult>[];
  /** Opt in to decision replay by rebuilding the result from the action. */
  replay?: (action: string, input: TState) => TResult | null;
}

export interface NoulSpec<TState, TResult> extends CommonSpec<TState, TResult> {
  /** Wording of the true/false poles; part of the content hash. */
  readonly criteria?: { readonly true?: string; readonly false?: string };
  /** Probabilities strictly inside this open interval abstain. */
  readonly abstainBand?: AbstainBand;
  decide: (noul: number, input: TState) => Outcome<TResult>;
}

export interface ChoiceSpec<TState, TResult> extends CommonSpec<TState, TResult> {
  /** Option label → its description. Include an explicit none/unknown option. */
  readonly options: Readonly<Record<string, string | null>>;
  readonly minConfidence?: number;
  decide: (answer: ChoiceAnswer, input: TState) => Outcome<TResult>;
}

export interface ScoreSpec<TState, TResult> extends CommonSpec<TState, TResult> {
  /** Ordered level descriptions, lowest first. At least two.  */
  readonly levels: readonly string[];
  readonly minConfidence?: number;
  decide: (answer: ScoreAnswer, input: TState) => Outcome<TResult>;
}

function checkBoundaries(id: string, boundaries: readonly BoundaryExample<unknown, unknown>[]): void {
  if (boundaries.length === 0) {
    throw new QuestionDefinitionError(
      `question ${id} declares no boundary examples; PLAN §6 requires explicit boundary cases`,
    );
  }
}

function checkBand(id: string, band: AbstainBand | undefined): AbstainBand | null {
  if (band === undefined) return null;
  const [low, high] = band;
  if (!(low >= 0 && high <= 1 && low < high)) {
    throw new QuestionDefinitionError(`question ${id}: abstain band [${low}, ${high}] must satisfy 0 <= low < high <= 1`);
  }
  return band;
}

function checkConfidence(id: string, minConfidence: number | undefined): number | null {
  if (minConfidence === undefined) return null;
  if (!(minConfidence >= 0 && minConfidence <= 1)) {
    throw new QuestionDefinitionError(`question ${id}: minConfidence ${minConfidence} outside [0,1]`);
  }
  return minConfidence;
}

/** Define a noul (true/false probability) question. */
export function defineNoul<TState, TResult>(spec: NoulSpec<TState, TResult>): QuestionDefinition<TState, TResult> {
  assertQuestionNaming(spec.id, spec.version);
  checkBoundaries(spec.id, spec.boundaries);
  const abstainBand = checkBand(spec.id, spec.abstainBand);
  const criteria = spec.criteria ?? {};
  const contentHash = questionContentHash({
    id: spec.id,
    type: "noul",
    prompt: spec.prompt,
    criteria,
    minConfidence: null,
    abstainBand,
  });
  const body: NoulQuestion =
    spec.criteria === undefined
      ? { type: "noul", instructions: spec.prompt }
      : { type: "noul", instructions: spec.prompt, criteria: spec.criteria };
  return {
    id: spec.id,
    version: spec.version,
    key: questionKey(spec.id, spec.version),
    type: "noul",
    prompt: spec.prompt,
    contentHash,
    minConfidence: null,
    abstainBand,
    boundaries: spec.boundaries,
    buildState: (input) => spec.state(input),
    buildQuestion: () => body,
    interpret: (answer, input) => (answer.type === "noul" ? spec.decide((answer as NoulAnswer).noul, input) : null),
    fallback: (input, reason) => spec.fallback(input, reason),
    replay: (action, input) => spec.replay?.(action, input) ?? null,
  };
}

/** Define a choice question. Always include an explicit none/unknown option. */
export function defineChoice<TState, TResult>(spec: ChoiceSpec<TState, TResult>): QuestionDefinition<TState, TResult> {
  assertQuestionNaming(spec.id, spec.version);
  checkBoundaries(spec.id, spec.boundaries);
  const minConfidence = checkConfidence(spec.id, spec.minConfidence);
  if (Object.keys(spec.options).length < 2) {
    throw new QuestionDefinitionError(`question ${spec.id}: a choice needs at least two options`);
  }
  const contentHash = questionContentHash({
    id: spec.id,
    type: "choice",
    prompt: spec.prompt,
    criteria: spec.options,
    minConfidence,
    abstainBand: null,
  });
  const body: ChoiceQuestion = { type: "choice", instructions: spec.prompt, criteria: spec.options };
  return {
    id: spec.id,
    version: spec.version,
    key: questionKey(spec.id, spec.version),
    type: "choice",
    prompt: spec.prompt,
    contentHash,
    minConfidence,
    abstainBand: null,
    boundaries: spec.boundaries,
    buildState: (input) => spec.state(input),
    buildQuestion: () => body,
    interpret: (answer, input) => (answer.type === "choice" ? spec.decide(answer, input) : null),
    fallback: (input, reason) => spec.fallback(input, reason),
    replay: (action, input) => spec.replay?.(action, input) ?? null,
  };
}

/** Define an ordered score question (levels are indexed `"0".."n-1"`). */
export function defineScore<TState, TResult>(spec: ScoreSpec<TState, TResult>): QuestionDefinition<TState, TResult> {
  assertQuestionNaming(spec.id, spec.version);
  checkBoundaries(spec.id, spec.boundaries);
  const minConfidence = checkConfidence(spec.id, spec.minConfidence);
  if (spec.levels.length < 2) {
    throw new QuestionDefinitionError(`question ${spec.id}: a score needs at least two levels`);
  }
  const contentHash = questionContentHash({
    id: spec.id,
    type: "score",
    prompt: spec.prompt,
    criteria: spec.levels,
    minConfidence,
    abstainBand: null,
  });
  const body: ScoreQuestion = { type: "score", instructions: spec.prompt, criteria: spec.levels };
  return {
    id: spec.id,
    version: spec.version,
    key: questionKey(spec.id, spec.version),
    type: "score",
    prompt: spec.prompt,
    contentHash,
    minConfidence,
    abstainBand: null,
    boundaries: spec.boundaries,
    buildState: (input) => spec.state(input),
    buildQuestion: () => body,
    interpret: (answer, input) => (answer.type === "score" ? spec.decide(answer, input) : null),
    fallback: (input, reason) => spec.fallback(input, reason),
    replay: (action, input) => spec.replay?.(action, input) ?? null,
  };
}

// ---------------------------------------------------------------------------
// abstention and boundary checking
// ---------------------------------------------------------------------------

/**
 * Does this validated answer count as an abstention for this question?
 * Returns the fallback reason, or `null` when the answer is usable.
 *
 * Two independent rules, both from PLAN §6 ("none/unknown outcomes",
 * "conservative defaults and abstention"):
 * - a noul inside the definition's abstain band is not an answer;
 * - a choice/score below the definition's `minConfidence` is not an answer.
 */
export function abstentionOf(definition: QuestionDefinition<unknown, unknown>, answer: JevAnswer): FallbackReason | null {
  if (answer.type === "noul") {
    const band = definition.abstainBand;
    if (band !== null && answer.noul > band[0] && answer.noul < band[1]) return "abstained";
    return null;
  }
  const floor = definition.minConfidence;
  if (floor !== null && answer.confidence < floor) return "abstained";
  return null;
}

/**
 * Check every declared boundary example against the deterministic fallback.
 * Called by the registry on registration, so a question whose no-key path
 * disagrees with its own documented boundaries cannot ship.
 */
export function assertBoundaries<TState, TResult>(definition: QuestionDefinition<TState, TResult>): void {
  for (const example of definition.boundaries) {
    const got = definition.fallback(example.state, "disabled");
    if (canonicalJson(got.value) !== canonicalJson(example.expectFallback)) {
      throw new QuestionDefinitionError(
        `question ${definition.key} boundary "${example.name}": fallback returned ` +
          `${canonicalJson(got.value)}, expected ${canonicalJson(example.expectFallback)}`,
      );
    }
  }
}
