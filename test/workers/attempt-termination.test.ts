/**
 * #124 AC2: "`stopReason: \"length\"` is **recorded on the attempt**" — proved by
 * writing it through the real store (#23) and reading it back.
 */
import { afterEach, describe, it, expect } from "vitest";
import { openStore, type Store } from "../../src/storage/db.ts";
import { settleTurn, toAttemptTermination } from "../../src/workflow/attempt-controller.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../helpers/records.ts";
import { makeTempDir, type TempDir } from "../helpers/temp-dir.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): Store {
  const dir = makeTempDir("korwf-truncation-");
  let counter = 0;
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `audit-${(counter += 1)}`,
  });
  open.push({ dir, store });
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("AC2: stopReason is recorded on the attempt", () => {
  it("persists a truncated turn's stop reason and harness classification", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    store.phases.insert(makePhase());
    store.tasks.insert(makeTask());
    store.attempts.insert(makeAttempt());

    const settled = settleTurn({ observation: { stopReason: "length", exitCode: 0, outputTokens: 16_384 } });
    store.attempts.update("at-1", { termination: toAttemptTermination(settled, 16_384) });

    const read = store.attempts.require("at-1");
    expect(read.termination).toEqual({
      stopReason: "length",
      truncated: true,
      failureKind: "truncated",
      failureClass: "harness",
      consumedAttemptBudget: false,
      outputTokens: 16_384,
    });
    // The attempt is still open: a harness failure is not an outcome.
    expect(read.outcome).toBeNull();
  });

  it("records a quality failure distinctly from a truncation", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    store.phases.insert(makePhase());
    store.tasks.insert(makeTask());
    store.attempts.insert(makeAttempt());

    const settled = settleTurn({
      observation: { stopReason: "stop", exitCode: 0, outputTokens: 4_000 },
      gate: { passed: false, feedback: "Unmet: criterion 2." },
    });
    store.attempts.update("at-1", { termination: toAttemptTermination(settled, 4_000) });

    const t = store.attempts.require("at-1").termination;
    expect(t?.truncated).toBe(false);
    expect(t?.failureClass).toBe("quality");
    expect(t?.consumedAttemptBudget).toBe(true);
  });

  it("defaults to null — 'not observed' is never 'ended cleanly'", () => {
    const store = freshStore();
    store.workflows.insert(makeWorkflow());
    store.phases.insert(makePhase());
    store.tasks.insert(makeTask());
    store.attempts.insert(makeAttempt());
    expect(store.attempts.require("at-1").termination).toBeNull();
  });
});
