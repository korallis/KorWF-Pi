/**
 * Issue #71 — per-worker limit predicates (`src/workers/limits.ts`) and
 * per-route usage attribution (`src/telemetry/usage.ts`).
 *
 * Route attribution has its own tests here because the author's environment
 * structurally cannot reproduce the defect (AGENTS.md §4): one proxy, so each
 * model appears exactly once. These fixtures build the downloaded user's
 * shape instead — two provider keys, one model id, two quotas.
 */
import { describe, expect, it } from "vitest";
import { evaluateLimits, msUntilElapsedLimit } from "../../src/workers/limits.ts";
import { DEFAULT_BUDGET, type WorkerBudget } from "../../src/workers/contract.ts";
import { makeRoute } from "../../src/models/route.ts";
import { mergeUsage, parseRouteLabel, routeLabel, summariseUsageByRoute } from "../../src/telemetry/usage.ts";
import type { LedgerEntry, Usage } from "../../src/storage/records.ts";

const budget = (overrides: Partial<WorkerBudget>): WorkerBudget => ({ ...DEFAULT_BUDGET, ...overrides });

const usage = (u: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  requests: 1,
  spendUsd: null,
  costBasis: "unknown",
  ...u,
});

describe("AC: elapsed, token and spend limits are enforced per worker", () => {
  it("reports no breach inside every ceiling", () => {
    const b = budget({ wallClockMs: 1_000, maxTotalTokens: 100, maxSpendUsd: 1 });
    expect(evaluateLimits(b, { elapsedMs: 999, usage: usage({ inputTokens: 50, outputTokens: 40, spendUsd: 0.5, costBasis: "known" }) })).toBeNull();
  });

  it("breaches the elapsed limit and names it first when several are crossed", () => {
    const b = budget({ wallClockMs: 10, maxTotalTokens: 1, maxSpendUsd: 0.01 });
    const breach = evaluateLimits(b, { elapsedMs: 11, usage: usage({ inputTokens: 900, spendUsd: 5, costBasis: "known" }) });
    expect(breach?.kind).toBe("elapsed");
    expect(breach?.limit).toBe(10);
    expect(breach?.observed).toBe(11);
  });

  it("breaches the output-token limit", () => {
    const breach = evaluateLimits(budget({ maxOutputTokens: 100 }), { elapsedMs: 0, usage: usage({ outputTokens: 101 }) });
    expect(breach?.kind).toBe("output_tokens");
  });

  it("breaches the total-token limit from input + output", () => {
    const breach = evaluateLimits(budget({ maxTotalTokens: 100 }), { elapsedMs: 0, usage: usage({ inputTokens: 60, outputTokens: 60 }) });
    expect(breach?.kind).toBe("total_tokens");
    expect(breach?.observed).toBe(120);
  });

  it("breaches the spend limit on a priced route", () => {
    const breach = evaluateLimits(budget({ maxSpendUsd: 1 }), { elapsedMs: 0, usage: usage({ spendUsd: 1.5, costBasis: "known" }) });
    expect(breach?.kind).toBe("spend");
  });

  it("does NOT breach the spend limit on unknown cost: null is not zero and not infinity (#56)", () => {
    const b = budget({ maxSpendUsd: 0.000_01, maxTotalTokens: 10_000 });
    const breach = evaluateLimits(b, { elapsedMs: 0, usage: usage({ inputTokens: 500, spendUsd: null, costBasis: "unknown" }) });
    expect(breach).toBeNull();
  });

  it("still enforces token limits on an unpriced route", () => {
    const breach = evaluateLimits(budget({ maxTotalTokens: 10 }), { elapsedMs: 0, usage: usage({ inputTokens: 11 }) });
    expect(breach?.kind).toBe("total_tokens");
  });

  it("computes the next wall-clock wake-up, never negative", () => {
    expect(msUntilElapsedLimit(budget({ wallClockMs: 500 }), 100)).toBe(400);
    expect(msUntilElapsedLimit(budget({ wallClockMs: 500 }), 900)).toBe(0);
  });
});

describe("AC: usage is attributed per ROUTE (#125), not per model id", () => {
  const alpha = makeRoute("vendor-key-one", "shared-model");
  const beta = makeRoute("vendor-key-two", "shared-model");

  const entry = (label: string, u: Usage, entryKind: LedgerEntry["entryKind"] = "settlement"): Pick<LedgerEntry, "entryKind" | "label" | "usage"> => ({
    entryKind,
    label,
    usage: u,
  });

  it("gives two subscriptions to one vendor two distinct route ids", () => {
    expect(alpha.routeId).not.toBe(beta.routeId);
    expect(alpha.modelId).toBe(beta.modelId);
  });

  it("keeps the two accounts' usage separate rather than pooling on the model id", () => {
    const totals = summariseUsageByRoute(
      [
        entry(routeLabel(alpha.routeId), usage({ inputTokens: 100, spendUsd: 1, costBasis: "known" })),
        entry(routeLabel(beta.routeId), usage({ inputTokens: 10, spendUsd: 0.1, costBasis: "known" })),
        entry(routeLabel(alpha.routeId), usage({ inputTokens: 100, spendUsd: 1, costBasis: "known" })),
      ],
      [alpha, beta],
    );
    expect(totals.get(alpha.routeId)?.spendUsd).toBeCloseTo(2, 10);
    expect(totals.get(beta.routeId)?.spendUsd).toBeCloseTo(0.1, 10);
    expect(totals.get(alpha.routeId)?.providerId).toBe("vendor-key-one");
    expect(totals.get(beta.routeId)?.providerId).toBe("vendor-key-two");
  });

  it("counts only settled facts: a reservation is a claim and a release never happened", () => {
    const totals = summariseUsageByRoute([
      entry(routeLabel(alpha.routeId), usage({ requests: 1, spendUsd: 5, costBasis: "estimated" }), "reservation"),
      entry(routeLabel(alpha.routeId), usage({ requests: 0, spendUsd: 0, costBasis: "known" }), "release"),
      entry(routeLabel(alpha.routeId), usage({ requests: 1, spendUsd: 0.25, costBasis: "known" })),
    ]);
    expect(totals.get(alpha.routeId)?.spendUsd).toBeCloseTo(0.25, 10);
    expect(totals.get(alpha.routeId)?.requests).toBe(1);
  });

  it("reports unpriced requests separately instead of as $0.00", () => {
    const totals = summariseUsageByRoute([
      entry(routeLabel(alpha.routeId), usage({ inputTokens: 40, spendUsd: null, costBasis: "unknown" })),
    ]);
    const row = totals.get(alpha.routeId);
    expect(row?.spendUsd).toBeNull();
    expect(row?.unknownCostRequests).toBe(1);
    expect(row?.inputTokens).toBe(40);
  });

  it("round-trips the route label and rejects a non-route label", () => {
    expect(parseRouteLabel(routeLabel(alpha.routeId))).toBe(alpha.routeId);
    expect(parseRouteLabel("question:example.echo@1")).toBeNull();
    expect(parseRouteLabel(null)).toBeNull();
  });
});

describe("mergeUsage keeps unknown cost unknown", () => {
  it("sums tokens across priced and unpriced calls but reports unknown if none were priced", () => {
    const merged = mergeUsage([usage({ inputTokens: 5 }), usage({ outputTokens: 6 })]);
    expect(merged.inputTokens).toBe(5);
    expect(merged.outputTokens).toBe(6);
    expect(merged.spendUsd).toBeNull();
    expect(merged.costBasis).toBe("unknown");
  });

  it("downgrades a mixed group to estimated when any contributing figure was an estimate", () => {
    const merged = mergeUsage([
      usage({ spendUsd: 1, costBasis: "known" }),
      usage({ spendUsd: 2, costBasis: "estimated" }),
    ]);
    expect(merged.spendUsd).toBe(3);
    expect(merged.costBasis).toBe("estimated");
  });

  it("returns honest empty usage for no inputs", () => {
    const merged = mergeUsage([]);
    expect(merged.requests).toBe(0);
    expect(merged.spendUsd).toBeNull();
    expect(merged.costBasis).toBe("unknown");
  });
});
