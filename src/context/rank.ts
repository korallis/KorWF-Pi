/**
 * Bounded context-evaluation tool (issue #35; PLAN §3.B "Jev ranks bounded
 * candidates and flags stale, contradictory, or irrelevant material").
 *
 * This is the one place a context query touches Jev, and it only ever ranks
 * candidates `retrieve.ts` already found — it never searches. Every call is
 * bounded to at most `maxCandidates` (config, default `DEFAULT_MAX_CANDIDATES`)
 * so a query cannot spend an unbounded number of Jev requests; `expandShortlist`
 * lets a caller explicitly ask for more from the same candidate pool instead
 * of silently growing the bound.
 *
 * Ranking composes three questions from `src/decisions/questions/context.ts`
 * through `askAll` (#27): relevance and staleness are independent and batch
 * together, contradiction is asked per-candidate against the *other*
 * shortlisted excerpts. With no Jev key every question answers from its
 * deterministic fallback (rg score / recency / "unknown"), so ranking never
 * requires a key.
 */
import type { AskContext } from "../decisions/ask.ts";
import { askAll, type DecisionResult } from "../decisions/ask.ts";
import {
  contradictionQuestion,
  relevanceQuestion,
  stalenessQuestion,
  type ContextQuestionState,
  type ContradictionVerdict,
} from "../decisions/questions/context.ts";
import type { Candidate } from "./types.ts";

/** Default bound on candidates ranked in one call (PLAN §3.B "bounded"). */
export const DEFAULT_MAX_CANDIDATES = 20;

/** Max other excerpts offered to the contradiction question, for state size. */
const MAX_CONTRADICTION_PEERS = 4;
/** Characters of peer text offered to the contradiction question. */
const PEER_EXCERPT_CHARS = 400;

export interface RankedCandidate {
  readonly candidate: Candidate;
  readonly relevance: number;
  readonly staleness: number;
  readonly contradiction: ContradictionVerdict;
  /** Combined score used to sort: relevance minus a staleness/contradiction penalty. */
  readonly score: number;
  readonly relevanceResult: DecisionResult<number>;
  readonly stalenessResult: DecisionResult<number>;
  readonly contradictionResult: DecisionResult<ContradictionVerdict>;
}

export interface RankOptions {
  /** Bound on candidates evaluated this call. Defaults to `DEFAULT_MAX_CANDIDATES`. */
  readonly maxCandidates?: number;
  readonly reuse?: boolean;
}

function stateFor(query: string, candidate: Candidate, peers: readonly Candidate[]): ContextQuestionState {
  const others = peers
    .filter((p) => p !== candidate)
    .slice(0, MAX_CONTRADICTION_PEERS)
    .map((p) => p.text.slice(0, PEER_EXCERPT_CHARS));
  const range = candidate.provenance.range;
  return {
    query,
    path: candidate.provenance.path,
    range: range === null ? "whole-file" : `${range.startLine}-${range.endLine}`,
    text: candidate.text,
    matchScore: candidate.matchScore,
    ageDays: candidate.ageDays,
    otherExcerpts: others,
  };
}

/** Combined sort score: relevance (0-2) minus penalties for staleness/contradiction. */
export function combinedScore(relevance: number, staleness: number, contradiction: ContradictionVerdict): number {
  const contradictionPenalty = contradiction === "contradicts" ? 1.5 : 0;
  return relevance - staleness * 0.5 - contradictionPenalty;
}

/**
 * Rank at most `options.maxCandidates` candidates for `query`. Candidates
 * beyond the bound are simply not evaluated — call `expandShortlist` for
 * more rather than raising the bound silently. Pinned candidates are not
 * this module's concern: merge them in with `src/context/pins.ts` after
 * ranking (they are preserved "regardless of ranking").
 */
export async function rankCandidates(
  ctx: AskContext,
  query: string,
  candidates: readonly Candidate[],
  options: RankOptions = {},
): Promise<readonly RankedCandidate[]> {
  const bound = Math.max(1, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const bounded = candidates.slice(0, bound);
  if (bounded.length === 0) return [];

  const reuse = options.reuse ?? false;
  const items = bounded.flatMap((candidate) => [
    { question: relevanceQuestion, input: stateFor(query, candidate, bounded), reuse },
    { question: stalenessQuestion, input: stateFor(query, candidate, bounded), reuse },
    { question: contradictionQuestion, input: stateFor(query, candidate, bounded), reuse },
  ]);

  const results = await askAll(ctx, items);

  const out: RankedCandidate[] = [];
  for (let i = 0; i < bounded.length; i += 1) {
    const candidate = bounded[i];
    if (candidate === undefined) continue;
    const relevanceResult = results[i * 3] as DecisionResult<number>;
    const stalenessResult = results[i * 3 + 1] as DecisionResult<number>;
    const contradictionResult = results[i * 3 + 2] as DecisionResult<ContradictionVerdict>;
    const relevance = relevanceResult.value;
    const staleness = stalenessResult.value;
    const contradiction = contradictionResult.value;
    out.push({
      candidate,
      relevance,
      staleness,
      contradiction,
      score: combinedScore(relevance, staleness, contradiction),
      relevanceResult,
      stalenessResult,
      contradictionResult,
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

/**
 * Ask for more of the same candidate pool beyond what was already ranked
 * (PLAN §3.B "support shortlist expansion"). `alreadyRanked` is compared by
 * provenance path, so a caller can pass the full original pool and get back
 * only the newly considered slice, ranked exactly like `rankCandidates`.
 */
export async function expandShortlist(
  ctx: AskContext,
  query: string,
  pool: readonly Candidate[],
  alreadyRanked: readonly RankedCandidate[],
  options: RankOptions = {},
): Promise<readonly RankedCandidate[]> {
  const seen = new Set(alreadyRanked.map((r) => r.candidate.provenance.path));
  const remaining = pool.filter((c) => !seen.has(c.provenance.path));
  return rankCandidates(ctx, query, remaining, options);
}
