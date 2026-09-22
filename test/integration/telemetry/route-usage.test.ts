/**
 * Issue #71 — usage attribution per ROUTE against the real ledger (#125).
 *
 * AGENTS.md §4: the author routes every subscription through one proxy, so
 * each model appears exactly once and this defect is structurally
 * unreproducible there. This test builds the *downloaded user's* shape — two
 * provider keys exposing one model id, two independent quotas — and asserts
 * against real SQLite rows, not an in-memory map.
 */
import { describe, expect, it } from "vitest";
import { makeRoute } from "../../../src/models/route.ts";
import { routeLabel, summariseUsageByRoute } from "../../../src/telemetry/usage.ts";
import { BudgetExceededError } from "../../../src/telemetry/ledger.ts";
import { budgetsWith, makeLedgerFixture } from "../../helpers/ledger.ts";
import type { AttemptId, PhaseId, TaskId, Usage, WorkflowId } from "../../../src/storage/records.ts";

const scope = {
  workflowId: "wf-1" as WorkflowId,
  phaseId: "ph-1" as PhaseId,
  taskId: "tk-1" as TaskId,
  attemptId: "at-1" as AttemptId,
};

const priced = (spendUsd: number): Usage => ({
  inputTokens: 100,
  outputTokens: 50,
  requests: 1,
  spendUsd,
  costBasis: "known",
});

const unpriced: Usage = {
  inputTokens: 100,
  outputTokens: 50,
  requests: 1,
  spendUsd: null,
  costBasis: "unknown",
};

describe("AC: usage settles against the ledger and is attributed per route", () => {
  it("keeps two subscriptions to one vendor apart in the persisted ledger", () => {
    const fx = makeLedgerFixture({ budgets: budgetsWith({}), prefix: "korwf-route-usage-" });
    try {
      const alpha = makeRoute("vendor-sub-a", "shared-model");
      const beta = makeRoute("vendor-sub-b", "shared-model");

      for (const [route, spend] of [
        [alpha, 1.5],
        [beta, 0.25],
        [alpha, 1.5],
      ] as const) {
        const reservation = fx.ledger.reserve({
          scope,
          estimate: priced(spend),
          label: routeLabel(route.routeId),
        });
        fx.ledger.settle(reservation, priced(spend), { elapsedMs: 10 });
      }

      const rows = fx.store.ledger.list();
      const totals = summariseUsageByRoute(rows, [alpha, beta]);
      expect(totals.get(alpha.routeId)?.spendUsd).toBeCloseTo(3, 10);
      expect(totals.get(beta.routeId)?.spendUsd).toBeCloseTo(0.25, 10);
      expect(totals.get(alpha.routeId)?.requests).toBe(2);
      // Same model id, two routes: the ids must not have collapsed.
      expect(alpha.modelId).toBe(beta.modelId);
      expect(totals.size).toBe(2);
    } finally {
      fx.cleanup();
    }
  });

  it("carries the route label onto the settlement row, not only the reservation", () => {
    const fx = makeLedgerFixture({ budgets: budgetsWith({}), prefix: "korwf-route-label-" });
    try {
      const route = makeRoute("vendor-sub-a", "shared-model");
      const reservation = fx.ledger.reserve({ scope, estimate: unpriced, label: routeLabel(route.routeId) });
      fx.ledger.settle(reservation, unpriced, { elapsedMs: 5 });
      const rows = fx.store.ledger.forReservation(reservation.id);
      // Both rows carry it: a per-route report reading settlements alone must
      // not have to join back to the reservation to learn the route.
      expect(rows.map((r) => r.label)).toEqual([routeLabel(route.routeId), routeLabel(route.routeId)]);
      const totals = summariseUsageByRoute(rows, [route]);
      expect(totals.get(route.routeId)?.unknownCostRequests).toBe(1);
      expect(totals.get(route.routeId)?.spendUsd).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it("never turns an unpriced route's spend into $0.00 in the persisted total", () => {
    const fx = makeLedgerFixture({ budgets: budgetsWith({}), prefix: "korwf-route-unknown-" });
    try {
      const route = makeRoute("vendor-sub-a", "unpriced-model");
      const reservation = fx.ledger.reserve({ scope, estimate: unpriced, label: routeLabel(route.routeId) });
      fx.ledger.settle(reservation, unpriced, { elapsedMs: 5 });
      const status = fx.ledger.scopeStatus("task", scope);
      expect(status?.spendUsd.used).toBe(0);
      expect(status?.unknownCostRequests).toBeGreaterThan(0);
      expect(status?.hasUnknownCost).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("enforces a shared cap atomically across routes: the second worker is refused", () => {
    // Budget caps are per scope, not per route, so two routes drawing on one
    // task budget contend — and the ledger, not a caller, decides who wins.
    const fx = makeLedgerFixture({ budgets: budgetsWith({ task: { maxSpendUsd: 2 } }), prefix: "korwf-route-cap-" });
    try {
      const alpha = makeRoute("vendor-sub-a", "shared-model");
      const beta = makeRoute("vendor-sub-b", "shared-model");
      fx.ledger.reserve({ scope, estimate: priced(2), label: routeLabel(alpha.routeId) });
      expect(() =>
        fx.ledger.reserve({ scope, estimate: priced(0.01), label: routeLabel(beta.routeId) }),
      ).toThrow(BudgetExceededError);
      expect(fx.store.ledger.count()).toBe(1);
    } finally {
      fx.cleanup();
    }
  });
});
