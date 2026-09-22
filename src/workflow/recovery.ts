/**
 * Bounded recovery policies and side-effect reconciliation (issue #53;
 * PLAN §3.G).
 *
 * > Bounded responses: gather evidence, retry, fallback model (D), replan,
 * > change worker/profile, request review, ask user, stop. No blind retry of
 * > side effects; reconcile uncertain outcomes first.
 *
 * Two absolutes, and everything in this module exists to hold them:
 *
 * 1. **Every policy is bounded.** There is no path through `chooseRecovery`
 *    that returns `retry` forever. The ladder for each failure category is a
 *    finite list, each rung has its own cap from config, and the attempt
 *    ceiling is checked *before* the ladder is consulted. An unbounded retry
 *    loop is the failure this issue exists to prevent — six attempts on one
 *    task once burnt ~400k tokens here and produced no files.
 * 2. **No blind retry of side effects.** A step that may have written, pushed
 *    or published is not retried until its outcome is reconciled. The
 *    receipts in `src/storage/action-log.ts` (#42) already refuse a replay;
 *    this module *consults* them rather than re-deriving the idea, and when
 *    there is no receipt and no probe, the outcome is unknown and the
 *    response is terminal.
 *
 * What this module does **not** do:
 *
 * - It does not classify failures. `src/workflow/failure.ts` (#52) is the
 *   taxonomy; a `FailureClassification` is an input here. There is no second
 *   taxonomy.
 * - It does not decide retry bounds for service calls. `src/jev/resilience.ts`
 *   (#26) owns transport retry and the circuit breaker; a `service` failure
 *   that reached this module has already exhausted those.
 * - It does not pick a fallback model (Stage 5, PLAN §3.D) or produce a new
 *   plan (Stage 3). Those responses are returned as *decisions* for the
 *   caller's hooks to execute.
 *
 * `chooseRecovery` is pure: no clock, no I/O, no store. `recoverFromFailure`
 * is the thin shell that reconciles, records the audit row, and returns the
 * same decision.
 */
import type { FailureCategory, FailureClassification } from "./failure.ts";
import type { StallEvent } from "./stall.ts";
import type { RecoveryConfig, TerminalRecoveryResponse } from "../config/types.ts";
import type { Store } from "../storage/db.ts";
import type { RecoverySubjectKind } from "../storage/recovery-log.ts";
import type { IsoTimestamp, WorkflowId } from "../storage/records.ts";

// ---------------------------------------------------------------------------
// the fixed menu
// ---------------------------------------------------------------------------

/** The PLAN §3.G response menu, in escalation order. Nothing else is a response. */
export const RECOVERY_RESPONSES = [
  "gather_evidence",
  "retry",
  "fallback_model",
  "replan",
  "change_worker",
  "request_review",
  "ask_user",
  "stop",
] as const;

export type RecoveryResponse = (typeof RECOVERY_RESPONSES)[number];

/** One-line meaning of each response, used in explanations and the UI. */
export const RECOVERY_RESPONSE_DESCRIPTIONS: Readonly<Record<RecoveryResponse, string>> = Object.freeze({
  gather_evidence: "Run the named observations and classify again; do not change any code yet.",
  retry: "Attempt the same task again, after any required reconciliation.",
  fallback_model: "Re-run on the next eligible model under the fallback policy (PLAN §3.D).",
  replan: "Return the task to planning: its decomposition or its checks are the problem.",
  change_worker: "Re-run with a different worker role or profile.",
  request_review: "Ask for an independent review of the work and the evidence before continuing.",
  ask_user: "Stop automatic recovery and put a concrete question to the user.",
  stop: "Stop this scope, record the state, and make no further attempts.",
});

/** Responses that end recovery for a subject. The ladder always reaches one. */
export const TERMINAL_RESPONSES: readonly RecoveryResponse[] = Object.freeze(["ask_user", "stop"] as const);

/** Is this response terminal? */
export function isTerminalResponse(response: RecoveryResponse): response is TerminalRecoveryResponse {
  return TERMINAL_RESPONSES.includes(response);
}

// ---------------------------------------------------------------------------
// the ladders: failure category × attempt number → response
// ---------------------------------------------------------------------------

/**
 * The escalation ladder for each failure category.
 *
 * Read it as "attempt 1 gets `ladder[0]`, attempt 2 gets `ladder[1]`, …";
 * running off the end is the terminal response. The lists are deliberately
 * short — the point of a ladder is that it has a top.
 *
 * The ordering rationale per category:
 *
 * - `implementation` — the code is wrong and the worker can see the failure,
 *   so one plain retry is worth it; then a different model, then a review.
 * - `environment` — retrying an `ENOENT` changes nothing, so evidence first
 *   (which command, which path), then the user, who owns the machine.
 * - `missing_information` — nobody supplied the information; no amount of
 *   retrying invents it. Ask, immediately.
 * - `dependency` — an unbuilt prerequisite may have completed since; one
 *   retry, then replan so the dependency becomes an explicit task.
 * - `test_expectation` — the test asserts the wrong thing. That is a planning
 *   defect (the check was registered), so replan, then review. Never a plain
 *   retry: re-running a wrong assertion produces the same wrong assertion.
 * - `service` — #26 already retried and tripped the breaker, so this module
 *   does not retry the same route; it changes route, then stops.
 * - `quota` — a cap is time-based. Changing route is the only useful local
 *   move; the pause/resume policy is `fallback.allCappedBehaviour`.
 * - `harness` — the turn never happened (#124). One retry of the *harness*
 *   is legitimate, then a smaller worker profile, then ask.
 * - `unknown` — never acted on as a diagnosis: gather the evidence the
 *   classification asked for, then ask.
 */
export const RECOVERY_LADDERS: Readonly<Record<FailureCategory, readonly RecoveryResponse[]>> = Object.freeze({
  implementation: Object.freeze(["retry", "fallback_model", "request_review"] as const),
  environment: Object.freeze(["gather_evidence"] as const),
  missing_information: Object.freeze([] as const),
  dependency: Object.freeze(["retry", "replan"] as const),
  test_expectation: Object.freeze(["replan", "request_review"] as const),
  service: Object.freeze(["fallback_model"] as const),
  quota: Object.freeze(["fallback_model"] as const),
  harness: Object.freeze(["retry", "change_worker"] as const),
  unknown: Object.freeze(["gather_evidence"] as const),
});

/** Which config cap bounds how often a response may be chosen for one subject. */
const RESPONSE_CAP_KEY: Readonly<Partial<Record<RecoveryResponse, keyof RecoveryConfig>>> = Object.freeze({
  gather_evidence: "maxEvidenceGatherings",
  replan: "maxReplans",
  fallback_model: "maxModelFallbacks",
  change_worker: "maxWorkerChanges",
});

/**
 * How often each non-terminal response has already been used on this subject.
 * Anything absent is zero. Supplied by the caller from the recovery log, so
 * the bound survives a resumed or forked session.
 */
export type ResponseUsage = Readonly<Partial<Record<RecoveryResponse, number>>>;

/** Cap for one response under this config, or `null` when it is uncapped. */
export function responseCap(response: RecoveryResponse, config: RecoveryConfig): number | null {
  const key = RESPONSE_CAP_KEY[response];
  if (key === undefined) return null;
  const value = config[key];
  return typeof value === "number" ? value : null;
}

/** `true` when this response still has room under its own cap. */
export function responseAvailable(
  response: RecoveryResponse,
  config: RecoveryConfig,
  usage: ResponseUsage,
): boolean {
  const cap = responseCap(response, config);
  if (cap === null) return true;
  return (usage[response] ?? 0) < cap;
}

// ---------------------------------------------------------------------------
// side effects
// ---------------------------------------------------------------------------

/**
 * A step that recovery might want to retry.
 *
 * `sideEffect` is the flag PLAN §3.G asks for. It is declared *with the step*
 * — by the planner for a task's checks, by the caller for a command — and
 * never inferred here: guessing whether `npm run deploy` writes is exactly
 * the judgement that must not be made on a hunch. When it is `true` the step
 * must also declare how its outcome can be observed, which is what makes a
 * retry safe.
 */
export interface RecoverableStep {
  /** Stable id: a check id, a command id, a task id. */
  readonly stepId: string;
  /** `true` when running this step may change state that a retry would duplicate. */
  readonly sideEffect: boolean;
  /**
   * Idempotency key for the effect (`actionIdFor` from #42), when the step
   * performs a guarded action. Its receipt is the authoritative answer to
   * "did this already happen".
   */
  readonly actionId?: string | null;
  /**
   * Declared reconciliation probe: a read-only observation that answers
   * whether the effect landed. Named here, executed by the caller.
   */
  readonly reconciliationProbe?: ReconciliationProbe | null;
  /** `true` when the effect leaves this repository (push, publish, deploy). */
  readonly externalEffect?: boolean;
}

/** A declared, read-only probe that says whether a step's effect landed. */
export interface ReconciliationProbe {
  readonly probeId: string;
  /** What the probe observes, for the audit row and the user-facing notice. */
  readonly description: string;
}

/** What a probe (or a receipt) concluded about an uncertain outcome. */
export const SIDE_EFFECT_STATUSES = [
  "none",
  "not_applied",
  "already_applied",
  "partially_applied",
  "unknown",
] as const;

export type SideEffectStatus = (typeof SIDE_EFFECT_STATUSES)[number];

/** The outcome of reconciling one step, before any retry decision is taken. */
export interface ReconciliationOutcome {
  readonly status: SideEffectStatus;
  /** Stable id of what produced the verdict: a receipt, a probe, or neither. */
  readonly source: "no_side_effect" | "action_receipt" | "probe" | "unreconciled";
  readonly detail: string;
}

/**
 * Statuses under which a retry is permitted.
 *
 * `not_applied` is the only one: the step demonstrably did not take effect,
 * so running it again cannot duplicate anything. `already_applied` means the
 * work is done — retrying would be the double effect; `partially_applied`
 * and `unknown` mean nobody can say, and "nobody can say" is never permission.
 */
export function retryPermittedAfter(outcome: ReconciliationOutcome): boolean {
  return outcome.status === "none" || outcome.status === "not_applied";
}

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

/** What `chooseRecovery` is told. Pure data; the caller does the observing. */
export interface RecoveryInput {
  /** The #52 classification. Never re-derived here. */
  readonly classification: FailureClassification;
  /**
   * Attempts already spent on this subject, **counting the one that just
   * failed**. The first failure is `attemptsUsed: 1`.
   */
  readonly attemptsUsed: number;
  /** Which cap applies. A phase gate is bounded more tightly than a task. */
  readonly subjectKind: "task" | "phase" | "workflow";
  /** Per-response usage so far on this subject, from the recovery log. */
  readonly usage?: ResponseUsage;
  /** The step recovery would re-run, when there is one. */
  readonly step?: RecoverableStep;
  /** Reconciliation verdict for `step`, when it has already been obtained. */
  readonly reconciliation?: ReconciliationOutcome;
  /** Stall events raised for this subject (#52). Advisory; they escalate. */
  readonly stalls?: readonly StallEvent[];
}

/** The decision, with everything the audit row needs. */
export interface RecoveryDecision {
  readonly response: RecoveryResponse;
  /** Stable id of the rule that chose it; matches the tests and `/korwf why`. */
  readonly policyRule: string;
  readonly reason: string;
  readonly terminal: boolean;
  readonly failureCategory: FailureCategory;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  /** Attempts still available after this decision. `0` on a terminal one. */
  readonly attemptsRemaining: number;
  /** Reconciliation that was taken into account, or `null` when none applied. */
  readonly reconciliation: ReconciliationOutcome | null;
  /** Concrete observations to run first, when the response is `gather_evidence`. */
  readonly evidenceRequests: readonly string[];
}

/** The attempt ceiling for a subject kind. */
export function maxAttemptsFor(subjectKind: RecoveryInput["subjectKind"], config: RecoveryConfig): number {
  if (subjectKind === "phase") return config.maxAttemptsPerPhase;
  return config.maxAttemptsPerTask;
}

function terminal(
  response: TerminalRecoveryResponse,
  policyRule: string,
  reason: string,
  input: RecoveryInput,
  maxAttempts: number,
  reconciliation: ReconciliationOutcome | null,
): RecoveryDecision {
  return Object.freeze({
    response,
    policyRule,
    reason,
    terminal: true,
    failureCategory: input.classification.category,
    attemptsUsed: input.attemptsUsed,
    maxAttempts,
    attemptsRemaining: 0,
    reconciliation,
    evidenceRequests: Object.freeze([]),
  });
}

/**
 * Choose the bounded response to one failure (AC1, AC2).
 *
 * The order of the gates is the whole design, and each one can only make the
 * answer *more* conservative:
 *
 * 1. **The attempt ceiling, first.** If the subject has spent its attempts,
 *    no ladder, stall signal, classification or side-effect state can produce
 *    another `retry`. This is checked before anything else precisely so that
 *    no later branch can route around it.
 * 2. **Side effects, before any retry.** A step flagged `sideEffect` with no
 *    reconciliation, or one whose reconciliation says `unknown`/`partially
 *    _applied`, cannot be retried at all; the response is
 *    `config.unreconcilableSideEffect`, which the schema pins to a terminal
 *    value. `already_applied` is not a failure to retry either — the effect
 *    happened, so the honest response is to ask.
 * 3. **`unknown` classification is not a diagnosis** (#52): gather the
 *    evidence it asked for, up to its own cap, then ask.
 * 4. **Stalls escalate** (#52): a `repeated_approach` or `no_progress` stall
 *    means another go at the same rung is waste, so the ladder is advanced.
 * 5. **The ladder**, indexed by attempt, skipping rungs whose own cap is
 *    spent. Running off the end is `config.finalResponse`.
 *
 * Pure: same inputs, same decision. No clock, no store, no Jev.
 */
export function chooseRecovery(input: RecoveryInput, config: RecoveryConfig): RecoveryDecision {
  const maxAttempts = maxAttemptsFor(input.subjectKind, config);
  const category = input.classification.category;
  const usage = input.usage ?? {};
  const step = input.step;
  const reconciliation = step === undefined ? null : (input.reconciliation ?? null);

  // 1. The bound. Nothing below may override this.
  if (input.attemptsUsed >= maxAttempts) {
    return terminal(
      config.finalResponse,
      "bound:max-attempts",
      `Attempt budget exhausted: ${input.attemptsUsed} of ${maxAttempts} attempts used on this ${input.subjectKind}. ` +
        `No further automatic attempt is permitted; the remaining response is ${config.finalResponse}.`,
      input,
      maxAttempts,
      reconciliation,
    );
  }

  // 2. Side effects, before any retry is even considered.
  if (step !== undefined && step.sideEffect) {
    const outcome = reconciliation ?? UNRECONCILED;
    if (!retryPermittedAfter(outcome)) {
      return terminal(
        config.unreconcilableSideEffect,
        `side-effect:${outcome.status}`,
        `Step ${step.stepId} may have had side effects and its outcome is "${outcome.status}" (${outcome.detail}). ` +
          "PLAN §3.G forbids retrying an unreconciled side effect, so recovery does not retry it.",
        input,
        maxAttempts,
        outcome,
      );
    }
  }

  // 3. `unknown` is never acted on as a diagnosis.
  if (category === "unknown" || input.classification.needsEvidence) {
    if (responseAvailable("gather_evidence", config, usage)) {
      return Object.freeze({
        response: "gather_evidence" as const,
        policyRule: "evidence:needs-evidence",
        reason:
          `The failure is classified ${category} with needsEvidence=true (${input.classification.rule}); ` +
          "acting on it as a diagnosis is not supported. Gather the named observations and classify again.",
        terminal: false,
        failureCategory: category,
        attemptsUsed: input.attemptsUsed,
        maxAttempts,
        attemptsRemaining: maxAttempts - input.attemptsUsed,
        reconciliation,
        evidenceRequests: input.classification.evidenceRequests,
      });
    }
    return terminal(
      config.finalResponse,
      "evidence:exhausted",
      `Evidence was gathered ${usage.gather_evidence ?? 0} time(s), the configured maximum, and the failure is ` +
        `still ${category}. Continuing to gather evidence is a stall, not a recovery.`,
      input,
      maxAttempts,
      reconciliation,
    );
  }

  // 4/5. The ladder, advanced by stalls, bounded by each rung's own cap.
  const ladder = RECOVERY_LADDERS[category];
  const skipped = escalationOffset(input.stalls ?? []);
  for (let index = input.attemptsUsed - 1 + skipped; index < ladder.length; index += 1) {
    const response = ladder[index];
    if (response === undefined) break;
    if (!responseAvailable(response, config, usage)) continue;
    return Object.freeze({
      response,
      policyRule: `ladder:${category}:${index + 1}`,
      reason: ladderReason(category, response, input, skipped),
      terminal: false,
      failureCategory: category,
      attemptsUsed: input.attemptsUsed,
      maxAttempts,
      attemptsRemaining: maxAttempts - input.attemptsUsed,
      reconciliation,
      evidenceRequests:
        response === "gather_evidence" ? input.classification.evidenceRequests : Object.freeze([]),
    });
  }

  return terminal(
    config.finalResponse,
    `ladder:${category}:exhausted`,
    `The ${category} recovery ladder (${ladder.join(" → ") || "empty"}) offers nothing further at attempt ` +
      `${input.attemptsUsed}: every remaining response is capped or spent.`,
    input,
    maxAttempts,
    reconciliation,
  );
}

/** The verdict for a side-effecting step nobody reconciled. */
export const UNRECONCILED: ReconciliationOutcome = Object.freeze({
  status: "unknown" as const,
  source: "unreconciled" as const,
  detail: "The step is flagged as having side effects and no reconciliation was performed.",
});

/** Stall kinds that mean "another go at the same rung is waste". */
const ESCALATING_STALLS = new Set(["repeated_approach", "no_progress", "repeated_failure"]);

/**
 * How many ladder rungs a stall signal skips. At most one: a stall says the
 * current rung is not working, not that every remaining rung is hopeless.
 */
export function escalationOffset(stalls: readonly StallEvent[]): number {
  return stalls.some((event) => ESCALATING_STALLS.has(event.kind)) ? 1 : 0;
}

function ladderReason(
  category: FailureCategory,
  response: RecoveryResponse,
  input: RecoveryInput,
  skipped: number,
): string {
  const stall =
    skipped > 0
      ? ` A stall was detected (${(input.stalls ?? []).map((s) => s.kind).join(", ")}), so the ladder advanced a rung.`
      : "";
  return (
    `Failure classified ${category} by ${input.classification.rule}; at attempt ${input.attemptsUsed} the ` +
    `${category} ladder gives ${response}: ${RECOVERY_RESPONSE_DESCRIPTIONS[response]}${stall}`
  );
}

// ---------------------------------------------------------------------------
// reconciling an uncertain outcome
// ---------------------------------------------------------------------------

/** Runs a declared probe. Read-only by contract; it must not repair anything. */
export type ProbeRunner = (probe: ReconciliationProbe, step: RecoverableStep) => ProbeVerdict;

/** What a probe reports. `throw` is treated as `unknown`, never as "not applied". */
export interface ProbeVerdict {
  readonly applied: boolean | "partial" | "unknown";
  readonly detail: string;
}

/**
 * Establish what happened to a step's effect, **before** any retry (AC2).
 *
 * The order matters and is not arbitrary:
 *
 * 1. A step with no side effect needs no reconciliation at all (`none`).
 * 2. The #42 receipt is consulted first when the step names an `actionId`.
 *    A receipt is a *fact*: the action completed, in this session or in the
 *    one this conversation was forked from. No probe can overrule it, and
 *    this module does not re-derive the idea of refusing a replay — it reads
 *    the log that already does.
 * 3. Only then is the declared probe run. A probe that throws yields
 *    `unknown`, because a failed observation is not evidence of absence.
 * 4. A side-effecting step with no receipt and no probe is `unknown`. There
 *    is no fallback that assumes the effect did not land.
 */
export function reconcileStep(
  step: RecoverableStep,
  options: {
    /** `true` when a completed-action receipt exists for `step.actionId` (#42). */
    readonly hasReceipt?: (actionId: string) => boolean;
    readonly runProbe?: ProbeRunner;
  } = {},
): ReconciliationOutcome {
  if (!step.sideEffect) {
    return Object.freeze({
      status: "none" as const,
      source: "no_side_effect" as const,
      detail: `Step ${step.stepId} is declared free of side effects; there is nothing to reconcile.`,
    });
  }

  const actionId = step.actionId ?? null;
  if (actionId !== null && options.hasReceipt?.(actionId) === true) {
    return Object.freeze({
      status: "already_applied" as const,
      source: "action_receipt" as const,
      detail:
        `A completed-action receipt exists for ${actionId} (src/storage/action-log.ts), so the effect of ` +
        `${step.stepId} already happened. Re-running it would be a second effect.`,
    });
  }

  const probe = step.reconciliationProbe ?? null;
  if (probe === null || options.runProbe === undefined) {
    return Object.freeze({
      status: "unknown" as const,
      source: "unreconciled" as const,
      detail:
        `Step ${step.stepId} is flagged as having side effects but declares ` +
        `${probe === null ? "no reconciliation probe" : "a probe that no runner was supplied for"}, ` +
        "so whether its effect landed cannot be established.",
    });
  }

  let verdict: ProbeVerdict;
  try {
    verdict = options.runProbe(probe, step);
  } catch (error) {
    return Object.freeze({
      status: "unknown" as const,
      source: "probe" as const,
      detail:
        `Reconciliation probe ${probe.probeId} failed (${error instanceof Error ? error.name : "error"}); ` +
        "a failed observation is not evidence that the effect did not land.",
    });
  }

  const status: SideEffectStatus =
    verdict.applied === true
      ? "already_applied"
      : verdict.applied === false
        ? "not_applied"
        : verdict.applied === "partial"
          ? "partially_applied"
          : "unknown";
  return Object.freeze({
    status,
    source: "probe" as const,
    detail: `Probe ${probe.probeId} (${probe.description}): ${verdict.detail}`,
  });
}

// ---------------------------------------------------------------------------
// the shell: reconcile, decide, audit
// ---------------------------------------------------------------------------

/** Per-response usage read back out of the recovery log for one subject. */
export function usageFromLog(store: Store, subjectKind: RecoverySubjectKind, subjectId: string): ResponseUsage {
  const usage: Partial<Record<RecoveryResponse, number>> = {};
  for (const row of store.recoveries.forSubject(subjectKind, subjectId)) {
    const response = row.response as RecoveryResponse;
    if (!RECOVERY_RESPONSES.includes(response)) continue;
    usage[response] = (usage[response] ?? 0) + 1;
  }
  return Object.freeze(usage);
}

export interface RecoverFromFailureOptions {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly subjectKind: RecoverySubjectKind;
  readonly subjectId: string;
  readonly classification: FailureClassification;
  readonly attemptsUsed: number;
  readonly config: RecoveryConfig;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
  readonly step?: RecoverableStep;
  readonly runProbe?: ProbeRunner;
  readonly stalls?: readonly StallEvent[];
  /**
   * Per-response usage. Omit to read it from the recovery log, which is what
   * makes the per-response caps survive a resumed or forked session.
   */
  readonly usage?: ResponseUsage;
}

/** A decision together with the audit row that records it. */
export interface RecordedRecovery {
  readonly decision: RecoveryDecision;
  readonly rowId: string;
  readonly reconciliation: ReconciliationOutcome | null;
}

/**
 * Reconcile, decide, and record — in that order (AC2, AC3).
 *
 * Reconciliation happens **before** `chooseRecovery` sees the input, so the
 * decision is taken with the side-effect verdict already in hand rather than
 * after committing to a retry. The audit row is written on *every* path,
 * including the terminal ones: a recovery that stopped is exactly the
 * decision someone will later need explained.
 *
 * The receipt lookup is `store.actions.isCompleted` (#42) — the same log that
 * refuses a replay. There is no second idempotency mechanism here.
 */
export function recoverFromFailure(options: RecoverFromFailureOptions): RecordedRecovery {
  const { store, config } = options;
  const reconciliation =
    options.step === undefined
      ? null
      : reconcileStep(options.step, {
          hasReceipt: (actionId) => store.actions.isCompleted(actionId),
          ...(options.runProbe === undefined ? {} : { runProbe: options.runProbe }),
        });

  const decision = chooseRecovery(
    {
      classification: options.classification,
      attemptsUsed: options.attemptsUsed,
      subjectKind: options.subjectKind,
      usage: options.usage ?? usageFromLog(store, options.subjectKind, options.subjectId),
      ...(options.step === undefined ? {} : { step: options.step }),
      ...(reconciliation === null ? {} : { reconciliation }),
      ...(options.stalls === undefined ? {} : { stalls: options.stalls }),
    },
    config,
  );

  const rowId = options.newId();
  store.write(() => {
    store.recoveries.insert({
      decisionRowId: rowId,
      createdAt: options.now(),
      workflowId: options.workflowId,
      subjectKind: options.subjectKind,
      subjectId: options.subjectId,
      attemptsUsed: decision.attemptsUsed,
      maxAttempts: decision.maxAttempts,
      failureCategory: decision.failureCategory,
      failureRule: options.classification.rule,
      response: decision.response,
      policyRule: decision.policyRule,
      reason: decision.reason,
      terminal: decision.terminal,
      sideEffectStatus: reconciliation?.status ?? null,
      actionId: options.step?.actionId ?? null,
    });
  });

  return { decision, rowId, reconciliation };
}

// ---------------------------------------------------------------------------
// surfacing it
// ---------------------------------------------------------------------------

/** One line for the status widget / `/korwf why`. Never fabricated rationale. */
export function describeRecovery(decision: RecoveryDecision): string {
  return (
    `${decision.response} (${decision.policyRule}) — attempt ${decision.attemptsUsed}/${decision.maxAttempts}, ` +
    `${decision.failureCategory}: ${decision.reason}`
  );
}

/**
 * The whole remaining ladder for a subject, for a user asking "what happens
 * if this keeps failing?".
 *
 * It terminates by construction: the loop is bounded by `maxAttempts`, and
 * the last element is always terminal. A projection that could run forever
 * would mean a policy that could run forever.
 */
export function projectRecovery(input: RecoveryInput, config: RecoveryConfig): readonly RecoveryDecision[] {
  const out: RecoveryDecision[] = [];
  const usage: Partial<Record<RecoveryResponse, number>> = { ...(input.usage ?? {}) };
  const maxAttempts = maxAttemptsFor(input.subjectKind, config);
  for (let attempt = input.attemptsUsed; attempt <= maxAttempts; attempt += 1) {
    const decision = chooseRecovery({ ...input, attemptsUsed: attempt, usage: Object.freeze({ ...usage }) }, config);
    out.push(decision);
    if (decision.terminal) break;
    usage[decision.response] = (usage[decision.response] ?? 0) + 1;
  }
  return Object.freeze(out);
}
