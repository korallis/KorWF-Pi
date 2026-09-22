/**
 * `failure.classify@1` and `stall.repeatedApproach@1` (issue #52; PLAN §3.G, §6).
 *
 * Both questions are asked **only** after the deterministic layer in
 * `src/workflow/failure.ts` / `src/workflow/stall.ts` declined to decide.
 * Deterministic rules first, semantic classification for the remainder.
 *
 * Both fall back to the honest answer, never a guess:
 *  - `failure.classify@1` falls back to `unknown`, which carries
 *    `evidenceRequests` and `needsEvidence: true` so nothing acts on it.
 *  - `stall.repeatedApproach@1` falls back to `not_repeated`: with no key,
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
