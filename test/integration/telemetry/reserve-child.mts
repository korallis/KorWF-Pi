/**
 * Helper process for `concurrent-reservations.test.ts` (issue #30).
 *
 * Opens the *same* store as its siblings and tries to take `--attempts`
 * reservations of 1 USD each against a shared cap, then prints one JSON line
 * with how many it was granted. The parent asserts the granted total across
 * every process equals the cap exactly: two workers must never both pass the
 * same remaining budget.
 *
 * Each process waits for the coordinator lock (ADR 0006 rule 1), so the
 * interleaving is real OS-level contention, not a simulation.
 */
import { openStore } from "../../../src/storage/db.ts";
import { StoreError } from "../../../src/storage/errors.ts";
import { BudgetExceededError, Ledger } from "../../../src/telemetry/ledger.ts";
import { NO_CAPS } from "../../helpers/ledger.ts";
import type { WorkflowId } from "../../../src/storage/records.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const root = arg("root");
const cap = Number(arg("cap") ?? "10");
const attempts = Number(arg("attempts") ?? "5");
const timeout = Number(arg("timeout") ?? "20000");

if (root === undefined) {
  emit({ ok: false, message: "--root is required" });
  process.exit(2);
}

try {
  const { store } = openStore({ storageRoot: root, lockTimeoutMs: timeout, reconcile: false });
  const ledger = new Ledger(store, {
    budgets: {
      workflow: { ...NO_CAPS, maxSpendUsd: cap },
      phase: NO_CAPS,
      task: NO_CAPS,
      jev: NO_CAPS,
      costEstimateBeforeRun: false,
    },
    sessionId: `child-${process.pid}`,
  });

  let granted = 0;
  let refused = 0;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const reservation = ledger.reserve({
        scope: { workflowId: "wf-1" as WorkflowId },
        estimate: { inputTokens: 1, outputTokens: 1, requests: 1, spendUsd: 1, costBasis: "known" },
      });
      ledger.settle(reservation, {
        inputTokens: 1,
        outputTokens: 1,
        requests: 1,
        spendUsd: 1,
        costBasis: "known",
      });
      granted += 1;
    } catch (error) {
      if (error instanceof BudgetExceededError) refused += 1;
      else throw error;
    }
  }
  store.close();
  emit({ ok: true, pid: process.pid, granted, refused });
  process.exit(0);
} catch (error) {
  emit({
    ok: false,
    code: error instanceof StoreError ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
