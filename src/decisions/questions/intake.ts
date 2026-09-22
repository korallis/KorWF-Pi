/**
 * `intake.classify@1` — free-text intake classification (issue #34; PLAN
 * §3.A).
 *
 * Secondary convenience only: command-driven paths (`/korwf plan`,
 * `/korwf run`) are primary and never route through this question. This is
 * asked only when `classifyByRules` (src/workflow/intake-rules.ts) found no
 * deterministic match — "deterministic rules before semantic
 * classification" (PLAN §3.A).
 *
 * The option set mirrors `IntakeClass` plus an explicit `unknown`, per PLAN
 * §6 "explicit boundary cases and none/unknown outcomes". The deterministic
 * fallback (no key, transport error, abstention) is always `"unknown"` —
 * "Never infer authorization for irreversible actions from a Jev score."
 * There is nothing here to infer a guess from once the rules already gave
 * up, so guessing is refused rather than attempted.
 */
import { defineChoice, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { IntakeClass } from "../../workflow/intake-rules.ts";

export interface IntakeClassifyState {
  readonly text: string;
}

/** The question's result type: every `IntakeClass` plus `unknown`. */
export type IntakeClassifyResult = IntakeClass | "unknown";

const OPTIONS: Readonly<Record<IntakeClassifyResult, string>> = {
  explanation: "The user wants something explained or described; no change to the repo is requested",
  investigation: "The user wants something looked into, debugged, or diagnosed before any change",
  implementation: "The user is asking for a change to be made: code, config, or content",
  review: "The user wants existing work (a diff, a PR, a design) critiqued or checked",
  planning: "The user wants a plan, design, or approach proposed, not carried out yet",
  clarification: "The user is asking to clarify something from earlier in the conversation",
  unknown: "None of the above fit, or the text gives no reliable signal",
};

function isIntakeClassifyResult(value: string): value is IntakeClassifyResult {
  return value in OPTIONS;
}

/**
 * `intake.classify@1`. Fallback is always `"unknown"` regardless of reason
 * (disabled, transport error, abstention, invalid response): by the time
 * this question is asked, the deterministic rules already found nothing, so
 * there is no cheap signal left to fall back on — an honest `unknown` beats
 * a guess (PLAN §3.A "Never infer authorization for irreversible actions
 * from a Jev score").
 */
export const intakeClassifyQuestion: QuestionDefinition<IntakeClassifyState, IntakeClassifyResult> = defineChoice<
  IntakeClassifyState,
  IntakeClassifyResult
>({
  id: "intake.classify",
  version: "1",
  prompt:
    "The user sent this free-text message outside of any `/korwf` command. Classify what kind of request it is: " +
    "does it ask for an explanation, an investigation, an implementation change, a review of existing work, a " +
    "plan/design proposal, or a clarification of something said earlier? If none of these clearly fit, or the " +
    "text is too ambiguous to tell, answer `unknown`.",
  options: OPTIONS,
  minConfidence: 0.55,
  state: (input) => ({ text: input.text }),
  decide: (answer) => {
    const value: IntakeClassifyResult = isIntakeClassifyResult(answer.choice) ? answer.choice : "unknown";
    return { value, rule: `intake.classify:${value}`, action: value };
  },
  fallback: () => ({ value: "unknown", action: "unknown" }),
  replay: (action) => (isIntakeClassifyResult(action) ? action : null),
  boundaries: [
    { name: "empty text", state: { text: "" }, expectFallback: "unknown" },
    { name: "no key / disabled always unknown", state: { text: "do the thing" }, expectFallback: "unknown" },
  ],
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Hash as reviewed; editing prompt/options without a version bump fails registration. */
export const INTAKE_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "intake.classify@1": intakeClassifyQuestion.contentHash,
});

export const intakeQuestionRegistry = new QuestionRegistry();
intakeQuestionRegistry.register(intakeClassifyQuestion as QuestionDefinition<unknown, unknown>, {
  pinnedHash: intakeClassifyQuestion.contentHash,
});
