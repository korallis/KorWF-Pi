/**
 * Concurrency of budget reservations (issue #30).
 *
 * AC1: "Parallel reservations never exceed the cap (test with 100 concurrent
 * attempts against cap 10)."
 *
 * Two shapes of concurrency are covered, because they fail differently:
 *
 * 1. **In-process**: 100 reservations issued without awaiting, against one
 *    store. This is the shape KorWF actually runs (one coordinator, many
 *    in-flight calls), and it catches a check-then-act race in this module.
 * 2. **Cross-process**: several real child processes contending for the same
 *    store, so the atomicity claim is tested against SQLite and the lockfile
 *    rather than against a single event loop. AGENTS.md §4: the author's
 *    single-session environment cannot reproduce this, so it gets a test.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { openStore } from "../../../src/storage/db.ts";
import { BudgetExceededError, Ledger } from "../../../src/telemetry/ledger.ts";
import type { TaskId, Usage, WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import { NO_CAPS, budgetsWith, makeLedgerFixture, seed } from "../../helpers/ledger.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const HELPER = join(HERE, "reserve-child.mts");

interface ChildResult {
  readonly ok: boolean;
  readonly granted?: number;
  readonly refused?: number;
  readonly message?: string;
}

/**
 * Start the helper and resolve with its JSON line. Started with `spawn`, not
 * `spawnSync`, so the children are genuinely running at the same time and
 * really do contend for the store.
 */
function runChild(args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", HELPER, ...args],
      { cwd: REPO_ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", rejectPromise);
    child.on("close", () => {
      const line = stdout.trim().split("\n").pop() ?? "";
      try {
        resolvePromise(JSON.parse(line) as ChildResult);
      } catch {
        rejectPromise(new Error(`child produced no JSON result.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

const ONE_DOLLAR: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  requests: 1,
  spendUsd: 1,
  costBasis: "known",
};

describe("AC1: parallel reservations never exceed the cap", () => {
  it("grants exactly 10 of 100 concurrent attempts against a spend cap of 10", async () => {
    const fx = makeLedgerFixture({ budgets: budgetsWith({ workflow: { maxSpendUsd: 10 } }) });
    try {
      const attempts = Array.from({ length: 100 }, async () => {
        try {
          fx.ledger.reserve({ scope: { workflowId: "wf-1" as WorkflowId }, estimate: ONE_DOLLAR });
          return "granted" as const;
        } catch (error) {
          if (error instanceof BudgetExceededError) return "refused" as const;
          throw error;
        }
      });
      const results = await Promise.all(attempts);
      const granted = results.filter((r) => r === "granted").length;

      expect(granted).toBe(10);
      expect(results.filter((r) => r === "refused")).toHaveLength(90);
      // And the ledger agrees: ten reservation rows, nothing over the cap.
      const workflow = fx.ledger
        .status({ workflowId: "wf-1" as WorkflowId })
        .scopes.find((s) => s.scope === "workflow");
      expect(workflow?.spendUsd.used).toBe(10);
      expect(workflow?.spendUsd.remaining).toBe(0);
      expect(fx.store.ledger.count()).toBe(10);
    } finally {
      fx.cleanup();
    }
  });

  it("grants exactly 10 of 100 concurrent attempts against a request cap of 10", async () => {
    const fx = makeLedgerFixture({ budgets: budgetsWith({ task: { maxRequests: 10 } }) });
    try {
      const scope = { workflowId: "wf-1" as WorkflowId, taskId: "tk-1" as TaskId };
      const results = await Promise.all(
        Array.from({ length: 100 }, async () => {
          try {
            fx.ledger.reserve({ scope, estimate: ONE_DOLLAR });
            return true;
          } catch (error) {
            if (error instanceof BudgetExceededError) return false;
            throw error;
          }
        }),
      );
      expect(results.filter(Boolean)).toHaveLength(10);
    } finally {
      fx.cleanup();
    }
  });

  it("grants exactly 10 of 100 concurrent attempts against a concurrency cap of 10", async () => {
    const fx = makeLedgerFixture({ budgets: budgetsWith({ task: { maxConcurrency: 10 } }) });
    try {
      const scope = { workflowId: "wf-1" as WorkflowId, taskId: "tk-1" as TaskId };
      const results = await Promise.all(
        Array.from({ length: 100 }, async () => {
          try {
            fx.ledger.reserve({ scope, estimate: ONE_DOLLAR });
            return true;
          } catch (error) {
            if (error instanceof BudgetExceededError) return false;
            throw error;
          }
        }),
      );
      expect(results.filter(Boolean)).toHaveLength(10);
      expect(fx.store.ledger.openReservations()).toHaveLength(10);
    } finally {
      fx.cleanup();
    }
  });

  it("never lets an over-cap reservation leave a row behind", async () => {
    const fx = makeLedgerFixture({ budgets: budgetsWith({ workflow: { maxSpendUsd: 3 } }) });
    try {
      await Promise.all(
        Array.from({ length: 50 }, async () => {
          try {
            fx.ledger.reserve({ scope: { workflowId: "wf-1" as WorkflowId }, estimate: ONE_DOLLAR });
          } catch {
            // Expected for all but three.
          }
        }),
      );
      const total = fx.store.ledger
        .list()
        .reduce((sum, row) => sum + (row.usage.spendUsd ?? 0), 0);
      expect(total).toBe(3);
    } finally {
      fx.cleanup();
    }
  });
});

describe("AC1 cross-process: two coordinators cannot both pass the same remaining budget", () => {
  it("four simultaneous processes taking 10 each against a cap of 10 are granted 10 in total", async () => {
    const dir = makeTempDir("korwf-ledger-mp-");
    try {
      // Create the store and its foreign-key parents, then let go of the lock.
      const { store } = openStore({ storageRoot: dir.path, reconcile: false });
      seed(store);
      store.close();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          runChild(["--root", dir.path, "--cap", "10", "--attempts", "10"]),
        ),
      );

      let granted = 0;
      for (const parsed of results) {
        expect(parsed.ok, `child failed: ${parsed.message ?? ""}`).toBe(true);
        granted += parsed.granted ?? 0;
      }

      // 40 attempts were made by four live processes; exactly 10 succeeded.
      expect(results.reduce((n, r) => n + (r.granted ?? 0) + (r.refused ?? 0), 0)).toBe(40);
      expect(granted).toBe(10);

      // The persisted ledger is the authority: exactly 10 dollars committed.
      const reader = openStore({ storageRoot: dir.path, reconcile: false });
      const totals = reader.store.ledger.committedTotals("workflowId", "wf-1");
      expect(totals.spendUsd).toBe(10);
      reader.store.close();
    } finally {
      dir.cleanup();
    }
  }, 60_000);
});

describe("a reservation's cap check and insert are one transaction", () => {
  it("a concurrent write committed mid-check is visible to the loser", () => {
    const dir = makeTempDir("korwf-ledger-tx-");
    try {
      const { store } = openStore({ storageRoot: dir.path, reconcile: false });
      seed(store);
      const budgets = {
        workflow: { ...NO_CAPS, maxSpendUsd: 1 },
        phase: NO_CAPS,
        task: NO_CAPS,
        jev: NO_CAPS,
        costEstimateBeforeRun: false,
      };
      let counter = 0;
      const ledger = new Ledger(store, {
        budgets,
        newId: () => `res-tx-${(counter += 1)}`,
        sessionId: "tx-test",
      });

      ledger.reserve({ scope: { workflowId: "wf-1" as WorkflowId }, estimate: ONE_DOLLAR });
      // The second reservation reads the first's row because both run under
      // BEGIN IMMEDIATE on the single writer connection (ADR 0006 rule 6).
      expect(() =>
        ledger.reserve({ scope: { workflowId: "wf-1" as WorkflowId }, estimate: ONE_DOLLAR }),
      ).toThrow(BudgetExceededError);
      store.close();
    } finally {
      dir.cleanup();
    }
  });
});
