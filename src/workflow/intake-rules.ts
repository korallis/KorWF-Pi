/**
 * Free-text intake classification — deterministic rules (issue #34; PLAN §3.A).
 *
 * "Free-text intake classification ... is a secondary convenience.
 * Deterministic rules before semantic classification. Keep a short path for
 * trivial work." and "Preserve explicit user instructions; distinguish
 * requests to discuss from requests to act." and "Never infer authorization
 * for irreversible actions from a Jev score."
 *
 * This module only classifies; it never acts. Command-driven paths
 * (`/korwf plan`, `/korwf run`) remain primary and are untouched by anything
 * here — see `src/workflow/intake.ts` (#33) for those. `classifyByRules` is
 * an ordered list of cheap, explainable checks; when none of them produce a
 * confident answer the result is `null` and the caller may escalate to
 * `intake.classify@1` (src/decisions/questions/intake.ts). Ambiguity is
 * always reported as `"clarify"`, never guessed.
 */

export type IntakeClass =
  | "explanation"
  | "investigation"
  | "implementation"
  | "review"
  | "planning"
  | "clarification";

/** Advisory classification result. Never triggers an action by itself. */
export interface IntakeClassification {
  readonly intakeClass: IntakeClass | "unknown";
  /** Which rule (or "jev") produced this, for observability. */
  readonly rule: string;
  /** `true` when this is the trivial fast path (no workflow needed). */
  readonly trivial: boolean;
}

export interface RuleMatch {
  readonly intakeClass: IntakeClass;
  readonly rule: string;
  readonly trivial: boolean;
}

/** One deterministic classifier. Returns `null` when it does not apply. */
export interface IntakeRule {
  readonly id: string;
  match(text: string): RuleMatch | null;
}
