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

/** `allowlist.providers`/`.models` re-check, same rule as `catalog.ts` (never re-widened here). */
function inAllowlist(ref: ModelRef, allowlist: ModelAllowlist): boolean {
  const slash = ref.indexOf("/");
  const provider = slash === -1 ? ref : ref.slice(0, slash);
  const providerOk = allowlist.providers.length === 0 || allowlist.providers.includes(provider);
  const modelOk = allowlist.models.length === 0 || allowlist.models.includes(ref);
  return providerOk && modelOk;
}

/**
 * Defence in depth (PLAN §3.D "Selection"): re-checks a winner — whether it
 * came from Jev, the static order, or anywhere else — against the allowlist,
 * the eligible set computed by code, and the budget. A Jev answer naming a
 * model outside the allowlist, or outside the eligible set entirely (an id
 * Jev invented or misremembered), is rejected here regardless of what Jev
 * said. This function can only narrow; it never has a path that grants
 * something the caller did not already establish as eligible.
 */
export function enforcePolicy(
  ref: ModelRef,
  eligible: ReadonlySet<ModelRef>,
  allowlist: ModelAllowlist,
  checkBudget?: (ref: ModelRef) => boolean,
): PolicyCheck {
  if (!inAllowlist(ref, allowlist)) return { ok: false, reason: "not_in_allowlist" };
  if (!eligible.has(ref)) return { ok: false, reason: "not_eligible" };
  if (checkBudget !== undefined && !checkBudget(ref)) return { ok: false, reason: "budget_unavailable" };
  return { ok: true, reason: null };
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

/** Order candidates by `staticOrder` position (present entries first, in that order), then input order. */
function orderByStatic(
  candidates: readonly SelectionCandidate[],
  staticOrder: readonly ModelRef[],
): readonly SelectionCandidate[] {
  const position = new Map<ModelRef, number>();
  staticOrder.forEach((ref, i) => {
    if (!position.has(ref)) position.set(ref, i);
  });
  const pinned: SelectionCandidate[] = [];
  const rest: SelectionCandidate[] = [];
  for (const c of candidates) (position.has(c.ref) ? pinned : rest).push(c);
  pinned.sort((a, b) => position.get(a.ref)! - position.get(b.ref)!);
  return [...pinned, ...rest];
}

function recordStatic(recorder: DecisionRecorder | undefined, ref: ModelRef): string | null {
  if (recorder === undefined) return null;
  return recorder.record({
    stateHash: `static:${ref}`,
    questionId: "models.rank",
    questionVersion: "1",
    jevModelVersion: null,
    rawDistribution: {},
    confidence: null,
    policyRule: "static",
    action: ref,
    latencyMs: null,
    usage: { inputTokens: 0, outputTokens: 0, requests: 0, spendUsd: 0, costBasis: "known" },
  }).id;
}

function recordPolicyRejection(recorder: DecisionRecorder | undefined, ref: ModelRef, reason: PolicyRejection): void {
  if (recorder === undefined) return;
  recorder.record({
    stateHash: `policy_reject:${ref}`,
    questionId: "models.rank",
    questionVersion: "1",
    jevModelVersion: null,
    rawDistribution: {},
    confidence: null,
    policyRule: `policy_rejected:${reason}`,
    action: ref,
    latencyMs: null,
    usage: { inputTokens: 0, outputTokens: 0, requests: 0, spendUsd: 0, costBasis: "known" },
  });
}

/**
 * Pick the first candidate (in `order`) that also passes `enforcePolicy`,
 * auditing every rejection along the way. Shared by the static-order path
 * and the Jev-adequate path: both are "walk a ranked list, enforce policy,
 * move on" — the only difference is how the list was ranked.
 */
function firstPolicyPassing(
  order: readonly SelectionCandidate[],
  eligible: ReadonlySet<ModelRef>,
  allowlist: ModelAllowlist,
  checkBudget: ((ref: ModelRef) => boolean) | undefined,
  recorder: DecisionRecorder | undefined,
): SelectionCandidate | null {
  for (const candidate of order) {
    const check = enforcePolicy(candidate.ref, eligible, allowlist, checkBudget);
    if (check.ok) return candidate;
    recordPolicyRejection(recorder, candidate.ref, check.reason!);
  }
  return null;
}

/**
 * Compose the three steps (PLAN §3.D "Selection", non-negotiable order):
 * 1. `params.candidates` is the eligible set (already computed by the
 *    caller via `eligibleCandidates`).
 * 2. No Jev context (`ctx === null`) or every Jev answer fell back →
 *    `fallback.staticOrder`, recorded with `policyRule: "static"` (works
 *    with no Jev key at all).
 * 3. Otherwise, ask `models.rank@1` per candidate and walk the
 *    Jev-adequate ones in the order Jev was asked; every winner —
 *    Jev's or the static order's — is re-checked by `enforcePolicy`
 *    before it is accepted, so a Jev answer naming a model outside the
 *    allowlist is rejected and audited, never honoured.
 * Jev explicitly finding nothing adequate ("none adequate" for a hard
 * task) returns `{ kind: "none", reason: "inadequate" }` — a pause, never a
 * silent degrade.
 */
export async function selectModel(params: SelectModelParams): Promise<SelectionResult> {
  const { profile, candidates, allowlist, staticOrder, checkBudget, recorder } = params;
  const eligible = new Set(candidates.map((c) => c.ref));

  const runStatic = (): SelectionResult => {
    const ordered = orderByStatic(candidates, staticOrder);
    const requested = ordered[0];
    if (requested === undefined) {
      return { kind: "none", reason: "insufficient_info", decisionId: null };
    }
    const used = firstPolicyPassing(ordered, eligible, allowlist, checkBudget, recorder);
    if (used === null) {
      return { kind: "none", reason: "insufficient_info", decisionId: null };
    }
    const decisionId = recordStatic(recorder, used.ref);
    return {
      kind: "selected",
      requestedModel: requested.ref,
      usedModel: used.ref,
      fallbackReason: used.ref === requested.ref ? null : "static_fallback_order",
      rationale: "jev disabled or unavailable; used fallback.staticOrder",
      decisionId,
    };
  };

  if (params.ctx === null || candidates.length === 0) {
    return runStatic();
  }

  const rankResult = await rankWithJev(params.ctx, profile, candidates);
  if (rankResult.allFellBack) {
    return runStatic();
  }

  const adequate = rankResult.ranked.filter((r) => r.adequate);
  if (adequate.length === 0) {
    return { kind: "none", reason: "inadequate", decisionId: null };
  }

  const requested = adequate[0]!.candidate;
  const orderedAdequate = adequate.map((r) => r.candidate);
  const used = firstPolicyPassing(orderedAdequate, eligible, allowlist, checkBudget, recorder);
  if (used === null) {
    return { kind: "none", reason: "inadequate", decisionId: adequate[0]!.decisionId };
  }
  const winner = adequate.find((r) => r.candidate.ref === used.ref)!;
  return {
    kind: "selected",
    requestedModel: requested.ref,
    usedModel: used.ref,
    fallbackReason: used.ref === requested.ref ? null : "jev_selected_substitute",
    rationale: `jev ranked ${used.ref} adequate for profile domain=${profile.domain}`,
    decisionId: winner.decisionId,
  };
}
