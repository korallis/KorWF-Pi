/**
 * Usage accounting and atomic budget reservations (issue #30).
 *
 * PLAN §2.6 makes budgets *hard limits enforced in code*, and PLAN §3.I
 * requires actual, estimated and unknown cost to be tracked explicitly. This
 * module is where both happen:
 *
 * - Every Jev call and model call calls `reserve()` before it runs and
 *   `settle()` / `release()` afterwards.
 * - `reserve()` runs entirely inside the store's `BEGIN IMMEDIATE`
 *   transaction (ADR 0006 rule 6): the remaining-budget read and the
 *   reservation insert are one atomic step, so two workers can never both be
 *   told the same last dollar is available. SQLite serialises the writers;
 *   the loser sees the winner's row and is refused.
 * - Cost is `known`, `estimated` or `unknown` (`CostBasis`). A model whose
 *   metadata carries no price — or a price of zero, which is what a proxy
 *   reports when it has no figure — is **unknown**, with `spendUsd === null`.
 *   Unknown-cost calls still consume request, token, concurrency and elapsed
 *   caps; they are reported as unknown, never as `$0.00`.
 *
 * Persistence goes through the #23 store only (`store.ledger`); this module
 * opens no database of its own. Caps come from the `budgets` section of
 * `src/config/schema.json` as loaded by `loadConfig` (#21) — they are not
 * redefined here.
 */
import type {
  AttemptId,
  Budget,
  BudgetScopeKind,
  CostBasis,
  IsoTimestamp,
  LedgerEntry,
  LedgerEntryId,
  LedgerScope,
  PhaseId,
  ReservationId,
  TaskId,
  Usage,
  UsageChannel,
  WorkflowId,
} from "../storage/records.ts";
import { RECORDS_SCHEMA_VERSION } from "../storage/records.ts";
import type { LedgerScopeColumn } from "../storage/repos/index.ts";
import type { Store } from "../storage/db.ts";
import { StoreError } from "../storage/errors.ts";
import {
  LEDGER_ABANDONED_REASON,
  reconcileOpenReservations,
  type AbandonedReservationRow,
} from "../storage/reconcile.ts";
import type { BudgetsConfig } from "../config/types.ts";

// ---------------------------------------------------------------------------
// Cost classification
// ---------------------------------------------------------------------------

/** Usage with no dollar figure at all: the honest zero-knowledge state. */
export const UNKNOWN_COST: Usage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  requests: 1,
  spendUsd: null,
  costBasis: "unknown",
});

/** Which caps a scope kind draws on, and the `budgets` key it reads. */
export const SCOPE_ORDER = ["workflow", "phase", "task"] as const satisfies readonly BudgetScopeKind[];

/** Error thrown when a reservation would breach a cap. Carries the breach detail. */
export class BudgetExceededError extends StoreError {
  readonly scope: BudgetScopeKind;
  readonly cap: keyof Budget;
  readonly limit: number;
  readonly committed: number;
  readonly requested: number;

  constructor(params: {
    scope: BudgetScopeKind;
    cap: keyof Budget;
    limit: number;
    committed: number;
    requested: number;
  }) {
    super(
      "KORWF_BUDGET_EXCEEDED",
      `Budget cap ${params.scope}.${params.cap} = ${params.limit} would be exceeded: ` +
        `${params.committed} already committed, ${params.requested} more requested. ` +
        `The call was refused and nothing was reserved.`,
    );
    this.scope = params.scope;
    this.cap = params.cap;
    this.limit = params.limit;
    this.committed = params.committed;
    this.requested = params.requested;
  }
}

/** Shorthand alias used by callers that catch the hard stop. */
export { BudgetExceededError as BudgetExceeded };

/** Price metadata as Pi's model registry (or a proxy) reports it. */
export interface PriceMetadata {
  /** USD per input token. `null`/`undefined` means the provider gave no figure. */
  readonly inputPerToken?: number | null;
  readonly outputPerToken?: number | null;
}

/** Token counts as reported by a provider; `null` where it reported nothing. */
export interface TokenCounts {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  /** Calls represented by this usage. Defaults to 1. */
  readonly requests?: number;
}

/**
 * Does this price metadata actually tell us anything?
 *
 * A proxy that charges nothing per call still does not *know* the cost — and
 * many report `0` simply because the field is unpopulated. Treating that as
 * free would understate every report, so absent, zero and non-finite prices
 * are all "no price" (issue #30 AC 2).
 */
export function hasUsablePrice(price: PriceMetadata | null | undefined): boolean {
  if (price === null || price === undefined) return false;
  return isPositivePrice(price.inputPerToken) || isPositivePrice(price.outputPerToken);
}

function isPositivePrice(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Build a `Usage` from token counts and whatever price metadata exists.
 *
 * `basis` is the *provenance* the caller claims: `known` for a provider-
 * reported charge, `estimated` for a pre-call projection from a model card.
 * If the price metadata cannot support that claim, the result is downgraded
 * to `unknown` rather than fabricated — the system never invents a number to
 * make a report look complete.
 */
export function classifyCost(params: {
  readonly tokens?: TokenCounts;
  readonly price?: PriceMetadata | null;
  /** Provider-reported total charge, when the provider gives one directly. */
  readonly reportedSpendUsd?: number | null;
  readonly basis: Exclude<CostBasis, "unknown">;
}): Usage {
  const requests = params.tokens?.requests ?? 1;
  const inputTokens = normaliseTokens(params.tokens?.inputTokens);
  const outputTokens = normaliseTokens(params.tokens?.outputTokens);
  const base = { inputTokens, outputTokens, requests };

  const reported = params.reportedSpendUsd;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return { ...base, spendUsd: reported, costBasis: params.basis };
  }
  if (!hasUsablePrice(params.price)) {
    // No charge, no usable price: honest unknown, never zero.
    return { ...base, spendUsd: null, costBasis: "unknown" };
  }
  if (inputTokens === null && outputTokens === null) {
    // We know the rate but not the quantity: still unknown.
    return { ...base, spendUsd: null, costBasis: "unknown" };
  }
  const price = params.price as PriceMetadata;
  const spendUsd =
    (inputTokens ?? 0) * priceOrZero(price.inputPerToken) +
    (outputTokens ?? 0) * priceOrZero(price.outputPerToken);
  return { ...base, spendUsd, costBasis: params.basis };
}

function priceOrZero(value: number | null | undefined): number {
  return isPositivePrice(value) ? (value as number) : 0;
}

function normaliseTokens(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Usage that consumed a request and nothing else measurable. */
export function unknownUsage(requests = 1): Usage {
  return { ...UNKNOWN_COST, requests };
}

/** Zero usage, used by `release()` when a reserved call never ran. */
export function noUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, requests: 0, spendUsd: 0, costBasis: "known" };
}

/**
 * Reject a `Usage` that claims a dollar figure it cannot have, or hides one
 * it does have. The database has the same CHECK; this gives a clear message
 * before SQLite produces an opaque one.
 */
export function assertHonestUsage(usage: Usage): void {
  if (usage.costBasis === "unknown" && usage.spendUsd !== null) {
    throw new UsageIntegrityError(
      `usage with costBasis "unknown" must have spendUsd === null, got ${usage.spendUsd}`,
    );
  }
  if (usage.costBasis !== "unknown" && usage.spendUsd === null) {
    throw new UsageIntegrityError(
      `usage with costBasis "${usage.costBasis}" must carry a spendUsd figure; ` +
        `use costBasis "unknown" when no figure is available`,
    );
  }
  if (usage.requests < 0) throw new UsageIntegrityError("usage.requests must not be negative");
  if ((usage.spendUsd ?? 0) < 0) throw new UsageIntegrityError("usage.spendUsd must not be negative");
}

/** A `Usage` value that contradicts itself was offered to the ledger. */
export class UsageIntegrityError extends StoreError {
  constructor(message: string) {
    super("KORWF_USAGE_INTEGRITY", `Dishonest usage record: ${message} (PLAN §3.I, issue #30).`);
  }
}

// ---------------------------------------------------------------------------
// Scopes and remaining budget
// ---------------------------------------------------------------------------

/** What a charge is attributed to. Enclosing scopes are implied by the ids. */
export interface ChargeScope {
  readonly workflowId: WorkflowId;
  readonly phaseId?: PhaseId | null;
  readonly taskId?: TaskId | null;
  readonly attemptId?: AttemptId | null;
}

/** Remaining headroom under one cap. `null` limit = uncapped. */
export interface CapStatus {
  readonly limit: number | null;
  readonly used: number;
  /** `null` when uncapped. Never negative. */
  readonly remaining: number | null;
}

/** Budget state of one scope, for `/korwf status` and the pre-run estimate. */
export interface ScopeStatus {
  readonly scope: BudgetScopeKind;
  readonly id: string;
  readonly spendUsd: CapStatus;
  readonly tokens: CapStatus;
  readonly requests: CapStatus;
  readonly concurrency: CapStatus;
  readonly elapsedMs: CapStatus;
  /**
   * Requests whose cost could not be priced. Reported separately so a report
   * never presents unknown spend as `$0.00` (issue #30 AC 2).
   */
  readonly unknownCostRequests: number;
  /** Portion of `spendUsd.used` that came from pre-call estimates. */
  readonly estimatedSpendUsd: number;
  /** Portion of `spendUsd.used` reported by the provider. */
  readonly knownSpendUsd: number;
  /** `true` when at least one charge in this scope has unknown cost. */
  readonly hasUnknownCost: boolean;
}

/** Everything the status API knows about the scopes a charge would touch. */
export interface LedgerStatus {
  readonly scopes: readonly ScopeStatus[];
  /** `true` when any scope carries an unpriced charge. */
  readonly hasUnknownCost: boolean;
}

/** A live reservation handle. Settle or release it; do not hold it across a restart. */
export interface Reservation {
  readonly id: ReservationId;
  readonly entryId: LedgerEntryId;
  readonly scope: LedgerScope;
  readonly channel: UsageChannel;
  /** The estimate that was charged against the caps while the call runs. */
  readonly estimate: Usage;
  readonly reservedAt: IsoTimestamp;
}

/** Which scope levels a channel is capped by. Jev spend is its own channel (PLAN §2.6). */
function scopeKindsFor(channel: UsageChannel): readonly BudgetScopeKind[] {
  return channel === "jev" ? ["jev", ...SCOPE_ORDER] : SCOPE_ORDER;
}

/** Column and id the ledger aggregates on for a scope kind, or `null` if absent. */
function scopeTarget(
  kind: BudgetScopeKind,
  scope: LedgerScope,
): { readonly column: LedgerScopeColumn; readonly id: string } | null {
  switch (kind) {
    case "workflow":
    case "jev":
      // The Jev cap is per workflow, on the `jev` channel only.
      return { column: "workflowId", id: scope.workflowId };
    case "phase":
      return scope.phaseId === null ? null : { column: "phaseId", id: scope.phaseId };
    case "task":
      return scope.taskId === null ? null : { column: "taskId", id: scope.taskId };
  }
}

/** Cap set for a scope kind, straight from the config `budgets` section. */
function capsFor(budgets: BudgetsConfig, kind: BudgetScopeKind): Budget {
  return budgets[kind];
}

function remaining(limit: number | null, used: number): CapStatus {
  if (limit === null) return { limit: null, used, remaining: null };
  return { limit, used, remaining: Math.max(0, limit - used) };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface LedgerOptions {
  /** Caps, from `loadConfig().config.budgets` (#21). Never redefined here. */
  readonly budgets: BudgetsConfig;
  /** Clock; injected in tests. */
  readonly now?: () => IsoTimestamp;
  /** Id factory for ledger rows and reservations; injected in tests. */
  readonly newId?: () => string;
  /**
   * Identifies this coordinator session. Reservations carrying a different
   * session id at startup were left by a process that died (see `reconcile`).
   */
  readonly sessionId?: string;
}

let ledgerIdCounter = 0;
function defaultLedgerId(): string {
  ledgerIdCounter += 1;
  return `led-${Date.now().toString(36)}-${process.pid.toString(36)}-${ledgerIdCounter.toString(36)}`;
}

/**
 * Usage accounting over the #23 store.
 *
 * All mutation goes through `store.write()`, so a reservation's cap check and
 * its insert share one `BEGIN IMMEDIATE` transaction. Concurrency is
 * therefore decided by SQLite, not by this class: whichever writer commits
 * first is the one whose row the other sees.
 */
export class Ledger {
  readonly sessionId: string;

  readonly #store: Store;
  readonly #budgets: BudgetsConfig;
  readonly #now: () => IsoTimestamp;
  readonly #newId: () => string;

  constructor(store: Store, options: LedgerOptions) {
    this.#store = store;
    this.#budgets = options.budgets;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? defaultLedgerId;
    this.sessionId = options.sessionId ?? `${process.pid}`;
  }

  /** Caps in force, as loaded from config. Read-only view for reports. */
  get budgets(): BudgetsConfig {
    return this.#budgets;
  }

  /**
   * Reserve budget for a call that is about to run.
   *
   * Atomic: the cap check and the insert happen inside one write transaction,
   * so N concurrent workers against a cap of M produce at most M reservations
   * (issue #30 AC 1). Throws `BudgetExceededError` and writes nothing when any
   * enclosing cap would be breached.
   */
  reserve(params: {
    readonly scope: ChargeScope;
    readonly channel?: UsageChannel;
    /** Pre-call estimate. `unknown` cost is fine and still consumes caps. */
    readonly estimate: Usage;
    readonly label?: string;
  }): Reservation {
    const estimate = params.estimate;
    assertHonestUsage(estimate);
    const channel = params.channel ?? "model";
    const scope = normaliseScope(params.scope);
    return this.#store.write(() => {
      this.#assertWithinCaps(scope, channel, estimate);
      const reservationId = this.#newId() as ReservationId;
      const at = this.#now();
      const row = this.#append({
        id: reservationId,
        at,
        scope,
        channel,
        entryKind: "reservation",
        reservationId,
        usage: estimate,
        elapsedMs: 0,
        label: params.label ?? null,
        reason: null,
      });
      return {
        id: reservationId,
        entryId: row.id,
        scope,
        channel,
        estimate,
        reservedAt: at,
      };
    });
  }

  /**
   * Close a reservation with what the call actually used. The reservation's
   * estimate stops counting and the actuals take its place.
   */
  settle(
    reservation: Reservation,
    actual: Usage,
    options: { readonly elapsedMs?: number; readonly reason?: string } = {},
  ): LedgerEntry {
    assertHonestUsage(actual);
    return this.#store.write(() => {
      this.#assertOpen(reservation.id);
      return this.#append({
        id: this.#newId(),
        at: this.#now(),
        scope: reservation.scope,
        channel: reservation.channel,
        entryKind: "settlement",
        reservationId: reservation.id,
        usage: actual,
        elapsedMs: options.elapsedMs ?? 0,
        label: null,
        reason: options.reason ?? null,
      });
    });
  }

  /** Give a reservation back: the call never ran, so it used nothing. */
  release(reservation: Reservation, reason: string): LedgerEntry {
    return this.#store.write(() => {
      this.#assertOpen(reservation.id);
      return this.#append({
        id: this.#newId(),
        at: this.#now(),
        scope: reservation.scope,
        channel: reservation.channel,
        entryKind: "release",
        reservationId: reservation.id,
        usage: noUsage(),
        elapsedMs: 0,
        label: null,
        reason,
      });
    });
  }

  /** Reserve, run, settle — releasing the reservation if `run` throws. */
  async withReservation(
    params: Parameters<Ledger["reserve"]>[0],
    run: (
      reservation: Reservation,
    ) =>
      | Promise<{ readonly usage: Usage; readonly elapsedMs?: number }>
      | { readonly usage: Usage; readonly elapsedMs?: number },
  ): Promise<LedgerEntry> {
    const reservation = this.reserve(params);
    let result: { readonly usage: Usage; readonly elapsedMs?: number };
    try {
      result = await run(reservation);
    } catch (error) {
      this.release(reservation, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return this.settle(reservation, result.usage, { elapsedMs: result.elapsedMs ?? 0 });
  }

  /**
   * Remaining budget per scope, for `/korwf status` and the pre-run estimate
   * (PLAN §2.6, §3.I "budgets, running cost").
   */
  status(scope: ChargeScope, channel: UsageChannel = "model"): LedgerStatus {
    const resolved = normaliseScope(scope);
    const scopes: ScopeStatus[] = [];
    for (const kind of scopeKindsFor(channel)) {
      const target = scopeTarget(kind, resolved);
      if (target === null) continue;
      scopes.push(this.#statusFor(kind, target, kind === "jev" ? "jev" : undefined));
    }
    return { scopes, hasUnknownCost: scopes.some((s) => s.hasUnknownCost) };
  }

  /** Status of one scope kind alone. `null` when that scope is not in play. */
  scopeStatus(
    kind: BudgetScopeKind,
    scope: ChargeScope,
  ): ScopeStatus | null {
    const target = scopeTarget(kind, normaliseScope(scope));
    if (target === null) return null;
    return this.#statusFor(kind, target, kind === "jev" ? "jev" : undefined);
  }

  #statusFor(
    kind: BudgetScopeKind,
    target: { readonly column: LedgerScopeColumn; readonly id: string },
    channel: UsageChannel | undefined,
  ): ScopeStatus {
    const caps = capsFor(this.#budgets, kind);
    const totals = this.#store.ledger.committedTotals(target.column, target.id, channel);
    const open = this.#store.ledger.openCount(target.column, target.id, channel);
    return {
      scope: kind,
      id: target.id,
      spendUsd: remaining(caps.maxSpendUsd, totals.spendUsd),
      tokens: remaining(caps.maxTokens, totals.tokens),
      requests: remaining(caps.maxRequests, totals.requests),
      concurrency: remaining(caps.maxConcurrency, open),
      elapsedMs: remaining(caps.maxElapsedMs, totals.elapsedMs),
      unknownCostRequests: totals.unknownCostRequests,
      estimatedSpendUsd: totals.estimatedSpendUsd,
      knownSpendUsd: totals.knownSpendUsd,
      hasUnknownCost: totals.unknownCostRequests > 0,
    };
  }

  /**
   * Cap check. Runs inside the caller's write transaction; every read below
   * therefore sees a snapshot no other writer can change before the matching
   * insert commits.
   */
  #assertWithinCaps(scope: LedgerScope, channel: UsageChannel, estimate: Usage): void {
    for (const kind of scopeKindsFor(channel)) {
      const target = scopeTarget(kind, scope);
      if (target === null) continue;
      const caps = capsFor(this.#budgets, kind);
      const channelFilter = kind === "jev" ? "jev" : undefined;
      const totals = this.#store.ledger.committedTotals(target.column, target.id, channelFilter);
      const open = this.#store.ledger.openCount(target.column, target.id, channelFilter);
      // Unknown cost contributes nothing to `spendUsd` — it is not zero, it is
      // unmeasured — but it still consumes requests, tokens and concurrency.
      check(kind, "maxSpendUsd", caps.maxSpendUsd, totals.spendUsd, estimate.spendUsd ?? 0);
      check(kind, "maxTokens", caps.maxTokens, totals.tokens, tokensOf(estimate));
      check(kind, "maxRequests", caps.maxRequests, totals.requests, estimate.requests);
      check(kind, "maxConcurrency", caps.maxConcurrency, open, 1);
      check(kind, "maxElapsedMs", caps.maxElapsedMs, totals.elapsedMs, 0);
    }
  }

  /** Refuse to settle or release a reservation that is already closed. */
  #assertOpen(reservationId: ReservationId): void {
    const rows = this.#store.ledger.forReservation(reservationId);
    if (rows.length === 0) {
      throw new UsageIntegrityError(`no reservation ${reservationId} exists`);
    }
    const terminal = rows.find((row) => row.entryKind !== "reservation");
    if (terminal !== undefined) {
      throw new UsageIntegrityError(
        `reservation ${reservationId} was already closed as "${terminal.entryKind}"; ` +
          "ledger rows are append-only and a reservation settles exactly once",
      );
    }
  }

  #append(params: {
    readonly id: string;
    readonly at: IsoTimestamp;
    readonly scope: LedgerScope;
    readonly channel: UsageChannel;
    readonly entryKind: LedgerEntry["entryKind"];
    readonly reservationId: ReservationId;
    readonly usage: Usage;
    readonly elapsedMs: number;
    readonly label: string | null;
    readonly reason: string | null;
  }): LedgerEntry {
    return this.#store.ledger.insert({
      id: params.id as LedgerEntryId,
      createdAt: params.at,
      updatedAt: params.at,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      kind: "append_only",
      scope: params.scope,
      channel: params.channel,
      entryKind: params.entryKind,
      reservationId: params.reservationId,
      sessionId: this.sessionId,
      usage: params.usage,
      elapsedMs: params.elapsedMs,
      label: params.label,
      reason: params.reason,
    });
  }
}

function tokensOf(usage: Usage): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function check(
  scope: BudgetScopeKind,
  cap: keyof Budget,
  limit: number | null,
  committed: number,
  requested: number,
): void {
  if (limit === null) return;
  if (committed + requested > limit) {
    throw new BudgetExceededError({ scope, cap, limit, committed, requested });
  }
}

function normaliseScope(scope: ChargeScope): LedgerScope {
  return {
    workflowId: scope.workflowId,
    phaseId: scope.phaseId ?? null,
    taskId: scope.taskId ?? null,
    attemptId: scope.attemptId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Startup reconciliation (issue #30 AC 3)
// ---------------------------------------------------------------------------

/** One reservation closed by reconciliation. Re-exported from the store half. */
export type AbandonedReservation = AbandonedReservationRow;

export interface LedgerReconciliationReport {
  readonly at: IsoTimestamp;
  readonly examined: number;
  readonly abandoned: number;
  readonly reservations: readonly AbandonedReservation[];
}

export { LEDGER_ABANDONED_REASON };

export interface LedgerReconcileOptions {
  /**
   * Reservations belonging to this session are left alone — they are the
   * current process's own in-flight calls. Defaults to the ledger's session,
   * which is why reconciliation is safe to run at any time.
   */
  readonly keepSessionId?: string;
  readonly now?: () => IsoTimestamp;
  readonly newId?: () => string;
}

/**
 * Close every reservation left open by a previous session as `abandoned`
 * (issue #30 AC 3; the ledger half of ADR 0006 rule 7).
 *
 * The estimate is *kept*, not refunded: a call that was reserved and never
 * settled may well have run and cost money, and quietly returning the budget
 * would let a crash loop spend without limit. The row is labelled
 * `abandonment` so reports can say so honestly.
 *
 * Idempotent: a second run finds nothing, because the abandonment row is
 * itself the terminal row.
 */
export function reconcileAbandonedReservations(
  ledger: Ledger,
  store: Store,
  options: LedgerReconcileOptions = {},
): LedgerReconciliationReport {
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();
  const keep = options.keepSessionId ?? ledger.sessionId;
  const closed = store.write(() =>
    reconcileOpenReservations(store.ledger, {
      keepSessionId: keep,
      now: () => at,
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    }),
  );
  return { at, examined: closed.length, abandoned: closed.length, reservations: closed };
}

/** Convenience constructor used by the extension and tests. */
export function openLedger(store: Store, options: LedgerOptions): Ledger {
  return new Ledger(store, options);
}
