/**
 * Fixtures for the usage ledger tests (issue #30).
 *
 * Budgets come from the real config layer (`defaultConfig()` over
 * `src/config/schema.json`), not from hand-written literals, so a test can
 * never pass against caps the product does not actually ship.
 */
import { defaultConfig } from "../../src/config/load.ts";
import type { BudgetsConfig } from "../../src/config/types.ts";
import type { Budget, Usage } from "../../src/storage/records.ts";
import { openStore, type Store } from "../../src/storage/db.ts";
import { Ledger } from "../../src/telemetry/ledger.ts";
import { makeTempDir, type TempDir } from "./temp-dir.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "./records.ts";

/** Every cap off. Tests switch on exactly the cap they exercise. */
export const NO_CAPS: Budget = Object.freeze({
  maxSpendUsd: null,
  maxTokens: null,
  maxRequests: null,
  maxConcurrency: null,
  maxElapsedMs: null,
});

/** Shipped budgets from schema.json, as `loadConfig` would produce them. */
export function shippedBudgets(): BudgetsConfig {
  return defaultConfig().budgets;
}

/** Shipped budgets with every cap cleared, then the given overrides applied. */
export function budgetsWith(overrides: Partial<Record<keyof BudgetsConfig, Partial<Budget>>>): BudgetsConfig {
  const base = shippedBudgets();
  return {
    workflow: { ...NO_CAPS, ...overrides.workflow },
    phase: { ...NO_CAPS, ...overrides.phase },
    task: { ...NO_CAPS, ...overrides.task },
    jev: { ...NO_CAPS, ...overrides.jev },
    costEstimateBeforeRun: base.costEstimateBeforeRun,
  };
}

/** Usage with a provider-reported charge. */
export function knownUsage(spendUsd: number, tokens = 10): Usage {
  return { inputTokens: tokens, outputTokens: tokens, requests: 1, spendUsd, costBasis: "known" };
}

/** Usage projected from a model card before the call runs. */
export function estimatedUsage(spendUsd: number, tokens = 10): Usage {
  return { inputTokens: tokens, outputTokens: tokens, requests: 1, spendUsd, costBasis: "estimated" };
}

export interface LedgerFixture {
  readonly store: Store;
  readonly ledger: Ledger;
  readonly dir: TempDir;
  readonly cleanup: () => void;
}

/** A store seeded with workflow → phase → task → attempt, plus a ledger. */
export function makeLedgerFixture(options: {
  readonly budgets: BudgetsConfig;
  readonly sessionId?: string;
  readonly prefix?: string;
}): LedgerFixture {
  const dir = makeTempDir(options.prefix ?? "korwf-ledger-");
  const { store } = openStore({ storageRoot: dir.path, reconcile: false });
  seed(store);
  let counter = 0;
  const ledger = new Ledger(store, {
    budgets: options.budgets,
    now: () => "2026-03-03T00:00:00.000Z",
    newId: () => `res-${(counter += 1)}`,
    sessionId: options.sessionId ?? "session-under-test",
  });
  return {
    store,
    ledger,
    dir,
    cleanup: () => {
      store.close();
      dir.cleanup();
    },
  };
}

/** Insert the foreign-key parents every ledger row needs. */
export function seed(store: Store): void {
  store.workflows.insert(makeWorkflow());
  store.phases.insert(makePhase());
  store.tasks.insert(makeTask());
  store.attempts.insert(makeAttempt());
}
