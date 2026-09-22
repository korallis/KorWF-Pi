/**
 * Truncation detection and classification for worker attempts
 * (issue #124; docs/PRD.md §3.3, PLAN §3.E, §3.G).
 *
 * A worker turn that hits the output-token ceiling stops with
 * `stopReason: "length"` **before emitting its tool call**. Nothing is
 * written, no report is produced, and the attempt looks — to anything that
 * only reads the worker's final text — like a model that stopped early with
 * an unsupported claim. In this repository's own build that misreading cost
 * six attempts on #14 and three on #11 (~400k tokens, zero files written),
 * each presented to the gate as "worker overclaims, criteria unmet", which
 * was the opposite of the truth.
 *
 * So truncation is classified as a **harness** failure, not a quality
 * failure:
 *   - it does not consume the task's attempt budget;
 *   - its feedback describes truncation, never unmet criteria;
 *   - it is bounded by its own separate budget, so a task that truncates
 *     every time surfaces as a distinct failure instead of looping.
 *
 * Pure module: no I/O, no subprocess handling, no clock. The controller in
 * `src/workflow/` calls these functions with what it observed.
 */

/** Stop reasons a worker turn can end with, as reported by Pi's JSON event stream. */
export type WorkerStopReason = "stop" | "length" | "tool_use" | "aborted" | "error" | (string & {});

/** The stop reason that means "cut off at the output-token ceiling". */
export const TRUNCATION_STOP_REASON = "length" as const;

/**
 * How an attempt's end is classified. `harness` means the failure was the
 * execution environment's, not the worker's; `quality` means the worker
 * produced work that did not meet the criteria. The distinction is the whole
 * point of this module: only `quality` may carry "you did not meet the
 * criteria" feedback, and only `quality` consumes the attempt budget.
 */
export type FailureClass = "harness" | "quality" | "none";

/** Why an attempt ended, at the granularity the controller acts on. */
export type AttemptFailureKind =
  | "truncated"
  | "timeout"
  | "transport_error"
  | "capped"
  | "gap"
  | "none";

/**
 * Failure kinds that are the harness's fault. `capped` is a quota fact about
 * the route, handled by #125/#62's fallback path, and is likewise not a
 * judgment about the worker's output.
 */
export const HARNESS_FAILURE_KINDS = [
  "truncated",
  "timeout",
  "transport_error",
  "capped",
] as const satisfies readonly AttemptFailureKind[];

/** What the controller observed about a finished worker turn. */
export interface WorkerTurnObservation {
  /** Stop reason from the last assistant message; `null` when none was reported. */
  readonly stopReason: WorkerStopReason | null;
  /** Process exit code; `null` when the process was killed or never exited. */
  readonly exitCode: number | null;
  /** `true` when the controller killed the worker for exceeding its wall-clock budget. */
  readonly killedForTimeout?: boolean;
  /** Output tokens the turn emitted, when the usage block reported them. */
  readonly outputTokens?: number | null;
  /** The worker's final visible text, used only for its length as evidence. */
  readonly finalText?: string | null;
}

/** Classification of one finished worker turn. */
export interface TurnClassification {
  readonly kind: AttemptFailureKind;
  readonly failureClass: FailureClass;
  /** `true` when this turn consumes one of the task's attempt-budget slots. */
  readonly consumesAttemptBudget: boolean;
  /** `true` when the turn was cut off at the output-token ceiling. */
  readonly truncated: boolean;
  /** Recorded stop reason, preserved verbatim for telemetry (AC2). */
  readonly stopReason: WorkerStopReason | null;
  /** Evidence sentence; never a claim about the worker's quality when harness-classed. */
  readonly reason: string;
}

/**
 * `true` when the turn hit the output-token ceiling. Detection is exactly
 * the recorded `stopReason`: the bootstrap orchestrator proved that guessing
 * from a short final message instead ("Now writing docs/gates.md.") is
 * unreliable, and the stop reason is authoritative.
 */
export function isTruncated(observation: Pick<WorkerTurnObservation, "stopReason">): boolean {
  return observation.stopReason === TRUNCATION_STOP_REASON;
}

/** `true` for failure kinds that are the harness's fault, not the worker's. */
export function isHarnessFailure(kind: AttemptFailureKind): boolean {
  return (HARNESS_FAILURE_KINDS as readonly AttemptFailureKind[]).includes(kind);
}

/**
 * Classify a finished worker turn (AC2, AC3).
 *
 * Order matters: truncation is checked *before* anything that inspects the
 * worker's output, because a truncated turn has no output to judge. Checking
 * "did it produce a report?" first is precisely how six identical #14
 * failures were mislabelled as overclaiming.
 */
export function classifyTurn(observation: WorkerTurnObservation): TurnClassification {
  const stopReason = observation.stopReason ?? null;
  if (isTruncated(observation)) {
    const emitted = observation.outputTokens ?? null;
    return {
      kind: "truncated",
      failureClass: "harness",
      consumesAttemptBudget: false,
      truncated: true,
      stopReason,
      reason:
        `Turn stopped at stopReason="length"` +
        (emitted === null ? "" : ` after emitting ${emitted} output tokens`) +
        `: the output-token ceiling was reached before the tool call was emitted, so nothing ` +
        `was written. This is a harness failure, not a quality failure.`,
    };
  }
  if (observation.killedForTimeout === true) {
    return {
      kind: "timeout",
      failureClass: "harness",
      consumesAttemptBudget: false,
      truncated: false,
      stopReason,
      reason: "Worker exceeded its wall-clock budget and was terminated by the controller.",
    };
  }
  if (observation.exitCode !== null && observation.exitCode !== 0) {
    return {
      kind: "transport_error",
      failureClass: "harness",
      consumesAttemptBudget: false,
      truncated: false,
      stopReason,
      reason: `Worker process exited ${observation.exitCode} without settling its attempt.`,
    };
  }
  return {
    kind: "none",
    failureClass: "none",
    consumesAttemptBudget: true,
    truncated: false,
    stopReason,
    reason: "Turn completed; the task gate decides whether the work meets the criteria.",
  };
}

/**
 * Feedback handed to the next attempt after a truncated turn (AC3).
 *
 * It describes what happened to the *turn* and what to do differently
 * mechanically. It contains no statement about acceptance criteria, because
 * none were assessed: there was no output to assess. Asserted by test.
 */
export const TRUNCATION_FEEDBACK = [
  "Your previous turn was cut off at the output-token limit before its tool call was emitted,",
  "so nothing was written to disk. The criteria were not assessed and nothing is known to be wrong",
  "with your approach. Work in much smaller steps: create each file with a short write, extend it",
  "with successive small edits, commit after each file or major section, and keep replies to one or",
  "two lines — narration spends the same output budget the tool call needs.",
].join(" ");

/** Words that would make truncation feedback read as a quality judgement. */
export const QUALITY_JUDGEMENT_PHRASES = [
  "did not meet",
  "unmet criteri",
  "criteria unmet",
  "overclaim",
  "you failed",
  "incorrect implementation",
] as const;

/** `true` when a feedback string makes no claim about the worker's quality. */
export function isHarnessFeedback(feedback: string): boolean {
  const lower = feedback.toLowerCase();
  return !QUALITY_JUDGEMENT_PHRASES.some((p) => lower.includes(p));
}
