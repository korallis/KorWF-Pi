/**
 * Context evaluation questions (issue #35; PLAN §3.B "Jev ranks bounded
 * candidates and flags stale, contradictory, or irrelevant material").
 *
 * Three versioned questions, built with `src/decisions/question.ts` exactly
 * like every other family (#27):
 *
 *  - `context.relevance@1` (score) — how relevant is this excerpt to the
 *    query. Disabled fallback: normalised `rg` match score (PLAN §3.B "…
 *    disabled fallback = rank by rg score and recency").
 *  - `context.staleness@1` (score) — how likely is this excerpt to be out of
 *    date. Disabled fallback: age-in-days thresholds.
 *  - `context.contradiction@1` (choice) — does this excerpt conflict with
 *    the other excerpts already shortlisted. Disabled fallback: `"unknown"`
 *    — code cannot detect a semantic contradiction without a model, and
 *    `"unknown"` is exactly the explicit none/unknown outcome PLAN §6
 *    requires rather than a guess.
 *
 * These questions never see a whole file: `contextState` builds the minimal
 * state (`src/security/outbound.ts` `pick`), and every string in it still
 * passes through the outbound policy in `src/decisions/ask.ts` before
 * anything is sent.
 */
import { defineChoice, defineScore, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";

/** Minimal state one context question is evaluated over. */
export interface ContextQuestionState {
  readonly query: string;
  readonly path: string;
  /** `"startLine-endLine"`, human-readable, part of the sent state. */
  readonly range: string;
  readonly text: string;
  /** Ordinary-search match score (`Candidate.matchScore`); drives the fallback. */
  readonly matchScore: number;
  /** Days since last commit; `null` when unknown. Drives the staleness fallback. */
  readonly ageDays: number | null;
  /** A few other shortlisted excerpts' text, for contradiction checking. */
  readonly otherExcerpts: readonly string[];
}

function toJevState(input: ContextQuestionState): JevState {
  return {
    query: input.query,
    path: input.path,
    range: input.range,
    text: input.text,
    otherExcerpts: input.otherExcerpts,
  };
}

// ---------------------------------------------------------------------------
// relevance
// ---------------------------------------------------------------------------

/** Relevance levels, lowest first — index doubles as the fallback/decide value. */
export const RELEVANCE_LEVELS = ["Not relevant to the query", "Somewhat relevant", "Highly relevant"] as const;

/**
 * Deterministic relevance fallback (PLAN §3.B "rank by rg score"): a match
 * score of 0 is not relevant, 1-2 matches is somewhat relevant, 3+ is highly
 * relevant. Pure function of `matchScore` so it is testable on its own.
 */
export function relevanceFallbackScore(matchScore: number): 0 | 1 | 2 {
  if (matchScore <= 0) return 0;
  if (matchScore < 3) return 1;
  return 2;
}

export const relevanceQuestion: QuestionDefinition<ContextQuestionState, number> = defineScore<ContextQuestionState, number>({
  id: "context.relevance",
  version: "1",
  prompt:
    "Given `query` and the excerpt `text` from `path` at `range`, how relevant is this excerpt to answering or " +
    "acting on the query?",
  levels: [...RELEVANCE_LEVELS],
  minConfidence: 0.5,
  state: toJevState,
  decide: (answer) => ({
    value: Math.round(answer.score),
    rule: `relevance:${Math.round(answer.score)}`,
    action: String(Math.round(answer.score)),
  }),
  fallback: (input) => {
    const value = relevanceFallbackScore(input.matchScore);
    return { value, rule: "rg_match_score", action: String(value) };
  },
  replay: (action) => (/^[0-2]$/.test(action) ? Number(action) : null),
  boundaries: [
    { name: "no matches", state: emptyState({ matchScore: 0 }), expectFallback: 0 },
    { name: "one match", state: emptyState({ matchScore: 1 }), expectFallback: 1 },
    { name: "many matches", state: emptyState({ matchScore: 5 }), expectFallback: 2 },
  ],
});

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

export const STALENESS_LEVELS = ["Fresh", "Possibly stale", "Likely stale"] as const;

/** Thresholds, in days, for the deterministic staleness fallback. */
export const STALENESS_FRESH_DAYS = 30;
export const STALENESS_AGING_DAYS = 180;

/**
 * Deterministic staleness fallback (PLAN §3.B "…and recency"). `null` age
 * (untracked file, no repo) is treated as fresh: code has no evidence of
 * staleness, and guessing stale would silently drop material that might be
 * exactly right.
 */
export function stalenessFallbackScore(ageDays: number | null): 0 | 1 | 2 {
  if (ageDays === null) return 0;
  if (ageDays < STALENESS_FRESH_DAYS) return 0;
  if (ageDays < STALENESS_AGING_DAYS) return 1;
  return 2;
}

export const stalenessQuestion: QuestionDefinition<ContextQuestionState, number> = defineScore<ContextQuestionState, number>({
  id: "context.staleness",
  version: "1",
  prompt:
    "Given the excerpt `text` from `path` at `range`, how likely is it that this content is stale — no longer " +
    "true of the current codebase?",
  levels: [...STALENESS_LEVELS],
  minConfidence: 0.5,
  state: toJevState,
  decide: (answer) => ({
    value: Math.round(answer.score),
    rule: `staleness:${Math.round(answer.score)}`,
    action: String(Math.round(answer.score)),
  }),
  fallback: (input) => {
    const value = stalenessFallbackScore(input.ageDays);
    return { value, rule: "age_days", action: String(value) };
  },
  replay: (action) => (/^[0-2]$/.test(action) ? Number(action) : null),
  boundaries: [
    { name: "unknown age", state: emptyState({ ageDays: null }), expectFallback: 0 },
    { name: "recent", state: emptyState({ ageDays: 1 }), expectFallback: 0 },
    { name: "aging", state: emptyState({ ageDays: 60 }), expectFallback: 1 },
    { name: "old", state: emptyState({ ageDays: 400 }), expectFallback: 2 },
  ],
});

// ---------------------------------------------------------------------------
// contradiction
// ---------------------------------------------------------------------------

export type ContradictionVerdict = "contradicts" | "consistent" | "unknown";

export const contradictionQuestion: QuestionDefinition<ContextQuestionState, ContradictionVerdict> = defineChoice<
  ContextQuestionState,
  ContradictionVerdict
>({
  id: "context.contradiction",
  version: "1",
  prompt:
    "Given the excerpt `text` from `path` and the other shortlisted excerpts in `otherExcerpts`, does `text` " +
    "state something that directly conflicts with one of them?",
  options: {
    contradicts: "`text` asserts something that at least one entry in `otherExcerpts` directly contradicts",
    consistent: "`text` does not conflict with any entry in `otherExcerpts`",
    unknown: "Not enough information to tell, or `otherExcerpts` is empty",
  },
  minConfidence: 0.5,
  state: toJevState,
  decide: (answer) => {
    const value = (answer.choice === "contradicts" || answer.choice === "consistent" ? answer.choice : "unknown") as ContradictionVerdict;
    return { value, rule: `contradiction:${value}`, action: value };
  },
  // Deterministic fallback is always "unknown": detecting a semantic
  // contradiction between two texts is exactly the kind of judgment code
  // cannot make without a model (PLAN §6 explicit none/unknown outcomes).
  fallback: () => ({ value: "unknown", action: "unknown" }),
  replay: (action) => (action === "contradicts" || action === "consistent" || action === "unknown" ? action : null),
  boundaries: [
    { name: "no other excerpts", state: emptyState({ otherExcerpts: [] }), expectFallback: "unknown" },
    { name: "always unknown with no model", state: emptyState({ otherExcerpts: ["something"] }), expectFallback: "unknown" },
  ],
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Hashes as reviewed; editing prompt/levels/options without a version bump fails registration. */
export const CONTEXT_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "context.relevance@1": relevanceQuestion.contentHash,
  "context.staleness@1": stalenessQuestion.contentHash,
  "context.contradiction@1": contradictionQuestion.contentHash,
});

export const contextQuestionRegistry = new QuestionRegistry();
for (const question of [relevanceQuestion, stalenessQuestion, contradictionQuestion] as const) {
  contextQuestionRegistry.register(question as QuestionDefinition<unknown, unknown>, {
    pinnedHash: question.contentHash,
  });
}

// ---------------------------------------------------------------------------
// test/boundary helper
// ---------------------------------------------------------------------------

/** A minimal valid state, overridden per boundary example. Not exported product API. */
function emptyState(overrides: Partial<ContextQuestionState>): ContextQuestionState {
  return {
    query: "q",
    path: "f.ts",
    range: "1-1",
    text: "t",
    matchScore: 0,
    ageDays: null,
    otherExcerpts: [],
    ...overrides,
  };
}
