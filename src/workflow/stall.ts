/**
 * Stall and scope-drift detection (issue #52; PLAN §3.G).
 *
 * PLAN §3.G names four signals: **repeated approaches**, **repeated
 * failures**, **scope drift**, and **no measurable progress**. This module
 * watches the Attempt/Evidence stream and emits a typed event for each, with
 * thresholds supplied by configuration rather than baked in.
 *
 * Three rules this module holds to:
 *
 *  1. **A harness failure is not a stall.** `src/workers/truncation.ts`
 *     (#124) classifies a turn cut off at the output-token ceiling as a
 *     harness failure that does not consume the attempt budget. Three
 *     truncated turns are three turns the worker never got to take, so they
 *     are counted separately and never raise `repeated_failure`. Counting
 *     them was the #14/#11 defect.
 *  2. **A check that cannot fail is not progress.** Whether a check is real
 *     verification is `isVerifyingCheck` (#44) and nothing else; this module
 *     never defines a second notion of "real check". A run of non-verifying
 *     checks passing is explicitly *not* measurable progress.
 *  3. **Drift is structural.** A write outside the task's declared ownership
 *     is drift by observation, not by judgement — it maps to the existing
 *     `write_outside_ownership` approval class (#15).
 *
 * Pure module: no I/O, no clock (timestamps are supplied by the caller).
 */
import type { Ownership } from "../storage/records.ts";
import { isVerifyingCheck, type CheckLike } from "./weak-checks.ts";
import type { AttemptFailureKind } from "../workers/truncation.ts";
import { isHarnessFailure } from "../workers/truncation.ts";

// ---------------------------------------------------------------------------
// thresholds
// ---------------------------------------------------------------------------

/** Stall thresholds. `N` in "stall fires after N identical failures" is `repeatedFailures`. */
export interface StallThresholds {
  /** Identical failures (same check, same signature) before `repeated_failure`. */
  readonly repeatedFailures: number;
  /** Attempts sharing a diff/approach fingerprint before `repeated_approach`. */
  readonly repeatedApproaches: number;
  /** Consecutive attempts with no measurable progress before `no_progress`. */
  readonly noProgressAttempts: number;
  /** Tool calls within one attempt with no file change before `no_progress`. */
  readonly toolCallsWithoutChange: number;
}

/** Shipped defaults. Deliberately small: a stall event asks for a decision, it does not stop work. */
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = Object.freeze({
  repeatedFailures: 3,
  repeatedApproaches: 2,
  noProgressAttempts: 2,
  toolCallsWithoutChange: 12,
});

/**
 * Resolve thresholds from a (partial) configuration. Values are clamped to
 * at least 1 and rounded: a threshold of 0 would make every first failure a
 * stall, which is a way of disabling work rather than detecting a stall.
 */
export function resolveStallThresholds(overrides: Partial<StallThresholds> | undefined): StallThresholds {
  const base = DEFAULT_STALL_THRESHOLDS;
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
  return Object.freeze({
    repeatedFailures: pick(overrides?.repeatedFailures, base.repeatedFailures),
    repeatedApproaches: pick(overrides?.repeatedApproaches, base.repeatedApproaches),
    noProgressAttempts: pick(overrides?.noProgressAttempts, base.noProgressAttempts),
    toolCallsWithoutChange: pick(overrides?.toolCallsWithoutChange, base.toolCallsWithoutChange),
  });
}

// ---------------------------------------------------------------------------
// observations
// ---------------------------------------------------------------------------

/** One check result observed within an attempt. */
export interface CheckObservation {
  readonly checkId: string;
  readonly status: "pass" | "fail" | "timeout" | "unavailable" | "flaky" | "missing";
  /** The check definition, so `isVerifyingCheck` (#44) can judge it. */
  readonly check: CheckLike & { readonly required?: boolean };
  /**
   * Stable signature of *how* it failed — normally a hash of the redacted
   * failing output. Two failures are "identical" when check id and signature
   * both match.
   */
  readonly failureSignature?: string | null;
}

/** One file write observed within an attempt, relative to the repository root. */
export interface WriteObservation {
  readonly path: string;
  readonly kind: "create" | "modify" | "delete";
}

/** One attempt, as the stall detector needs to see it. */
export interface AttemptObservation {
  readonly attemptId: string;
  readonly taskId: string;
  /**
   * Fingerprint of the approach taken — normally the hash of the attempt's
   * diff, falling back to a normalised plan summary. Two attempts with the
   * same fingerprint tried the same thing.
   */
  readonly approachFingerprint: string | null;
  /** How the attempt's turn ended (#124). `"none"` means it ended cleanly. */
  readonly failureKind: AttemptFailureKind;
  readonly checks: readonly CheckObservation[];
  readonly writes: readonly WriteObservation[];
  /** Tool calls the worker issued in this attempt. */
  readonly toolCalls: number;
  /** Files changed in this attempt, as counted by `src/git/`. */
  readonly filesChanged: number;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export const STALL_KINDS = ["repeated_failure", "repeated_approach", "no_progress", "scope_drift"] as const;

export type StallKind = (typeof STALL_KINDS)[number];

/** A typed stall event. Advisory: it asks for a decision, it never stops work itself. */
export interface StallEvent {
  readonly kind: StallKind;
  readonly taskId: string;
  /** The attempt at which the threshold was crossed. */
  readonly attemptId: string;
  /** Observed count that crossed the threshold. */
  readonly count: number;
  readonly threshold: number;
  /** Evidence sentence, naming what repeated. */
  readonly detail: string;
  /** Attempts involved, oldest first. */
  readonly attemptIds: readonly string[];
}

// ---------------------------------------------------------------------------
// measurable progress
// ---------------------------------------------------------------------------

/**
 * Did this attempt make measurable progress?
 *
 * Measurable means one of: a file actually changed, or a **verifying** check
 * that was failing now passes. `isVerifyingCheck` (#44) is the only judge of
 * "verifying" — a `true`/`echo ok` check flipping to pass is not evidence of
 * anything, and treating it as progress is how a stalled task looks busy.
 */
export function attemptMadeProgress(
  attempt: AttemptObservation,
  previous: AttemptObservation | null,
): { readonly progressed: boolean; readonly reason: string } {
  if (attempt.filesChanged > 0) {
    return { progressed: true, reason: `${attempt.filesChanged} file(s) changed.` };
  }
  const previouslyFailing = new Set(
    (previous?.checks ?? []).filter((c) => c.status !== "pass").map((c) => c.checkId),
  );
  for (const check of attempt.checks) {
    if (check.status !== "pass") continue;
    if (!previouslyFailing.has(check.checkId)) continue;
    if (!isVerifyingCheck(check.check)) continue;
    return { progressed: true, reason: `Verifying check ${check.checkId} went from failing to passing.` };
  }
  const weakFlips = attempt.checks.filter(
    (c) => c.status === "pass" && previouslyFailing.has(c.checkId) && !isVerifyingCheck(c.check),
  );
  if (weakFlips.length > 0) {
    return {
      progressed: false,
      reason:
        `No file changed; the only check(s) that started passing (${weakFlips.map((c) => c.checkId).join(", ")}) ` +
        `cannot fail, so they are not verification (isVerifyingCheck, #44).`,
    };
  }
  return { progressed: false, reason: "No file changed and no failing verifying check began to pass." };
}

// ---------------------------------------------------------------------------
// ownership / drift
// ---------------------------------------------------------------------------

function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * `true` when `path` falls under one of the ownership entries. An entry is a
 * prefix: `src/workflow/` owns `src/workflow/stall.ts`. `src/workflow` (no
 * slash) owns the directory, not the sibling `src/workflow-extra.ts`.
 */
export function pathInOwnership(path: string, ownership: Ownership): boolean {
  const target = normalisePath(path);
  return ownership.paths.some((raw) => {
    const owned = normalisePath(raw).replace(/\/+$/, "");
    if (owned === "" || owned === ".") return true;
    return target === owned || target.startsWith(`${owned}/`);
  });
}

/** Writes in this attempt that landed outside the task's declared ownership. */
export function driftingWrites(
  attempt: AttemptObservation,
  ownership: Ownership,
): readonly WriteObservation[] {
  return attempt.writes.filter((write) => !pathInOwnership(write.path, ownership));
}
