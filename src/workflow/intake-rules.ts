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

// ---------------------------------------------------------------------------
// deterministic rules, evaluated in order
// ---------------------------------------------------------------------------

const QUESTION_MARK = /\?\s*$/;

// "why does X break" reads like explanation wording but is a request to dig
// in, so it must be checked before the generic explanation rule.
const INVESTIGATION_LEAD = /^\s*(why (is|are|does|do|did|won't|can't)|investigate|debug|diagnose|figure out|look into|find out|track down)\b/i;

const EXPLANATION_LEAD = /^\s*(what (is|are|does|do)|how (does|do|is|are)|explain|describe|tell me about|walk me through)\b/i;

const REVIEW_LEAD = /^\s*(review|critique|check|look at|feedback on|any (thoughts|concerns) (on|about))\b/i;

const PLANNING_LEAD = /^\s*(plan|design|propose|outline|how should (we|i)|what('s| is) the best way|sketch out)\b/i;

// Imperative verbs that request a change be made. Ordered leading-verb check
// per PLAN §3.A "leading verbs".
const IMPLEMENTATION_LEAD =
  /^\s*(add|fix|implement|create|build|write|refactor|remove|delete|update|change|rename|move|migrate|upgrade|bump|wire up|hook up|set up|configure)\b/i;

// A path-shaped token: has a slash or a recognised source extension.
const FILE_PATH = /(\.\/|\/)?[\w-]+\/[\w./-]+|\b[\w-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|java|c|cpp|h|yml|yaml|toml|css|html)\b/i;

const CLARIFICATION_LEAD =
  /^\s*(what do you mean|can you clarify|i don't understand|not sure what you mean|what does that mean|huh\??|clarify\b)/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Ordered deterministic classifiers (PLAN §3.A "Deterministic rules before
 * semantic classification"). Each is a narrow, explainable pattern; the
 * first match wins. Order matters: investigation-flavoured questions are
 * checked before the broader explanation pattern, and clarification-of-prior-
 * turn phrasing is checked before anything else since it names itself.
 */
export const DETERMINISTIC_RULES: readonly IntakeRule[] = [
  {
    id: "clarification.meta",
    match: (text) => (CLARIFICATION_LEAD.test(text) ? { intakeClass: "clarification", rule: "clarification.meta", trivial: true } : null),
  },
  {
    id: "investigation.lead_verb",
    match: (text) => (INVESTIGATION_LEAD.test(text) ? { intakeClass: "investigation", rule: "investigation.lead_verb", trivial: false } : null),
  },
  {
    id: "review.lead_verb",
    match: (text) => (REVIEW_LEAD.test(text) ? { intakeClass: "review", rule: "review.lead_verb", trivial: false } : null),
  },
  {
    id: "planning.lead_verb",
    match: (text) => (PLANNING_LEAD.test(text) ? { intakeClass: "planning", rule: "planning.lead_verb", trivial: false } : null),
  },
  {
    // Trivial fast path (PLAN §3.A "Keep a short path for trivial work"): a
    // short, plain question with no file path and no action verb needs no
    // workflow at all.
    id: "explanation.trivial",
    match: (text) => {
      if (!EXPLANATION_LEAD.test(text)) return null;
      const trivial = QUESTION_MARK.test(text) && !FILE_PATH.test(text) && words(text) <= 20;
      return { intakeClass: "explanation", rule: "explanation.trivial", trivial };
    },
  },
  {
    id: "implementation.lead_verb",
    match: (text) => (IMPLEMENTATION_LEAD.test(text) ? { intakeClass: "implementation", rule: "implementation.lead_verb", trivial: false } : null),
  },
  {
    // A bare question mark with no other signal and no lead verb: treat as
    // explanation ("discuss", not "act") rather than falling through to an
    // unknown outcome, per PLAN §3.A "distinguish requests to discuss from
    // requests to act".
    id: "explanation.bare_question",
    match: (text) => {
      if (!QUESTION_MARK.test(text)) return null;
      if (IMPLEMENTATION_LEAD.test(text)) return null;
      return { intakeClass: "explanation", rule: "explanation.bare_question", trivial: words(text) <= 20 && !FILE_PATH.test(text) };
    },
  },
];

/**
 * Run the deterministic rules in order and return the first match, or `null`
 * when none apply — the caller's signal to escalate to semantic
 * classification (or, with no Jev, to `clarify`). Never guesses.
 */
export function classifyByRules(text: string): RuleMatch | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  for (const rule of DETERMINISTIC_RULES) {
    const match = rule.match(trimmed);
    if (match !== null) return match;
  }
  return null;
}
