/**
 * AC3: "Reservation without settlement is reconciled on startup as abandoned."
 *
 * The reservation's estimate is deliberately *not* refunded. A call that was
 * reserved and never settled may have run and cost money; returning the budget
 * would let a crash loop spend past its cap. Reports show it as an abandoned,
 * unverified estimate instead.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { LEDGER_ABANDONED_REASON } from "../../../src/storage/reconcile.ts";
import { Ledger, reconcileAbandonedReservations } from "../../../src/telemetry/ledger.ts";
import type { WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { budgetsWith, knownUsage, seed } from "../../helpers/ledger.ts";

const SCOPE = { workflowId: "wf-1" as WorkflowId };

const open: { dir: TempDir; store: Store }[] = [];

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

/** Open a store at `root` (creating a temp dir if none given) with reconciliation off. */
function openAt(root?: string, reconcile: boolean = false): { store: Store; root: string } {
  const dir = root === undefined ? makeTempDir("korwf-ledger-recon-") : { path: root, cleanup: () => {} };
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => "2026-04-04T00:00:00.000Z",
    reconcile: reconcile ? {} : false,
  });
  open.push({ dir, store });
  return { store, root: dir.path };
}

function ledgerFor(store: Store, sessionId: string): Ledger {
  let counter = 0;
  return new Ledger(store, {
    budgets: budgetsWith({ workflow: { maxSpendUsd: 10 } }),
    now: () => "2026-04-04T00:00:00.000Z",
    newId: () => `${sessionId}-${(counter += 1)}`,
    sessionId,
  });
}

describe("AC3: a reservation with no settlement is reconciled on startup as abandoned", () => {
  it("closes the dead session's reservation with an abandonment row", () => {
    const first = openAt();
    seed(first.store);
    const ledger = ledgerFor(first.store, "session-that-died");
    const reservation = ledger.reserve({ scope: SCOPE, estimate: knownUsage(2) });
    expect(first.store.ledger.openReservations()).toHaveLength(1);
    // The process dies here: no settle, no release.
    first.store.close();

    // A new session opens the same store and reconciliation runs on open.
    const second = openAt(first.root, true);
    const rows = second.store.ledger.forReservation(reservation.id);
    expect(rows.map((r) => r.entryKind)).toEqual(["reservation", "abandonment"]);
    expect(rows[1]?.reason).toBe(LEDGER_ABANDONED_REASON);
    expect(second.store.ledger.openReservations()).toHaveLength(0);
  });

  it("reports the abandoned reservations in the open-store report", () => {
    const first = openAt();
    seed(first.store);
    ledgerFor(first.store, "session-that-died").reserve({ scope: SCOPE, estimate: knownUsage(2) });
    first.store.close();

    const dir = { path: first.root, cleanup: () => {} };
    const { store, report } = openStore({ storageRoot: first.root });
    open.push({ dir, store });
    expect(report.reconciliation?.reservations).toHaveLength(1);
    expect(report.reconciliation?.reservations[0]?.sessionId).toBe("session-that-died");
    expect(report.reconciliation?.reservations[0]?.estimate.spendUsd).toBe(2);
  });

  it("keeps the estimate charged rather than refunding unverifiable spend", () => {
    const first = openAt();
    seed(first.store);
    ledgerFor(first.store, "session-that-died").reserve({ scope: SCOPE, estimate: knownUsage(2) });
    first.store.close();

    const second = openAt(first.root, true);
    const status = ledgerFor(second.store, "new-session").status(SCOPE);
    const workflow = status.scopes.find((s) => s.scope === "workflow");
    expect(workflow?.spendUsd.used).toBe(2);
    expect(workflow?.spendUsd.remaining).toBe(8);
  });

  it("is idempotent: a second reconciliation finds nothing", () => {
    const first = openAt();
    seed(first.store);
    ledgerFor(first.store, "session-that-died").reserve({ scope: SCOPE, estimate: knownUsage(2) });
    first.store.close();

    const second = openAt(first.root, true);
    const before = second.store.ledger.count();
    const again = second.store.reconcile();
    expect(again.reservations).toHaveLength(0);
    expect(second.store.ledger.count()).toBe(before);
  });

  it("leaves the current session's own in-flight reservations alone", () => {
    const fx = openAt();
    seed(fx.store);
    const ledger = ledgerFor(fx.store, "my-session");
    const mine = ledger.reserve({ scope: SCOPE, estimate: knownUsage(1) });

    const report = reconcileAbandonedReservations(ledger, fx.store);
    expect(report.abandoned).toBe(0);
    expect(fx.store.ledger.openReservations()).toHaveLength(1);
    // Still settleable afterwards.
    expect(() => ledger.settle(mine, knownUsage(1))).not.toThrow();
  });

  it("closes another session's reservation while keeping mine open", () => {
    const fx = openAt();
    seed(fx.store);
    const theirs = ledgerFor(fx.store, "other-session").reserve({
      scope: SCOPE,
      estimate: knownUsage(1),
    });
    const mineLedger = ledgerFor(fx.store, "my-session");
    const mine = mineLedger.reserve({ scope: SCOPE, estimate: knownUsage(1) });

    const report = reconcileAbandonedReservations(mineLedger, fx.store);
    expect(report.abandoned).toBe(1);
    expect(report.reservations[0]?.reservationId).toBe(theirs.id);
    expect(fx.store.ledger.openReservations().map((r) => r.reservationId)).toEqual([mine.id]);
  });

  it("frees the concurrency slot a dead session was holding", () => {
    const first = openAt();
    seed(first.store);
    let counter = 0;
    const dying = new Ledger(first.store, {
      budgets: budgetsWith({ workflow: { maxConcurrency: 1 } }),
      newId: () => `dead-${(counter += 1)}`,
      sessionId: "session-that-died",
    });
    dying.reserve({ scope: SCOPE, estimate: knownUsage(1) });
    first.store.close();

    const second = openAt(first.root, true);
    const revived = new Ledger(second.store, {
      budgets: budgetsWith({ workflow: { maxConcurrency: 1 } }),
      sessionId: "new-session",
    });
    // The abandoned reservation is closed, so the single slot is available.
    expect(() => revived.reserve({ scope: SCOPE, estimate: knownUsage(1) })).not.toThrow();
  });

  it("records the abandonment as a new append-only row, not an edit", () => {
    const first = openAt();
    seed(first.store);
    const reservation = ledgerFor(first.store, "session-that-died").reserve({
      scope: SCOPE,
      estimate: knownUsage(2),
    });
    first.store.close();

    const second = openAt(first.root, true);
    const rows = second.store.ledger.forReservation(reservation.id);
    expect(rows).toHaveLength(2);
    // The original reservation row is untouched.
    expect(rows[0]?.entryKind).toBe("reservation");
    expect(rows[0]?.reason).toBeNull();
    expect(rows[0]?.usage.spendUsd).toBe(2);
  });

  it("reconciles attempts and reservations in the same startup pass", () => {
    const first = openAt();
    seed(first.store);
    ledgerFor(first.store, "session-that-died").reserve({ scope: SCOPE, estimate: knownUsage(1) });
    first.store.close();

    const dir = { path: first.root, cleanup: () => {} };
    const { store, report } = openStore({ storageRoot: first.root });
    open.push({ dir, store });
    // The seeded attempt had no outcome, so both halves of rule 7 fire.
    expect(report.reconciliation?.abandoned).toBe(1);
    expect(report.reconciliation?.reservations).toHaveLength(1);
  });
});
