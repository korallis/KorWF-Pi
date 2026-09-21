/**
 * Usage accounting and budget reservations (issue #30).
 *
 * Test names reference the acceptance criterion they exercise:
 *   AC1 parallel reservations never exceed the cap
 *   AC2 unknown-cost calls appear as unknown, not 0
 *   AC3 a reservation without settlement is reconciled on startup as abandoned
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  BudgetExceededError,
  Ledger,
  UsageIntegrityError,
  classifyCost,
  hasUsablePrice,
  noUsage,
  unknownUsage,
} from "../../../src/telemetry/ledger.ts";
import type { WorkflowId, PhaseId, TaskId, AttemptId } from "../../../src/storage/records.ts";
import {
  budgetsWith,
  estimatedUsage,
  knownUsage,
  makeLedgerFixture,
  shippedBudgets,
  type LedgerFixture,
} from "../../helpers/ledger.ts";

const SCOPE = {
  workflowId: "wf-1" as WorkflowId,
  phaseId: "ph-1" as PhaseId,
  taskId: "tk-1" as TaskId,
  attemptId: "at-1" as AttemptId,
};

const fixtures: LedgerFixture[] = [];

function fixture(budgets: Parameters<typeof makeLedgerFixture>[0]["budgets"], sessionId?: string): LedgerFixture {
  const made = makeLedgerFixture(sessionId === undefined ? { budgets } : { budgets, sessionId });
  fixtures.push(made);
  return made;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

// ---------------------------------------------------------------------------
// Cost classification (AC2 foundation)
// ---------------------------------------------------------------------------

describe("AC2: cost is known, estimated or unknown — never silently zero", () => {
  it("treats absent price metadata as unknown, not free", () => {
    const usage = classifyCost({ tokens: { inputTokens: 100, outputTokens: 20 }, basis: "known" });
    expect(usage.costBasis).toBe("unknown");
    expect(usage.spendUsd).toBeNull();
  });

  it("treats a zero price (a proxy with no figure) as unknown, not free", () => {
    const usage = classifyCost({
      tokens: { inputTokens: 100, outputTokens: 20 },
      price: { inputPerToken: 0, outputPerToken: 0 },
      basis: "known",
    });
    expect(usage.costBasis).toBe("unknown");
    expect(usage.spendUsd).toBeNull();
    expect(hasUsablePrice({ inputPerToken: 0, outputPerToken: 0 })).toBe(false);
  });

  it("treats a null price alongside a real one as partially priced, still known", () => {
    const usage = classifyCost({
      tokens: { inputTokens: 100, outputTokens: 20 },
      price: { inputPerToken: 0.001, outputPerToken: null },
      basis: "known",
    });
    expect(usage.costBasis).toBe("known");
    expect(usage.spendUsd).toBeCloseTo(0.1, 10);
  });

  it("keeps a provider-reported charge of exactly 0 as known zero spend", () => {
    // A provider that positively says "this cost nothing" is different from
    // one that says nothing at all.
    const usage = classifyCost({ tokens: { inputTokens: 5 }, reportedSpendUsd: 0, basis: "known" });
    expect(usage.costBasis).toBe("known");
    expect(usage.spendUsd).toBe(0);
  });

  it("downgrades to unknown when the rate is known but the token count is not", () => {
    const usage = classifyCost({ price: { inputPerToken: 0.002 }, basis: "estimated" });
    expect(usage.costBasis).toBe("unknown");
    expect(usage.spendUsd).toBeNull();
  });

  it("labels a pre-call projection as estimated", () => {
    const usage = classifyCost({
      tokens: { inputTokens: 1000, outputTokens: 500 },
      price: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
      basis: "estimated",
    });
    expect(usage.costBasis).toBe("estimated");
    expect(usage.spendUsd).toBeCloseTo(0.002, 10);
  });

  it("rejects a usage record that claims unknown cost and a dollar figure", () => {
    const fx = fixture(budgetsWith({}));
    expect(() =>
      fx.ledger.reserve({
        scope: SCOPE,
        estimate: { inputTokens: 1, outputTokens: 1, requests: 1, spendUsd: 0, costBasis: "unknown" },
      }),
    ).toThrow(UsageIntegrityError);
  });

  it("rejects a usage record that claims known cost with no figure", () => {
    const fx = fixture(budgetsWith({}));
    expect(() =>
      fx.ledger.reserve({
        scope: SCOPE,
        estimate: { inputTokens: 1, outputTokens: 1, requests: 1, spendUsd: null, costBasis: "known" },
      }),
    ).toThrow(UsageIntegrityError);
  });
});

describe("AC2: unknown-cost calls are reported as unknown, not as 0 spend", () => {
  it("counts an unknown-cost call in requests and flags it, leaving spend unmeasured", () => {
    const fx = fixture(budgetsWith({ workflow: { maxSpendUsd: 10, maxRequests: 100 } }));
    const reservation = fx.ledger.reserve({ scope: SCOPE, estimate: unknownUsage() });
    fx.ledger.settle(reservation, unknownUsage());

    const status = fx.ledger.status(SCOPE);
    const workflow = status.scopes.find((s) => s.scope === "workflow");
    expect(workflow?.requests.used).toBe(1);
    expect(workflow?.unknownCostRequests).toBe(1);
    expect(workflow?.hasUnknownCost).toBe(true);
    expect(status.hasUnknownCost).toBe(true);
    // Spend is untouched: an unknown cost is not a zero cost, so the remaining
    // spend figure is explicitly qualified by `unknownCostRequests`.
    expect(workflow?.spendUsd.used).toBe(0);
    expect(workflow?.spendUsd.remaining).toBe(10);
  });

  it("keeps known, estimated and unknown spend separable in the same scope", () => {
    const fx = fixture(budgetsWith({ workflow: { maxSpendUsd: 10 } }));
    settled(fx, knownUsage(1));
    settled(fx, estimatedUsage(2));
    settled(fx, unknownUsage());

    const workflow = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(workflow?.knownSpendUsd).toBeCloseTo(1, 10);
    expect(workflow?.estimatedSpendUsd).toBeCloseTo(2, 10);
    expect(workflow?.unknownCostRequests).toBe(1);
    expect(workflow?.spendUsd.used).toBeCloseTo(3, 10);
  });

  it("stores unknown cost as NULL spend in the database, not 0", () => {
    const fx = fixture(budgetsWith({}));
    settled(fx, unknownUsage());
    const rows = fx.store.connection
      .prepare("SELECT spendUsd, costBasis FROM ledger_entry WHERE costBasis = 'unknown'")
      .all() as unknown as { spendUsd: number | null; costBasis: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.spendUsd).toBeNull();
  });

  it("the database refuses a row that labels a dollar figure as unknown", () => {
    const fx = fixture(budgetsWith({}));
    expect(() =>
      fx.store.connection
        .prepare(
          "INSERT INTO ledger_entry (id, createdAt, updatedAt, schemaVersion, workflowId, channel, " +
            "entryKind, reservationId, sessionId, requests, spendUsd, costBasis, elapsedMs, payload) " +
            "VALUES ('x','t','t',1,'wf-1','model','reservation','r','s',1,0.5,'unknown',0,'{}')",
        )
        .run(),
    ).toThrow();
  });
});

/** Reserve + settle in one step; returns nothing the tests need. */
function settled(fx: LedgerFixture, usage: ReturnType<typeof knownUsage>): void {
  const reservation = fx.ledger.reserve({ scope: SCOPE, estimate: usage });
  fx.ledger.settle(reservation, usage);
}

// ---------------------------------------------------------------------------
// Caps come from config, not from this module
// ---------------------------------------------------------------------------

describe("budget caps are read from the config `budgets` section (#21 / schema.json)", () => {
  it("uses the shipped workflow spend cap without redefining it", () => {
    const budgets = shippedBudgets();
    const fx = fixture(budgets);
    expect(fx.ledger.budgets.workflow.maxSpendUsd).toBe(budgets.workflow.maxSpendUsd);
    const workflow = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(workflow?.spendUsd.limit).toBe(budgets.workflow.maxSpendUsd);
  });

  it("reports no limit for an uncapped dimension rather than inventing one", () => {
    const fx = fixture(budgetsWith({}));
    const workflow = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(workflow?.spendUsd.limit).toBeNull();
    expect(workflow?.spendUsd.remaining).toBeNull();
  });

  it("charges Jev calls to the separate jev channel as well as the workflow", () => {
    const fx = fixture(budgetsWith({ jev: { maxSpendUsd: 1 }, workflow: { maxSpendUsd: 10 } }));
    const reservation = fx.ledger.reserve({ scope: SCOPE, channel: "jev", estimate: knownUsage(0.4) });
    fx.ledger.settle(reservation, knownUsage(0.4));

    const jev = fx.ledger.status(SCOPE, "jev").scopes.find((s) => s.scope === "jev");
    expect(jev?.spendUsd.used).toBeCloseTo(0.4, 10);
    expect(jev?.spendUsd.remaining).toBeCloseTo(0.6, 10);
    // And it also counts against the overall workflow spend.
    const workflow = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(workflow?.spendUsd.used).toBeCloseTo(0.4, 10);
  });

  it("does not charge a model call against the jev cap", () => {
    const fx = fixture(budgetsWith({ jev: { maxSpendUsd: 1 } }));
    settled(fx, knownUsage(0.9));
    const jev = fx.ledger.scopeStatus("jev", SCOPE);
    expect(jev?.spendUsd.used).toBe(0);
  });
});

describe("reserve() refuses a call that would breach any enclosing cap", () => {
  it("refuses on the workflow spend cap and writes nothing", () => {
    const fx = fixture(budgetsWith({ workflow: { maxSpendUsd: 1 } }));
    settled(fx, knownUsage(0.8));
    const before = fx.store.ledger.count();
    expect(() => fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.5) })).toThrow(
      BudgetExceededError,
    );
    expect(fx.store.ledger.count()).toBe(before);
  });

  it("refuses on an inner task cap even when the workflow has room", () => {
    const fx = fixture(budgetsWith({ workflow: { maxRequests: 100 }, task: { maxRequests: 1 } }));
    settled(fx, knownUsage(0.1));
    let error: unknown;
    try {
      fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).scope).toBe("task");
    expect((error as BudgetExceededError).cap).toBe("maxRequests");
  });

  it("counts unknown-cost calls against the request cap", () => {
    const fx = fixture(budgetsWith({ task: { maxRequests: 2 } }));
    settled(fx, unknownUsage());
    settled(fx, unknownUsage());
    expect(() => fx.ledger.reserve({ scope: SCOPE, estimate: unknownUsage() })).toThrow(
      BudgetExceededError,
    );
  });

  it("counts tokens across input and output against the token cap", () => {
    const fx = fixture(budgetsWith({ workflow: { maxTokens: 40 } }));
    settled(fx, knownUsage(0.1, 10)); // 20 tokens
    expect(() => fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1, 15) })).toThrow(
      BudgetExceededError,
    );
  });

  it("enforces the concurrency cap on open reservations", () => {
    const fx = fixture(budgetsWith({ task: { maxConcurrency: 1 } }));
    const first = fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1) });
    expect(() => fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1) })).toThrow(
      BudgetExceededError,
    );
    // Settling the first frees the slot.
    fx.ledger.settle(first, knownUsage(0.1));
    expect(() => fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1) })).not.toThrow();
  });

  it("refuses a new reservation once the elapsed-time cap is spent", () => {
    const fx = fixture(budgetsWith({ task: { maxElapsedMs: 1000 } }));
    const first = fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1) });
    // Elapsed time is only knowable after the fact, so it is charged on
    // settlement and gates the *next* reservation.
    fx.ledger.settle(first, knownUsage(0.1), { elapsedMs: 1500 });
    expect(() => fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1) })).toThrow(
      BudgetExceededError,
    );
  });

  it("stops charging an estimate once the call is released", () => {
    const fx = fixture(budgetsWith({ workflow: { maxSpendUsd: 1 } }));
    const reservation = fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.9) });
    fx.ledger.release(reservation, "worker never started");
    const workflow = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(workflow?.spendUsd.used).toBe(0);
    expect(() => fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.9) })).not.toThrow();
  });

  it("replaces the estimate with the actual on settlement", () => {
    const fx = fixture(budgetsWith({ workflow: { maxSpendUsd: 10 } }));
    const reservation = fx.ledger.reserve({ scope: SCOPE, estimate: estimatedUsage(5) });
    const midway = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(midway?.spendUsd.used).toBeCloseTo(5, 10);

    fx.ledger.settle(reservation, knownUsage(0.25));
    const after = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(after?.spendUsd.used).toBeCloseTo(0.25, 10);
    expect(after?.estimatedSpendUsd).toBe(0);
  });

  it("settles a reservation exactly once", () => {
    const fx = fixture(budgetsWith({}));
    const reservation = fx.ledger.reserve({ scope: SCOPE, estimate: knownUsage(0.1) });
    fx.ledger.settle(reservation, knownUsage(0.1));
    expect(() => fx.ledger.settle(reservation, knownUsage(0.1))).toThrow(UsageIntegrityError);
    expect(() => fx.ledger.release(reservation, "too late")).toThrow(UsageIntegrityError);
  });

  it("releases the reservation when the wrapped call throws", async () => {
    const fx = fixture(budgetsWith({ workflow: { maxSpendUsd: 1 } }));
    await expect(
      fx.ledger.withReservation({ scope: SCOPE, estimate: knownUsage(0.9) }, () => {
        throw new Error("model refused");
      }),
    ).rejects.toThrow("model refused");
    const workflow = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(workflow?.spendUsd.used).toBe(0);
  });

  it("settles automatically when the wrapped call succeeds", async () => {
    const fx = fixture(budgetsWith({ workflow: { maxSpendUsd: 10 } }));
    const entry = await fx.ledger.withReservation(
      { scope: SCOPE, estimate: estimatedUsage(1) },
      () => ({ usage: knownUsage(0.3), elapsedMs: 120 }),
    );
    expect(entry.entryKind).toBe("settlement");
    const workflow = fx.ledger.status(SCOPE).scopes.find((s) => s.scope === "workflow");
    expect(workflow?.spendUsd.used).toBeCloseTo(0.3, 10);
    expect(workflow?.elapsedMs.used).toBe(120);
  });
});

describe("the ledger is append-only, so spent budget cannot be erased", () => {
  it("has no update or delete method and the database aborts both", () => {
    const fx = fixture(budgetsWith({}));
    settled(fx, knownUsage(1));
    expect("update" in fx.store.ledger).toBe(false);
    expect("delete" in fx.store.ledger).toBe(false);
    expect(() => fx.store.connection.exec("UPDATE ledger_entry SET spendUsd = 0")).toThrow(
      /append-only/,
    );
    expect(() => fx.store.connection.exec("DELETE FROM ledger_entry")).toThrow(/append-only/);
  });

  it("records a reservation and its settlement as two rows sharing a reservation id", () => {
    const fx = fixture(budgetsWith({}));
    const reservation = fx.ledger.reserve({ scope: SCOPE, estimate: estimatedUsage(1) });
    fx.ledger.settle(reservation, knownUsage(0.5));
    const rows = fx.store.ledger.forReservation(reservation.id);
    expect(rows.map((r) => r.entryKind)).toEqual(["reservation", "settlement"]);
    expect(rows.every((r) => r.reservationId === reservation.id)).toBe(true);
  });

  it("noUsage() is a real zero, used only when nothing ran", () => {
    expect(noUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
      spendUsd: 0,
      costBasis: "known",
    });
  });

  it("exposes the store's ledger repository rather than opening its own database", () => {
    const fx = fixture(budgetsWith({}));
    expect(fx.ledger).toBeInstanceOf(Ledger);
    settled(fx, knownUsage(1));
    // Everything the ledger wrote is visible through the #23 store.
    expect(fx.store.ledger.count()).toBe(2);
  });
});
