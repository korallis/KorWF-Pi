/**
 * Fallback ranking on a cap (issue #63; PLAN §3.D "Caps and fallback").
 * Extended by #65 with the task-boundary-scoped recovery policies.
 *
 * On a cap, code filters the pre-cap eligible set down to still-available
 * routes and `selectModel` (#60) re-ranks it for the task profile — Jev when
 * enabled, `fallback.staticOrder` when not. This module adds the policies
 * `selectModel` does not know about because they are specific to a cap
 * event, not to ordinary dispatch:
 *   - anti-oscillation dwell (do not re-rank every turn once on a fallback);
 *     `atTaskBoundary` (#65) is the only thing that ever lapses a
 *     `remainder_of_task` dwell — a mid-task call always holds it, so the
 *     primary is never re-probed except at a task boundary (PLAN §3.D
 *     "Recovery: ... do not re-probe every task").
 *   - all-candidates-capped / no-adequate-substitute → pause, not a failure
 *   - prefer-wait-if-reset-within-N-minutes vs switching to a substitute
 *   - a pinned model that is capped is never silently substituted (#61)
 *   - the recorded `fallbackReason` is the cap kind that caused the switch,
 *     not the generic `jev_selected_substitute`/`static_fallback_order`
 *     `selectModel` uses for ordinary dispatch (see scenario 04 step A4);
 *     recovery back to the primary records `fallbackReason: null` (#65),
 *     since the fallback has ended, not begun.
 *   - primary preference (#65): at a task boundary once the primary clears,
 *     it is ranked ahead of other still-eligible candidates rather than
 *     left to accidental input order, satisfying "prefer it again at the
 *     next boundary" without ever overriding an inadequate/policy-rejected
 *     primary.
 */
import type { AskContext } from "../decisions/ask.ts";
import type { DecisionRecorder } from "../decisions/record.ts";
import { selectModel, type SelectionCandidate } from "./select.ts";
import { RouteAvailabilityTable } from "./availability.ts";
import type { ModelAllowlist, DwellPolicy, ModelRef } from "../config/types.ts";
import type { CapKind, FallbackReason, IsoTimestamp, RouteId, TaskProfile } from "../storage/records.ts";

export interface FallbackAttemptView {
  readonly requestedModel: ModelRef;
  readonly usedModel: ModelRef;
  readonly taskProfile: TaskProfile;
  readonly pin: ModelRef | null;
  /** When the current fallback began; `null` when `usedModel === requestedModel`. */
  readonly fallbackSince: IsoTimestamp | null;
}

export type FallbackPauseReason = "all_capped" | "no_adequate" | "pin_capped" | "prefer_wait";

export type FallbackDecision =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "switch";
      readonly requestedModel: ModelRef;
      readonly usedModel: ModelRef;
      /** `null` when the switch recovers to the primary (`usedModel === requestedModel`). */
      readonly fallbackReason: FallbackReason | null;
      readonly rationale: string;
      readonly decisionId: string | null;
    }
  | {
      readonly kind: "pause";
      readonly reason: FallbackPauseReason;
      readonly earliestReset: IsoTimestamp | null;
      readonly blocker: string;
      readonly watchRoutes: readonly RouteId[];
    };

export interface ChooseFallbackParams {
  readonly ctx: AskContext | null;
  readonly attempt: FallbackAttemptView;
  /** Pre-cap eligible set for the task profile (allowlist/hard-constraint filtered, not availability-filtered). */
  readonly candidates: readonly SelectionCandidate[];
  readonly availability: RouteAvailabilityTable;
  readonly now: IsoTimestamp;
  readonly allowlist: ModelAllowlist;
  readonly staticOrder: readonly ModelRef[];
  readonly dwell: DwellPolicy;
  readonly dwellMinutes: number;
  readonly preferWaitIfResetWithinMinutes: number;
  readonly checkBudget?: (ref: ModelRef) => boolean;
  /** Optional relative-cost comparator; `null` = unknown. When omitted, prefer-wait applies conservatively. */
  readonly costOf?: (ref: ModelRef) => number | null;
  readonly recorder?: DecisionRecorder;
  /**
   * Is this call happening at a task boundary (task start), or mid-task
   * (#65; PLAN §3.D "Recovery")? Defaults to `false` (mid-task), matching
   * prior behaviour: a `remainder_of_task` dwell holds for the whole task
   * and only lapses when a boundary call says the task is over. `minutes`
   * dwell is judged by elapsed time regardless of this flag. A cap on the
   * *currently used* model is not a probe, it is an active failure, and is
   * always handled regardless of this flag.
   */
  readonly atTaskBoundary?: boolean;
}

export function fallbackReasonFromCap(capKind: CapKind): FallbackReason | null {
  switch (capKind) {
    case "quota_exhausted":
      return "quota_exhausted";
    case "rate_limited":
      return "rate_limited";
    case "budget_cap":
      return "budget_cap";
    case "unavailable":
      return "model_unavailable";
    default:
      return null;
  }
}

/**
 * Is the current fallback still within its minimum dwell (PLAN §3.D
 * "Anti-oscillation")? `atTaskBoundary` (#65) distinguishes a mid-task
 * check, where the dwell always holds, from a task-boundary check, where a
 * `remainder_of_task` dwell has by definition just elapsed — the task it
 * covered is over. `remainder_of_phase` outlives task boundaries (it needs
 * an explicit phase boundary, out of #65's scope) and `minutes` is judged
 * purely on elapsed wall-clock time either way.
 */
export function inDwell(
  attempt: FallbackAttemptView,
  config: { readonly dwell: DwellPolicy; readonly dwellMinutes: number },
  now: IsoTimestamp,
  atTaskBoundary = false,
): boolean {
  if (attempt.fallbackSince === null) return false;
  if (config.dwell === "minutes") {
    const until = Date.parse(attempt.fallbackSince) + config.dwellMinutes * 60_000;
    return Date.parse(now) < until;
  }
  if (config.dwell === "remainder_of_task") return !atTaskBoundary;
  // remainder_of_phase: outlives task boundaries; only a phase boundary
  // (out of #65's scope) clears it.
  return true;
}

export function earliestResetAmong(
  candidates: readonly SelectionCandidate[],
  availability: RouteAvailabilityTable,
): IsoTimestamp | null {
  let earliest: IsoTimestamp | null = null;
  for (const c of candidates) {
    const reset = availability.get(c.routeId)?.estimatedReset ?? null;
    if (reset !== null && (earliest === null || reset < earliest)) earliest = reset;
  }
  return earliest;
}

export function isResumable(
  watchRoutes: readonly RouteId[],
  availability: RouteAvailabilityTable,
  now: IsoTimestamp,
): boolean {
  return watchRoutes.some((routeId) => availability.isEligible(routeId, now));
}

/**
 * Decide what happens to a task/attempt after a cap fires (PLAN §3.D).
 * Order: (1) a pin never gets overridden — capped pin pauses and asks;
 * (2) anti-oscillation dwell holds the current fallback as long as it is
 * still eligible; (3) an empty available set pauses `all_capped`;
 * (4) prefer-wait pauses rather than paying for a substitute when the
 * primary's reset is imminent; (5) otherwise `selectModel` re-ranks the
 * still-available candidates (Jev, or `fallback.staticOrder` with no Jev)
 * and a `none` result becomes `no_adequate` (Jev said no) or `all_capped`
 * (nothing passed policy) rather than ever degrading silently.
 */
export async function chooseFallback(params: ChooseFallbackParams): Promise<FallbackDecision> {
  const { attempt, candidates, availability, now } = params;

  // (1) Pinned model: never overridden by fallback without asking (#61).
  if (attempt.pin !== null) {
    const pinned = candidates.find((c) => c.ref === attempt.pin);
    const pinRouteId = pinned?.routeId;
    const pinEligible = pinRouteId !== undefined && availability.isEligible(pinRouteId, now);
    if (!pinEligible) {
      return {
        kind: "pause",
        reason: "pin_capped",
        earliestReset: pinRouteId !== undefined ? (availability.get(pinRouteId)?.estimatedReset ?? null) : null,
        blocker: "pinned model is capped; ask before any substitute (#61)",
        watchRoutes: pinRouteId !== undefined ? [pinRouteId] : [],
      };
    }
    // Pin is still eligible: nothing for fallback to do (selection already
    // honours the pin ahead of any ranking).
    return { kind: "unchanged" };
  }

  // (2) Anti-oscillation: hold the dwell as long as the current model is
  // still eligible — do not flap back to a reopened primary mid-dwell.
  // A cap on the *currently used* model always forces a re-rank; dwell
  // never traps a task on a route that stopped answering.
  const usedCandidate = candidates.find((c) => c.ref === attempt.usedModel);
  const usedStillEligible = usedCandidate !== undefined && availability.isEligible(usedCandidate.routeId, now);
  if (usedStillEligible && inDwell(attempt, params, now, params.atTaskBoundary ?? false)) {
    return { kind: "unchanged" };
  }

  const available = candidates.filter((c) => availability.isEligible(c.routeId, now));

  // (3) All candidates capped: pause the phase, not a failure.
  if (available.length === 0) {
    return {
      kind: "pause",
      reason: "all_capped",
      earliestReset: earliestResetAmong(candidates, availability),
      blocker: "all eligible candidates for this task profile are capped",
      watchRoutes: candidates.map((c) => c.routeId),
    };
  }

  // (4) Prefer-wait: if the primary's reset is imminent and switching would
  // cost more (or cost is unknown, applied conservatively), wait instead.
  const requestedCandidate = candidates.find((c) => c.ref === attempt.requestedModel);
  if (requestedCandidate !== undefined && params.preferWaitIfResetWithinMinutes > 0) {
    const reset = availability.get(requestedCandidate.routeId)?.estimatedReset ?? null;
    if (reset !== null) {
      const minutesUntil = (Date.parse(reset) - Date.parse(now)) / 60_000;
      if (minutesUntil >= 0 && minutesUntil <= params.preferWaitIfResetWithinMinutes) {
        const substituteMoreExpensive =
          params.costOf === undefined
            ? true
            : (() => {
                const substituteCost = params.costOf!(available[0]!.ref);
                const requestedCost = params.costOf!(requestedCandidate.ref);
                return substituteCost === null || requestedCost === null || substituteCost > requestedCost;
              })();
        if (substituteMoreExpensive) {
          return {
            kind: "pause",
            reason: "prefer_wait",
            earliestReset: reset,
            blocker: `primary resets in ~${minutesUntil.toFixed(1)}m, within preferWaitIfResetWithinMinutes; waiting instead of switching`,
            watchRoutes: [requestedCandidate.routeId],
          };
        }
      }
    }
  }

  // (5) Re-rank the still-available candidates for the same task profile.
  // Primary preference (#65): at a task boundary, once the primary has
  // cleared it is a candidate again like any other, but the recovery rule
  // ("retry the primary at the next task boundary") means it gets first
  // look, not just an equal vote — so it is moved to the front of the set
  // handed to selection. This never *forces* the primary (an inadequate or
  // policy-rejected primary still falls through to the next candidate); it
  // only breaks a tie in the primary's favour instead of leaving candidate
  // order to be an accident of caller iteration.
  const rankedForBoundary =
    params.atTaskBoundary === true
      ? [...available].sort((a, b) => (a.ref === attempt.requestedModel ? -1 : b.ref === attempt.requestedModel ? 1 : 0))
      : available;
  const result = await selectModel({
    ctx: params.ctx,
    profile: attempt.taskProfile,
    candidates: rankedForBoundary,
    allowlist: params.allowlist,
    staticOrder: params.staticOrder,
    pin: null,
    ...(params.checkBudget !== undefined ? { checkBudget: params.checkBudget } : {}),
    ...(params.recorder !== undefined ? { recorder: params.recorder } : {}),
  });

  if (result.kind === "pin_blocked") {
    // Unreachable: `pin: null` above means `selectModel` never returns this.
    return {
      kind: "pause",
      reason: "all_capped",
      earliestReset: earliestResetAmong(candidates, availability),
      blocker: "internal: unexpected pin_blocked from selectModel with no pin",
      watchRoutes: candidates.map((c) => c.routeId),
    };
  }

  if (result.kind === "none") {
    return {
      kind: "pause",
      reason: result.reason === "inadequate" ? "no_adequate" : "all_capped",
      earliestReset: earliestResetAmong(candidates, availability),
      blocker:
        result.reason === "inadequate"
          ? "Jev found no adequate substitute for this task profile"
          : "no available candidate passed allowlist/budget policy",
      watchRoutes: candidates.map((c) => c.routeId),
    };
  }

  if (result.usedModel === attempt.usedModel) {
    // The re-rank landed on the same model already in use — nothing
    // actually changed, even though a re-rank happened (e.g. a task
    // boundary re-ranked and confirmed the current substitute is still
    // the best choice). Not a switch: the Attempt is untouched.
    return { kind: "unchanged" };
  }

  if (result.usedModel === attempt.requestedModel) {
    // Recovery to primary (#65 "Recovery"): the primary cleared and was
    // re-ranked back to the top. This is a real switch, not a no-op — the
    // Attempt must show the fallback ending, so `fallbackReason` is `null`.
    return {
      kind: "switch",
      requestedModel: attempt.requestedModel,
      usedModel: result.usedModel,
      fallbackReason: null,
      rationale: result.rationale,
      decisionId: result.decisionId,
    };
  }

  const capKind = availability.get(requestedCandidate?.routeId ?? ("" as RouteId))?.capKind ?? null;
  const fallbackReason = (capKind !== null ? fallbackReasonFromCap(capKind) : null) ?? "model_unavailable";

  return {
    kind: "switch",
    requestedModel: attempt.requestedModel,
    usedModel: result.usedModel,
    fallbackReason,
    rationale: result.rationale,
    decisionId: result.decisionId,
  };
}
