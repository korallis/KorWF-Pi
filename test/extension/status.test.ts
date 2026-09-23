/**
 * Tests for src/extension/commands/status.ts (issue #66).
 *
 * AC: "After a simulated fallback, `status` shows requested → used and the
 * reason." AC: "Output passes the secret regex check." PLAN §3.I: explain
 * from recorded fields only.
 */
import { describe, it, expect } from "vitest";
import {
  attemptSwitchLines,
  ledgerStatusLines,
  scopeStatusLine,
  statusReportMessage,
} from "../../src/extension/commands/status.ts";
import type { TaskBoardRow } from "../../src/workflow/boards.ts";
import type { LedgerStatus, ScopeStatus } from "../../src/telemetry/ledger.ts";
import { makeTask } from "../helpers/records.ts";
import type { TaskId } from "../../src/storage/records.ts";

const T1 = "2026-09-21T10:05:00.000Z";

function row(overrides: Partial<TaskBoardRow> = {}): TaskBoardRow {
  return {
    task: makeTask({ id: "tk-1" as TaskId }),
    blockers: [],
    dependencies: [],
    unmetDependencies: [],
    evidenceCount: 0,
    lastModel: null,
    lastModelSwitch: null,
    checkSummary: { checks: [], uncoveredCriteria: [] },
    ...overrides,
  };
}

describe("attemptSwitchLines (AC: status shows requested → used and the reason)", () => {
  it("reports a task whose used model differs from requested, with the recorded reason", () => {
    const rows = [
      row({
        lastModelSwitch: { requestedModel: "vendor/big", usedModel: "vendor/small", fallbackReason: "rate_limited" },
      }),
    ];
    const lines = attemptSwitchLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("requested vendor/big");
    expect(lines[0]).toContain("used vendor/small");
    expect(lines[0]).toContain("rate_limited");
  });

  it("says so when a switch happened with no recorded reason, never fabricating one", () => {
    const rows = [
      row({ lastModelSwitch: { requestedModel: "vendor/big", usedModel: "vendor/small", fallbackReason: null } }),
    ];
    const lines = attemptSwitchLines(rows);
    expect(lines[0]).toContain("no reason recorded");
  });

  it("omits a task that never ran or never switched", () => {
    const rows = [
      row({ lastModelSwitch: null }),
      row({ lastModelSwitch: { requestedModel: "vendor/a", usedModel: "vendor/a", fallbackReason: null } }),
    ];
    expect(attemptSwitchLines(rows)).toEqual([]);
  });
});

function scope(overrides: Partial<ScopeStatus> = {}): ScopeStatus {
  return {
    scope: "workflow",
    id: "wf-1",
    spendUsd: { limit: 10, used: 2.5, remaining: 7.5 },
    tokens: { limit: null, used: 100, remaining: null },
    requests: { limit: null, used: 3, remaining: null },
    concurrency: { limit: null, used: 0, remaining: null },
    elapsedMs: { limit: null, used: 0, remaining: null },
    unknownCostRequests: 0,
    estimatedSpendUsd: 0,
    knownSpendUsd: 2.5,
    hasUnknownCost: false,
    ...overrides,
  };
}

describe("running cost (AC: status shows budgets and running cost)", () => {
  it("renders spend used against the cap", () => {
    expect(scopeStatusLine(scope())).toContain("$2.50 / $10.00 spent");
  });

  it("flags unpriced requests rather than reporting them as $0", () => {
    const line = scopeStatusLine(scope({ hasUnknownCost: true, unknownCostRequests: 2 }));
    expect(line).toContain("2 request(s) with unpriced cost");
  });

  it("ledgerStatusLines returns nothing when no ledger status was supplied", () => {
    expect(ledgerStatusLines(null)).toEqual([]);
    expect(ledgerStatusLines(undefined)).toEqual([]);
  });

  it("ledgerStatusLines renders every scope", () => {
    const status: LedgerStatus = { scopes: [scope(), scope({ scope: "task", id: "tk-1" })], hasUnknownCost: false };
    const lines = ledgerStatusLines(status);
    expect(lines[0]).toBe("running cost:");
    expect(lines).toHaveLength(3);
  });
});

describe("statusReportMessage (AC: output passes the secret regex check)", () => {
  it("never renders sensitive registry fields even with switches and cost present", () => {
    const models = [{ provider: "p", id: "m", baseUrl: "https://secret.example/v1", apiKey: "sk-secret" }];
    const rows = [
      row({
        lastModelSwitch: { requestedModel: "vendor/big", usedModel: "vendor/small", fallbackReason: "quota_exhausted" },
      }),
    ];
    const status: LedgerStatus = { scopes: [scope()], hasUnknownCost: false };
    const msg = statusReportMessage({ models, now: T1, taskRows: rows, ledgerStatus: status });
    expect(msg).not.toContain("secret");
    expect(msg).toContain("model switches:");
    expect(msg).toContain("running cost:");
  });

  it("omits sections with nothing to report", () => {
    const msg = statusReportMessage({ models: [{ provider: "p", id: "m" }], now: T1 });
    expect(msg).not.toContain("model switches:");
    expect(msg).not.toContain("running cost:");
  });
});
