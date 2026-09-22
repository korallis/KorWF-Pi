/**
 * Capability (skill/tool) relevance question (issue #36; PLAN §3.B "Suggest
 * optional skills/tools; ... never override mandatory skill-loading rules").
 *
 * `capability.relevance@1` ranks one candidate skill/tool against a task
 * description; deterministic fallback = keyword overlap. Mandatory-trigger
 * detection (`detectMandatoryTrigger`) is a separate, purely rule-based
 * check — see its own docstring below — that `src/context/capabilities.ts`
 * applies *before* any Jev question is asked, so a mandatory skill is never
 * gated on a score.
 */
import { defineScore, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";

export interface CapabilityQuestionState {
  readonly task: string;
  readonly name: string;
  readonly kind: "skill" | "tool";
  readonly description: string;
}

function toJevState(input: CapabilityQuestionState): JevState {
  return { task: input.task, name: input.name, kind: input.kind, description: input.description };
}

// ---------------------------------------------------------------------------
// tokenising (shared by the fallback score and mandatory-trigger detection)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by",
  "with", "is", "are", "be", "this", "that", "it", "its", "as", "from",
  "any", "when", "use", "used", "using", "task", "not",
]);

/** Lower-cased, punctuation-stripped, stopword-filtered words of at least 3 chars. */
export function tokenize(text: string): readonly string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Count of distinct tokens shared between `a` and `b`. */
export function sharedKeywordCount(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  let count = 0;
  for (const word of setA) if (setB.has(word)) count += 1;
  return count;
}

/** Deterministic relevance fallback: keyword overlap thresholds, like `context.relevance@1`. */
export function keywordOverlapScore(task: string, description: string): 0 | 1 | 2 {
  const overlap = sharedKeywordCount(task, description);
  if (overlap === 0) return 0;
  if (overlap < 3) return 1;
  return 2;
}
