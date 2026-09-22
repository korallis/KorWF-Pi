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

// ---------------------------------------------------------------------------
// the detector
// ---------------------------------------------------------------------------

/** Signature of one identical failure: which check, failing the same way. */
export function failureSignatureKey(check: CheckObservation): string {
  return `${check.checkId}::${check.failureSignature ?? check.status}`;
}

/** What the detector carries between attempts. Serialisable; no clock, no I/O. */
export interface StallState {
  readonly failureCounts: Readonly<Record<string, readonly string[]>>;
  readonly approachCounts: Readonly<Record<string, readonly string[]>>;
  readonly noProgressStreak: readonly string[];
  readonly lastAttempt: AttemptObservation | null;
  readonly fired: readonly StallKind[];
}

export const EMPTY_STALL_STATE: StallState = Object.freeze({
  failureCounts: Object.freeze({}),
  approachCounts: Object.freeze({}),
  noProgressStreak: Object.freeze([]),
  lastAttempt: null,
  fired: Object.freeze([]),
});

/** Result of folding one attempt into the detector. */
export interface StallUpdate {
  readonly state: StallState;
  readonly events: readonly StallEvent[];
}

/**
 * Fold one attempt into the stall state (AC2).
 *
 * Each stall kind fires **once** per task per state: a stall event asks for a
 * recovery decision, and re-raising it on every subsequent attempt would
 * drown the decision it is asking for. `fired` records which have gone off.
 *
 * Harness failures (#124) never contribute to `repeated_failure` or to the
 * no-progress streak — a truncated turn is a turn the worker never took.
 */
export function observeAttempt(
  state: StallState,
  attempt: AttemptObservation,
  options: {
    readonly ownership?: Ownership;
    readonly thresholds?: Partial<StallThresholds>;
  } = {},
): StallUpdate {
  const thresholds = resolveStallThresholds(options.thresholds);
  const events: StallEvent[] = [];
  const fired = new Set<StallKind>(state.fired);
  const harness = isHarnessFailure(attempt.failureKind);

  // --- repeated failures -------------------------------------------------
  const failureCounts: Record<string, readonly string[]> = { ...state.failureCounts };
  if (!harness) {
    for (const check of attempt.checks) {
      if (check.status === "pass") continue;
      const key = failureSignatureKey(check);
      const seen = [...(failureCounts[key] ?? []), attempt.attemptId];
      failureCounts[key] = Object.freeze(seen);
      if (seen.length >= thresholds.repeatedFailures && !fired.has("repeated_failure")) {
        fired.add("repeated_failure");
        events.push(
          Object.freeze({
            kind: "repeated_failure" as const,
            taskId: attempt.taskId,
            attemptId: attempt.attemptId,
            count: seen.length,
            threshold: thresholds.repeatedFailures,
            detail: `Check ${check.checkId} failed identically ${seen.length} times (signature ${check.failureSignature ?? check.status}).`,
            attemptIds: Object.freeze([...seen]),
          }),
        );
      }
    }
  }

  // --- repeated approaches ----------------------------------------------
  const approachCounts: Record<string, readonly string[]> = { ...state.approachCounts };
  if (attempt.approachFingerprint !== null && attempt.approachFingerprint !== "") {
    const key = attempt.approachFingerprint;
    const seen = [...(approachCounts[key] ?? []), attempt.attemptId];
    approachCounts[key] = Object.freeze(seen);
    if (seen.length >= thresholds.repeatedApproaches && !fired.has("repeated_approach")) {
      fired.add("repeated_approach");
      events.push(
        Object.freeze({
          kind: "repeated_approach" as const,
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          count: seen.length,
          threshold: thresholds.repeatedApproaches,
          detail: `${seen.length} attempts produced the same approach fingerprint ${key}.`,
          attemptIds: Object.freeze([...seen]),
        }),
      );
    }
  }

  // --- no measurable progress -------------------------------------------
  const progress = attemptMadeProgress(attempt, state.lastAttempt);
  const churned = attempt.filesChanged === 0 && attempt.toolCalls >= thresholds.toolCallsWithoutChange;
  let noProgressStreak: readonly string[] = progress.progressed || harness
    ? Object.freeze([])
    : Object.freeze([...state.noProgressStreak, attempt.attemptId]);
  if (
    !fired.has("no_progress") &&
    (noProgressStreak.length >= thresholds.noProgressAttempts || (churned && !harness))
  ) {
    fired.add("no_progress");
    const byChurn = noProgressStreak.length < thresholds.noProgressAttempts;
    events.push(
      Object.freeze({
        kind: "no_progress" as const,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        count: byChurn ? attempt.toolCalls : noProgressStreak.length,
        threshold: byChurn ? thresholds.toolCallsWithoutChange : thresholds.noProgressAttempts,
        detail: byChurn
          ? `${attempt.toolCalls} tool calls in one attempt changed no file.`
          : `${noProgressStreak.length} consecutive attempts made no measurable progress. ${progress.reason}`,
        attemptIds: Object.freeze([...noProgressStreak, ...(byChurn ? [attempt.attemptId] : [])].filter(
          (id, index, all) => all.indexOf(id) === index,
        )),
      }),
    );
    if (byChurn) noProgressStreak = Object.freeze([...noProgressStreak, attempt.attemptId]);
  }

  // --- scope drift -------------------------------------------------------
  if (options.ownership !== undefined) {
    const drifted = driftingWrites(attempt, options.ownership);
    if (drifted.length > 0 && !fired.has("scope_drift")) {
      fired.add("scope_drift");
      events.push(
        Object.freeze({
          kind: "scope_drift" as const,
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          count: drifted.length,
          threshold: 1,
          detail:
            `Wrote outside the task's declared ownership: ` +
            `${drifted.map((w) => `${w.kind} ${w.path}`).join(", ")}. ` +
            `This is the write_outside_ownership approval class (#15).`,
          attemptIds: Object.freeze([attempt.attemptId]),
        }),
      );
    }
  }

  return {
    state: Object.freeze({
      failureCounts: Object.freeze(failureCounts),
      approachCounts: Object.freeze(approachCounts),
      noProgressStreak,
      lastAttempt: attempt,
      fired: Object.freeze([...fired]),
    }),
    events: Object.freeze(events),
  };
}

/** Fold a whole attempt stream, returning every event in order. */
export function detectStalls(
  attempts: readonly AttemptObservation[],
  options: { readonly ownership?: Ownership; readonly thresholds?: Partial<StallThresholds> } = {},
): { readonly state: StallState; readonly events: readonly StallEvent[] } {
  let state = EMPTY_STALL_STATE;
  const events: StallEvent[] = [];
  for (const attempt of attempts) {
    const update = observeAttempt(state, attempt, options);
    state = update.state;
    events.push(...update.events);
  }
  return { state, events: Object.freeze(events) };
}
