/**
 * Jev model selection (issue #60; PLAN §3.D "Selection").
 *
 * Ordering (non-negotiable): (1) code computes the eligible set — allowlist,
 * hard constraints, route availability; (2) Jev ranks that set against cards
 * for the task profile; (3) code enforces allowlist/budget/policy on the
 * winner and rejects it if it fails — a Jev answer can never widen what is
 * permitted. No Jev key -> `fallback.staticOrder`. Every selection is
 * recorded as a Decision, visible via requested/used model + reason.
 */
import { askAll, type AskContext, type AskItem } from "../decisions/ask.ts";
import type { DecisionRecorder } from "../decisions/record.ts";
import { modelsRankQuestion, type ModelRankState } from "../decisions/questions/models.ts";
import type { ModelAllowlist, ModelRef } from "../config/types.ts";
import type { FallbackReason, IsoTimestamp, RouteId, TaskProfile } from "../storage/records.ts";
import type { ModelCard } from "./cards.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { RouteAvailabilityTable } from "./availability.ts";

export interface SelectionCandidate {
  readonly ref: ModelRef;
  readonly routeId: RouteId;
  readonly card: ModelCard;
  readonly entry: CatalogEntry;
}

/**
 * Code-only eligible set: `entries` is already `catalog ∩ allowlist`
 * (#56); this adds the route-availability filter from #62/#125 — a route
 * with an uncleared cap is not eligible, regardless of any Jev opinion.
 * A catalog entry with no card at all is skipped (there is nothing for Jev
 * to rank it against); an unrated card (from `mergeCards`) still passes
 * through, since "unrated" is itself a valid, honest signal for Jev.
 */
export function eligibleCandidates(
  entries: readonly CatalogEntry[],
  cards: ReadonlyMap<ModelRef, ModelCard>,
  availability: RouteAvailabilityTable,
  now: IsoTimestamp,
): readonly SelectionCandidate[] {
  const out: SelectionCandidate[] = [];
  for (const entry of entries) {
    if (!availability.isEligible(entry.routeId, now)) continue;
    const card = cards.get(entry.id);
    if (card === undefined) continue;
    out.push({ ref: entry.id, routeId: entry.routeId, card, entry });
  }
  return out;
}

export interface RankedCandidate {
  readonly candidate: SelectionCandidate;
  readonly adequate: boolean;
  readonly source: "jev" | "fallback";
  readonly decisionId: string | null;
}

export interface RankResult {
  readonly ranked: readonly RankedCandidate[];
  readonly allFellBack: boolean;
}

function profileSummary(profile: TaskProfile): ModelRankState["profile"] {
  return {
    domain: profile.domain,
    modalities: profile.modalities,
    reasoningDepth: profile.reasoningDepth,
    contextSize: profile.contextSize,
    risk: profile.risk,
  };
}

function cardSummary(card: ModelCard): ModelRankState["candidate"] {
  return {
    ref: card.id,
    aptitudes: card.aptitudes.map((a) => a.tag),
    notes: card.notes ?? null,
    rated: card.rated,
  };
}

/**
 * Ask `models.rank@1` once per eligible candidate (never one question
 * listing every candidate — see the module doc for why), and rank in code:
 * Jev-adequate candidates first, in the order asked; every candidate that
 * fell back is reported so callers can tell "Jev said no" from "Jev never
 * answered". Does not itself decide anything about allowlist or budget —
 * that is `enforcePolicy`.
 */
export async function rankWithJev(
  ctx: AskContext,
  profile: TaskProfile,
  candidates: readonly SelectionCandidate[],
): Promise<RankResult> {
  const summary = profileSummary(profile);
  const items: AskItem<ModelRankState, boolean>[] = candidates.map((candidate) => ({
    question: modelsRankQuestion,
    input: { profile: summary, candidate: cardSummary(candidate.card) },
  }));
  const results = await askAll(ctx, items as AskItem<unknown, unknown>[]);
  const ranked: RankedCandidate[] = candidates.map((candidate, i) => {
    const result = results[i];
    const adequate = result !== undefined && (result.value as boolean) === true;
    return {
      candidate,
      adequate,
      source: result?.source ?? "fallback",
      decisionId: result?.decisionId ?? null,
    };
  });
  const allFellBack = ranked.every((r) => r.source === "fallback");
  return { ranked, allFellBack };
}

export type PolicyRejection = "not_in_allowlist" | "budget_unavailable" | "not_eligible";

export interface PolicyCheck {
  readonly ok: boolean;
  readonly reason: PolicyRejection | null;
}

export function enforcePolicy(
  ref: ModelRef,
  eligible: ReadonlySet<ModelRef>,
  allowlist: ModelAllowlist,
  checkBudget?: (ref: ModelRef) => boolean,
): PolicyCheck {
  throw new Error("todo");
}

export interface SelectModelParams {
  readonly ctx: AskContext | null;
  readonly profile: TaskProfile;
  readonly candidates: readonly SelectionCandidate[];
  readonly allowlist: ModelAllowlist;
  readonly staticOrder: readonly ModelRef[];
  readonly checkBudget?: (ref: ModelRef) => boolean;
  readonly recorder?: DecisionRecorder;
}

export type SelectionResult =
  | {
      readonly kind: "selected";
      readonly requestedModel: ModelRef;
      readonly usedModel: ModelRef;
      readonly fallbackReason: FallbackReason | null;
      readonly rationale: string;
      readonly decisionId: string | null;
    }
  | { readonly kind: "none"; readonly reason: "inadequate" | "insufficient_info"; readonly decisionId: string | null };

export async function selectModel(params: SelectModelParams): Promise<SelectionResult> {
  throw new Error("todo");
}
