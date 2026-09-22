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
