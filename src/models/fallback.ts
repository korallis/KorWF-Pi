/**
 * Fallback ranking on a cap (issue #63; PLAN §3.D "Caps and fallback").
 *
 * On a cap, code filters the pre-cap eligible set down to still-available
 * routes and `selectModel` (#60) re-ranks it for the task profile — Jev when
 * enabled, `fallback.staticOrder` when not. This module adds the policies
 * `selectModel` does not know about because they are specific to a cap
 * event, not to ordinary dispatch:
 *   - anti-oscillation dwell (do not re-rank every turn once on a fallback)
 *   - all-candidates-capped / no-adequate-substitute → pause, not a failure
 *   - prefer-wait-if-reset-within-N-minutes vs switching to a substitute
 *   - a pinned model that is capped is never silently substituted (#61)
 *   - the recorded `fallbackReason` is the cap kind that caused the switch,
 *     not the generic `jev_selected_substitute`/`static_fallback_order`
 *     `selectModel` uses for ordinary dispatch (see scenario 04 step A4).
 */
import type { AskContext } from "../decisions/ask.ts";
import type { DecisionRecorder } from "../decisions/record.ts";
import { selectModel, type SelectionCandidate } from "./select.ts";
import { RouteAvailabilityTable } from "./availability.ts";
import type { ModelAllowlist, DwellPolicy } from "../config/types.ts";
import type { CapKind, FallbackReason, IsoTimestamp, ModelRef, RouteId, TaskProfile } from "../storage/records.ts";

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
      readonly fallbackReason: FallbackReason;
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

export function inDwell(
  attempt: FallbackAttemptView,
  config: { readonly dwell: DwellPolicy; readonly dwellMinutes: number },
  now: IsoTimestamp,
): boolean {
  if (attempt.fallbackSince === null) return false;
  if (config.dwell === "minutes") {
    const until = Date.parse(attempt.fallbackSince) + config.dwellMinutes * 60_000;
    return Date.parse(now) < until;
  }
  // remainder_of_task / remainder_of_phase: stick for the whole task/phase;
  // retry-at-boundary is #65's concern, not re-evaluated here.
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

export async function chooseFallback(params: ChooseFallbackParams): Promise<FallbackDecision> {
  throw new Error("not implemented");
}
