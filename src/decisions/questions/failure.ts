/**
 * `failure.classify@1` and `stall.repeated_approach@1` (issue #52; PLAN §3.G, §6).
 *
 * Both questions are asked **only** after the deterministic layer in
 * `src/workflow/failure.ts` / `src/workflow/stall.ts` declined to decide.
 * Deterministic rules first, semantic classification for the remainder.
 *
 * Both fall back to the honest answer, never a guess:
 *  - `failure.classify@1` falls back to `unknown`, which carries
 *    `evidenceRequests` and `needsEvidence: true` so nothing acts on it.
 * The issue names the second question `stall.repeatedApproach@1`; the registry's
 * naming rule (`docs/questions.md` §1, enforced by `assertQuestionNaming`) requires
 * lower snake case, so it is registered as `stall.repeated_approach@1`. The rule is
 * enforced in code and cannot be bypassed, so the id follows it.
 *
 *  - `stall.repeated_approach@1` falls back to `not_repeated`: with no key,
 *    the structural fingerprint comparison in `stall.ts` is the only claim
 *    that can be supported, and inventing a stall would stop work the
 *    evidence does not condemn.
 */
import { defineChoice, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import {
  FAILURE_CATEGORY_DESCRIPTIONS,
  FAILURE_CATEGORIES,
  type FailureCategory,
} from "../../workflow/failure.ts";

// ---------------------------------------------------------------------------
// failure.classify@1
// ---------------------------------------------------------------------------

/**
 * Minimal state sent outbound. Only already-redacted, already-truncated
 * fields: the outbound policy (#28) filters this again before it leaves.
 */
export interface FailureClassifyState {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderrTail: string;
  readonly stdoutTail: string;
  readonly taskGoal: string;
}

export type FailureClassifyResult = FailureCategory;

function isFailureCategory(value: string): value is FailureCategory {
  return (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/** Option text is the shared taxonomy description, so code and prompt cannot drift. */
const FAILURE_OPTIONS: Readonly<Record<FailureCategory, string>> = FAILURE_CATEGORY_DESCRIPTIONS;

/**
 * `failure.classify@1`. Asked only when `classifyFailureByRules` returned
 * `needsJev`. The answer is advisory: it carries the model's confidence and
 * is recorded as `source: "jev"`, and anything below `minConfidence`
 * abstains into `unknown`.
 */
export const failureClassifyQuestion: QuestionDefinition<FailureClassifyState, FailureClassifyResult> = defineChoice<
  FailureClassifyState,
  FailureClassifyResult
>({
  id: "failure.classify",
  version: "1",
  prompt:
    "A verification check or worker attempt failed and no deterministic rule matched its output. " +
    "Classify the kind of failure from the command, exit code and captured output. " +
    "Answer `unknown` unless the output positively supports one category — a plausible-sounding guess is worse " +
    "than an explicit unknown, because an unknown asks for more evidence and a guess sends recovery the wrong way.",
  options: FAILURE_OPTIONS,
  minConfidence: 0.6,
  state: (input) => ({
    command: input.command,
    exitCode: input.exitCode,
    stderrTail: input.stderrTail,
    stdoutTail: input.stdoutTail,
    taskGoal: input.taskGoal,
  }),
  decide: (answer) => {
    const value: FailureClassifyResult = isFailureCategory(answer.choice) ? answer.choice : "unknown";
    return { value, rule: `failure.classify:${value}`, action: value };
  },
  fallback: () => ({ value: "unknown", action: "unknown" }),
  replay: (action) => (isFailureCategory(action) ? action : null),
  boundaries: [
    {
      name: "no key / disabled falls back to unknown",
      state: { command: "npm test", exitCode: 1, stderrTail: "", stdoutTail: "", taskGoal: "add a check" },
      expectFallback: "unknown",
    },
    {
      name: "empty output falls back to unknown rather than guessing implementation",
      state: { command: "", exitCode: null, stderrTail: "", stdoutTail: "", taskGoal: "" },
      expectFallback: "unknown",
    },
  ],
});

// ---------------------------------------------------------------------------
// stall.repeated_approach@1
// ---------------------------------------------------------------------------

/**
 * Two attempt summaries whose *fingerprints differ*. The structural check in
 * `stall.ts` already answers the identical-fingerprint case; this question
 * exists only for "different diff, same idea".
 */
export interface RepeatedApproachState {
  readonly taskGoal: string;
  readonly previousApproach: string;
  readonly currentApproach: string;
  readonly previousFailure: string;
}

export type RepeatedApproachResult = "repeated" | "not_repeated" | "unknown";

const APPROACH_OPTIONS: Readonly<Record<RepeatedApproachResult, string>> = Object.freeze({
  repeated:
    "The current attempt is the same idea as the previous one — the same mechanism against the same cause — so it will fail the same way.",
  not_repeated:
    "The current attempt is a materially different approach: a different mechanism, a different cause addressed, or new information used.",
  unknown: "The summaries do not say enough to tell the two approaches apart.",
});

function isRepeatedApproachResult(value: string): value is RepeatedApproachResult {
  return value in APPROACH_OPTIONS;
}

/**
 * `stall.repeated_approach@1`. Fallback is `not_repeated`: with no key the
 * only supportable claim is the structural fingerprint comparison, which
 * already said the two attempts differ. Falling back to `repeated` would
 * halt a task on no evidence at all.
 */
export const stallRepeatedApproachQuestion: QuestionDefinition<RepeatedApproachState, RepeatedApproachResult> =
  defineChoice<RepeatedApproachState, RepeatedApproachResult>({
    id: "stall.repeated_approach",
    version: "1",
    prompt:
      "Two successive attempts at the same task produced different diffs. Judge whether the second is genuinely a " +
      "different approach, or the same idea re-expressed and therefore doomed to fail the same way. " +
      "Answer `unknown` if the summaries do not support either conclusion.",
    options: APPROACH_OPTIONS,
    minConfidence: 0.65,
    state: (input) => ({
      taskGoal: input.taskGoal,
      previousApproach: input.previousApproach,
      currentApproach: input.currentApproach,
      previousFailure: input.previousFailure,
    }),
    decide: (answer) => {
      const value: RepeatedApproachResult = isRepeatedApproachResult(answer.choice) ? answer.choice : "unknown";
      return { value, rule: `stall.repeated_approach:${value}`, action: value };
    },
    fallback: () => ({ value: "not_repeated", action: "not_repeated" }),
    replay: (action) => (isRepeatedApproachResult(action) ? action : null),
    boundaries: [
      {
        name: "no key / disabled never invents a stall",
        state: { taskGoal: "g", previousApproach: "a", currentApproach: "b", previousFailure: "f" },
        expectFallback: "not_repeated",
      },
      {
        name: "empty summaries still do not invent a stall",
        state: { taskGoal: "", previousApproach: "", currentApproach: "", previousFailure: "" },
        expectFallback: "not_repeated",
      },
    ],
  });

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Hashes as reviewed; editing prompt/options without a version bump fails registration. */
export const FAILURE_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "failure.classify@1": failureClassifyQuestion.contentHash,
  "stall.repeated_approach@1": stallRepeatedApproachQuestion.contentHash,
});

export const failureQuestionRegistry = new QuestionRegistry();
failureQuestionRegistry.register(failureClassifyQuestion as QuestionDefinition<unknown, unknown>, {
  pinnedHash: failureClassifyQuestion.contentHash,
});
failureQuestionRegistry.register(stallRepeatedApproachQuestion as QuestionDefinition<unknown, unknown>, {
  pinnedHash: stallRepeatedApproachQuestion.contentHash,
});
