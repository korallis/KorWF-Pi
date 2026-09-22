/**
 * Worker runtime control (issue #71; PLAN §3.E, §3.I; ADR 0004 "Resource and
 * progress capture").
 *
 * This module is the *supervisor* around the #68 `WorkerHandle`. It does four
 * things and delegates everything else:
 *
 * 1. **Progress.** ADR 0004 already decides where progress comes from: the
 *    RPC event stream. `tool_execution_*` and `bash_execution_update` drive
 *    the board; `message_update.usage` and `get_session_stats` feed
 *    accounting. `progress.ts` classifies those events into a timeline; this
 *    module wires it to the handle. No parallel channel is opened.
 * 2. **Artifacts.** Declared `termination.artifacts` are captured into the
 *    #23 `ArtifactStore` under the attempt id, producing `ArtifactRef`s for
 *    the Attempt row (docs/records.md "Attempt (usage, artifacts)"). A
 *    declared artifact that does not exist is reported missing, never faked.
 * 3. **Usage and limits.** Usage is attributed **per route** (#125), never
 *    per model id, and cost the registry does not state stays `unknown`,
 *    never 0 (#56/#30). Global limits are enforced by #30's atomic
 *    `BEGIN IMMEDIATE` reservation — reserved before the process exists,
 *    settled after it ends, so two workers cannot both pass the same
 *    remaining budget. Per-worker limits are the pure predicates in
 *    `limits.ts`. There is no second accounting path.
 * 4. **Pause / resume / cancel.** Cancellation reuses #68's three-tier ladder
 *    with its pre-snapshotted descendant sweep; pause/resume are SIGSTOP /
 *    SIGCONT to the worker's process group, with the elapsed clock stopped
 *    while paused — a paused worker is not consuming wall clock it could
 *    have spent working, and charging it would make `pause` a slow `cancel`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactRef, AttemptId, AttemptOutcome, AttemptTermination, IsoTimestamp, Usage } from "../storage/records.ts";
import type { Route } from "../models/route.ts";
import { routeLabel } from "../telemetry/usage.ts";
import { assertHonestUsage, unknownUsage, type ChargeScope, type Ledger, type PriceMetadata, type Reservation } from "../telemetry/ledger.ts";
import { mergeUsage } from "../telemetry/usage.ts";
import { realProcessOps, waitUntil, type ProcessOps } from "./process-tree.ts";
import { ProgressTimeline, usageFromRpc, usagePayloadOf, type ProgressSnapshot } from "./progress.ts";
import { evaluateLimits, msUntilElapsedLimit, type LimitBreach } from "./limits.ts";
import type { CancelResult, RpcMessage, WorkerHandle } from "./spawn.ts";

/** How a supervised run ended, from the supervisor's point of view. */
export type WorkerRunOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "limit_exceeded"
  | "crashed";

/** Where a run currently is. */
export type WorkerRunState = "pending" | "running" | "paused" | "stopping" | "finished";

/** An artifact the contract declared and what became of it. */
export interface CapturedArtifact {
  readonly declaredPath: string;
  /** `null` when the worker never produced it. */
  readonly ref: ArtifactRef | null;
  readonly missing: boolean;
  /** Why it was not captured; `null` when it was. */
  readonly reason: string | null;
}

/** Everything the supervisor knows once the worker has stopped. */
export interface WorkerRunResult {
  readonly outcome: WorkerRunOutcome;
  /** Outcome to store on the Attempt row (docs/records.md §4). */
  readonly attemptOutcome: AttemptOutcome;
  /** Why the turn stopped, for `Attempt.termination` (#124). */
  readonly termination: AttemptTermination;
  /** Route-attributed usage actually settled against the ledger (#125). */
  readonly usage: Usage;
  readonly elapsedMs: number;
  /** Per-worker limit that ended the run, or `null`. */
  readonly breach: LimitBreach | null;
  /** Result of the three-tier cancellation, when one happened. */
  readonly cancellation: CancelResult | null;
  readonly artifacts: readonly CapturedArtifact[];
  readonly progress: ProgressSnapshot;
}

/** Inputs for {@link WorkerRun}. */
export interface WorkerRunOptions {
  readonly handle: WorkerHandle;
  /** The #30 ledger. Global limits are enforced by its atomic reservation. */
  readonly ledger: Ledger;
  readonly scope: ChargeScope;
  /** Route the worker runs on. Usage is attributed to it, not to a model id. */
  readonly route: Route;
  /** Price metadata from the catalog; absent or zero means unknown cost. */
  readonly price?: PriceMetadata | null;
  /** Pre-call estimate charged against caps while the worker runs. */
  readonly estimate?: Usage;
  /** Artifact sink; normally `store.artifacts`. Omit to skip capture. */
  readonly artifacts?: ArtifactSink | undefined;
  readonly attemptId?: AttemptId | undefined;
  readonly now?: () => IsoTimestamp;
  /** Monotonic-ish millisecond clock. Injected in tests. */
  readonly monotonic?: () => number;
  readonly processOps?: ProcessOps;
  /** Bound on the in-memory progress timeline. */
  readonly maxProgressEvents?: number;
}

/** The slice of `ArtifactStore` (#23) this module uses. */
export interface ArtifactSink {
  write(attemptId: string, relativePath: string, data: Buffer | string, mediaType?: string): ArtifactRef;
}

const DEFAULT_ESTIMATE_REQUESTS = 1;

/**
 * Live runs, so `/korwf pause|resume|cancel` can address a worker by id and
 * so shutdown can stop everything.
 *
 * This is a *handle* registry, not a limit. Global concurrency is a budget
 * cap enforced by the ledger's atomic reservation (`budgets.*.maxConcurrency`
 * via `Ledger.reserve`), because only a `BEGIN IMMEDIATE` transaction can
 * stop two processes passing the same remaining budget. Counting entries in
 * this map would be a per-process approximation of a cross-process rule.
 */
export class WorkerRegistry {
  readonly #runs = new Map<string, WorkerRun>();

  register(run: WorkerRun): void {
    this.#runs.set(run.handle.contract.workerId, run);
  }

  get(workerId: string): WorkerRun | undefined {
    return this.#runs.get(workerId);
  }

  /** Runs that have not finished, oldest first. */
  active(): readonly WorkerRun[] {
    return [...this.#runs.values()].filter((run) => run.state !== "finished");
  }

  list(): readonly WorkerRun[] {
    return [...this.#runs.values()];
  }

  remove(workerId: string): void {
    this.#runs.delete(workerId);
  }

  /** Cancel every active run. Used by shutdown and by `/korwf cancel --all`. */
  async cancelAll(reason: string): Promise<readonly CancelResult[]> {
    const results: CancelResult[] = [];
    for (const run of this.active()) results.push(await run.cancel(reason));
    return results;
  }
}

/** Map a supervisor outcome to the Attempt outcome vocabulary. */
export function toAttemptOutcome(outcome: WorkerRunOutcome): AttemptOutcome {
  switch (outcome) {
    case "completed":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "timeout":
    case "limit_exceeded":
    case "failed":
    case "crashed":
      return "failed";
  }
}

export class WorkerRun {
  readonly handle: WorkerHandle;
  readonly route: Route;
  readonly timeline: ProgressTimeline;

  #state: WorkerRunState = "pending";
  #reservation: Reservation | null = null;
  #result: WorkerRunResult | null = null;
  #breach: LimitBreach | null = null;
  #cancellation: CancelResult | null = null;
  #cancelReason: string | null = null;
  #usages: Usage[] = [];
  #startedAt = 0;
  #pausedAt: number | null = null;
  #pausedTotalMs = 0;
  #endedAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #settled = false;

  readonly #options: WorkerRunOptions;
  readonly #ops: ProcessOps;
  readonly #now: () => IsoTimestamp;
  readonly #monotonic: () => number;

  constructor(options: WorkerRunOptions) {
    this.#options = options;
    this.handle = options.handle;
    this.route = options.route;
    this.#ops = options.processOps ?? realProcessOps;
    this.#now = options.now ?? ((): IsoTimestamp => new Date().toISOString());
    this.#monotonic = options.monotonic ?? ((): number => Date.now());
    this.timeline = new ProgressTimeline({
      now: this.#now,
      ...(options.maxProgressEvents === undefined ? {} : { maxEvents: options.maxProgressEvents }),
    });
  }

  get state(): WorkerRunState {
    return this.#state;
  }

  get reservation(): Reservation | null {
    return this.#reservation;
  }

  /** Milliseconds of *running* wall clock; paused time is excluded. */
  get elapsedMs(): number {
    if (this.#state === "pending") return 0;
    const end = this.#endedAt ?? this.#monotonic();
    const pausedNow = this.#pausedAt === null ? 0 : end - this.#pausedAt;
    return Math.max(0, end - this.#startedAt - this.#pausedTotalMs - pausedNow);
  }

  /** Usage observed so far, merged honestly (unknown stays unknown). */
  get observedUsage(): Usage {
    return mergeUsage(this.#usages);
  }

  snapshot(): ProgressSnapshot {
    return this.timeline.snapshot();
  }

  /**
   * Reserve budget and begin supervising.
   *
   * The reservation comes first and is *atomic* (#30): the remaining-budget
   * read and the reservation insert share one `BEGIN IMMEDIATE`
   * transaction, so when two workers race for the last dollar exactly one
   * gets it and the other sees `BudgetExceededError` — which propagates out
   * of here unchanged, before any progress is recorded. A global limit is
   * therefore never enforced by an in-process counter.
   */
  start(): void {
    if (this.#state !== "pending") throw new Error(`WorkerRun.start: already ${this.#state}`);
    this.#reservation = this.#options.ledger.reserve({
      scope: this.#options.scope,
      channel: "model",
      estimate: this.#options.estimate ?? unknownUsage(DEFAULT_ESTIMATE_REQUESTS),
      // Route attribution (#125): the ledger row names the route, so two
      // subscriptions to one vendor never pool into one model id.
      label: routeLabel(this.route.routeId),
    });
    this.#startedAt = this.#monotonic();
    this.#state = "running";
    this.timeline.record("started", `worker ${this.handle.contract.workerId} started on route ${this.route.ref}`);
    this.#unsubscribe = this.handle.subscribe((message: RpcMessage): void => {
      this.observe(message);
    });
    this.#armElapsedTimer();
  }

  /**
   * Feed one RPC message through the timeline and the accounting.
   *
   * Called by the handle's message callback. Any usage payload — from
   * `message_update` or from a `get_session_stats` response — is converted by
   * `usageFromRpc`, which keeps an unpriced route's cost `unknown` rather
   * than reporting it as `$0.00`.
   */
  observe(message: RpcMessage): void {
    this.timeline.observe(message);
    const payload = usagePayloadOf(message);
    if (payload !== undefined) {
      this.#usages.push(usageFromRpc(payload, this.#options.price ?? null));
    }
    if (message.type === "worker_exit") {
      this.#endedAt ??= this.#monotonic();
      this.#clearTimer();
      return;
    }
    void this.#enforceLimits();
  }

  /** Ask the worker for `get_session_stats` and fold the answer into usage. */
  async pollSessionStats(timeoutMs = 5_000): Promise<Usage | null> {
    if (this.handle.exit !== undefined) return null;
    let response: RpcMessage;
    try {
      response = await this.handle.call({ type: "get_session_stats" }, timeoutMs);
    } catch {
      return null; // a worker that will not answer is not an accounting failure
    }
    const payload = usagePayloadOf(response) ?? response.data;
    if (payload === undefined || payload === null) return null;
    const usage = usageFromRpc(payload, this.#options.price ?? null);
    this.#usages.push(usage);
    this.timeline.record("usage", "session stats polled", null, "get_session_stats");
    await this.#enforceLimits();
    return usage;
  }

  /**
   * Check the per-worker budget and terminate the worker if it is breached.
   * Idempotent: the first breach wins and later checks are no-ops.
   */
  async #enforceLimits(): Promise<void> {
    if (this.#breach !== null || this.#state === "finished" || this.#state === "stopping") return;
    const breach = evaluateLimits(this.handle.contract.budget, {
      elapsedMs: this.elapsedMs,
      usage: this.observedUsage,
    });
    if (breach === null) return;
    this.#breach = breach;
    this.timeline.record("limit_breached", breach.message);
    await this.cancel(breach.message);
  }

  /**
   * Wake exactly when the wall-clock ceiling could next be crossed.
   *
   * Without this a worker that emits nothing — a `sleep`, a hung request —
   * would never be checked, because every other limit is event-driven. The
   * timer is `unref`ed so it can never hold the process open by itself.
   */
  #armElapsedTimer(): void {
    this.#clearTimer();
    if (this.#state !== "running") return;
    const wait = msUntilElapsedLimit(this.handle.contract.budget, this.elapsedMs);
    if (wait === null) return;
    const timer = setTimeout(() => {
      void this.#enforceLimits();
    }, wait);
    timer.unref?.();
    this.#timer = timer;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // pause / resume / cancel
  // -------------------------------------------------------------------------

  /**
   * Pause the worker: SIGSTOP to its process group, then its pid.
   *
   * The group goes first so a shell command the worker spawned stops too —
   * pausing only the supervisor's direct child would leave a `npm test`
   * running and still spending. The elapsed clock stops with it: a paused
   * worker must not burn the wall-clock limit it cannot work against,
   * otherwise `pause` is just a slow `cancel`.
   *
   * Cooperative fallback: where signals do not apply (Windows), the RPC
   * `abort_bash` stops the outstanding command and the run is marked paused
   * so no further work is dispatched to it.
   */
  pause(reason = "paused by user"): boolean {
    if (this.#state !== "running") return false;
    this.#state = "paused";
    this.#pausedAt = this.#monotonic();
    this.#clearTimer();
    if (this.#ops.killTreeNative !== null) {
      // No POSIX job control: stop the outstanding command cooperatively.
      this.handle.send({ type: "abort_bash" });
    } else {
      this.#ops.kill(-this.handle.pid, "SIGSTOP");
      this.#ops.kill(this.handle.pid, "SIGSTOP");
    }
    this.timeline.record("paused", reason);
    return true;
  }

  /** Resume a paused worker (SIGCONT), crediting back the paused interval. */
  resume(reason = "resumed by user"): boolean {
    if (this.#state !== "paused") return false;
    if (this.#pausedAt !== null) {
      this.#pausedTotalMs += Math.max(0, this.#monotonic() - this.#pausedAt);
      this.#pausedAt = null;
    }
    this.#state = "running";
    if (this.#ops.killTreeNative === null) {
      this.#ops.kill(-this.handle.pid, "SIGCONT");
      this.#ops.kill(this.handle.pid, "SIGCONT");
    }
    this.timeline.record("resumed", reason);
    this.#armElapsedTimer();
    return true;
  }

  /**
   * Cancel the worker through #68's three-tier ladder.
   *
   * A paused (SIGSTOPped) worker is continued first: a stopped process never
   * receives SIGTERM, so tier 2 would silently time out and every
   * cancellation of a paused worker would escalate to SIGKILL. The descendant
   * snapshot is taken inside `handle.cancel()`, *before* any signal, which is
   * the only reason tier 3 can reap orphans at all (ADR 0004).
   */
  async cancel(reason = "cancelled"): Promise<CancelResult> {
    if (this.#state === "paused" && this.#ops.killTreeNative === null) {
      this.#ops.kill(-this.handle.pid, "SIGCONT");
      this.#ops.kill(this.handle.pid, "SIGCONT");
      if (this.#pausedAt !== null) {
        this.#pausedTotalMs += Math.max(0, this.#monotonic() - this.#pausedAt);
        this.#pausedAt = null;
      }
    }
    this.#state = "stopping";
    this.#clearTimer();
    this.#cancelReason = reason;
    this.timeline.record("cancelled", reason);
    const result = await this.handle.cancel(reason);
    this.#cancellation = result;
    this.#endedAt ??= this.#monotonic();
    return result;
  }

  // -------------------------------------------------------------------------
  // settlement
  // -------------------------------------------------------------------------

  /**
   * Wait for the worker to stop, then settle and report.
   *
   * `timeoutMs` bounds only this wait; the worker's own wall-clock limit is
   * enforced by the timer armed in `start()`, so a sleeping worker is
   * terminated by its budget rather than by whoever happens to be awaiting
   * it.
   */
  async wait(timeoutMs = this.handle.contract.budget.wallClockMs + this.handle.contract.termination.graceMs + 5_000): Promise<WorkerRunResult> {
    if (this.#result !== null) return this.#result;
    await waitUntil(() => this.handle.exit !== undefined, timeoutMs);
    if (this.handle.exit === undefined) {
      // Neither the budget timer nor a caller stopped it: stop it now rather
      // than return a result about a process that is still running.
      await this.cancel("supervisor wait timed out");
    }
    return this.finish();
  }

  /**
   * Close the run: settle the reservation with the actual usage, capture
   * artifacts, and build the result. Idempotent — the ledger rejects a second
   * settlement of the same reservation and so does this.
   */
  finish(): WorkerRunResult {
    if (this.#result !== null) return this.#result;
    this.#clearTimer();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#endedAt ??= this.#monotonic();
    this.#state = "finished";

    const usage = this.observedUsage;
    const elapsedMs = this.elapsedMs;
    if (this.#reservation !== null && !this.#settled) {
      this.#settled = true;
      assertHonestUsage(usage);
      this.#options.ledger.settle(this.#reservation, usage, {
        elapsedMs,
        ...(this.#cancelReason === null ? {} : { reason: this.#cancelReason }),
      });
    }

    const outcome = this.#classifyOutcome();
    const result: WorkerRunResult = {
      outcome,
      attemptOutcome: toAttemptOutcome(outcome),
      termination: this.#termination(outcome),
      usage,
      elapsedMs,
      breach: this.#breach,
      cancellation: this.#cancellation,
      artifacts: this.#captureArtifacts(),
      progress: this.timeline.snapshot(),
    };
    this.#result = result;
    return result;
  }

  #classifyOutcome(): WorkerRunOutcome {
    if (this.#breach !== null) return this.#breach.kind === "elapsed" ? "timeout" : "limit_exceeded";
    if (this.#cancelReason !== null) return "cancelled";
    const exit = this.handle.exit;
    if (exit === undefined) return "failed";
    if (exit.crashed) return "crashed";
    return exit.code === 0 ? "completed" : "failed";
  }

  /**
   * `Attempt.termination` (#124): *why the turn stopped*, kept distinct from
   * the outcome. `consumedAttemptBudget` is false for every harness failure —
   * a timeout or a cancellation says nothing about the quality of the work,
   * and charging it to the task's attempt budget is how six identical
   * harness failures once looked like six bad attempts.
   */
  #termination(outcome: WorkerRunOutcome): AttemptTermination {
    const outputTokens = this.observedUsage.outputTokens;
    const base = { stopReason: null as string | null, truncated: false, outputTokens };
    switch (outcome) {
      case "timeout":
        return { ...base, stopReason: "timeout", failureKind: "timeout", failureClass: "harness", consumedAttemptBudget: false };
      case "limit_exceeded":
        return { ...base, stopReason: this.#breach?.kind ?? "limit", failureKind: "capped", failureClass: "harness", consumedAttemptBudget: false };
      case "cancelled":
        return { ...base, stopReason: "cancelled", failureKind: "none", failureClass: "harness", consumedAttemptBudget: false };
      case "crashed":
        return { ...base, stopReason: "crashed", failureKind: "transport_error", failureClass: "harness", consumedAttemptBudget: false };
      case "failed":
        return { ...base, stopReason: "error", failureKind: "gap", failureClass: "quality", consumedAttemptBudget: true };
      case "completed":
        return { ...base, stopReason: "end_turn", failureKind: "none", failureClass: "none", consumedAttemptBudget: true };
    }
  }

  /**
   * Copy each declared artifact out of the worker's worktree into the #23
   * artifact store, hashed and manifested there.
   *
   * A declared artifact that the worker never produced is reported
   * `missing: true` with no ref. It is never invented, and its absence is
   * evidence the verification gate can act on.
   */
  #captureArtifacts(): readonly CapturedArtifact[] {
    const sink = this.#options.artifacts;
    const attemptId = this.#options.attemptId;
    const declared = this.handle.contract.termination.artifacts;
    if (declared.length === 0) return [];
    if (sink === undefined || attemptId === undefined) {
      return declared.map((declaredPath) => ({
        declaredPath,
        ref: null,
        missing: false,
        reason: "no artifact store configured for this run",
      }));
    }
    return declared.map((declaredPath) => this.#captureOne(sink, attemptId, declaredPath));
  }

  #captureOne(sink: ArtifactSink, attemptId: AttemptId, declaredPath: string): CapturedArtifact {
    const cwd = this.handle.contract.cwd;
    const absolute = isAbsolute(declaredPath) ? declaredPath : join(cwd, declaredPath);
    const rel = relative(cwd, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return {
        declaredPath,
        ref: null,
        missing: false,
        reason: `artifact path escapes the worker's worktree (${cwd}); refusing to capture`,
      };
    }
    if (!existsSync(absolute)) {
      return { declaredPath, ref: null, missing: true, reason: "worker did not produce this artifact" };
    }
    try {
      if (!statSync(absolute).isFile()) {
        return { declaredPath, ref: null, missing: false, reason: "declared artifact is not a regular file" };
      }
      const ref = sink.write(String(attemptId), rel, readFileSync(absolute), "application/octet-stream");
      return { declaredPath, ref, missing: false, reason: null };
    } catch (error) {
      return {
        declaredPath,
        ref: null,
        missing: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
