/**
 * Issue #72 detection rules: "distinguish the worker died (harness), the
 * process was killed (cancellation), the machine crashed (unknown)".
 *
 * Pure classification only; the real kill -9 lives in
 * `test/integration/workers/crash-reconcile.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyInterruption,
  interruptionClassification,
  type AttemptLivenessEvidence,
} from "../../src/workers/reconcile.ts";

function evidence(overrides: Partial<AttemptLivenessEvidence> = {}): AttemptLivenessEvidence {
  return {
    pid: 4242,
    pidAlive: false,
    lockPresent: false,
    cancellationRequested: false,
    exitRecorded: false,
    ...overrides,
  };
}

describe("#72 detection: attempt running with dead pid or missing lock", () => {
  it("a live pid is still_running and is never closed by reconciliation", () => {
    const verdict = classifyInterruption(evidence({ pidAlive: true, lockPresent: true }));
    expect(verdict.cause).toBe("still_running");
    expect(verdict.outcome).toBeNull();
  });

  it("a requested cancellation makes a vanished process `cancelled`, not a crash", () => {
    const verdict = classifyInterruption(evidence({ cancellationRequested: true }));
    expect(verdict.cause).toBe("process_killed");
    expect(verdict.outcome).toBe("cancelled");
    expect(verdict.failureCategory).toBe("harness");
  });

  it("an observed exit with an unsettled row is `interrupted` and harness (#52)", () => {
    const verdict = classifyInterruption(evidence({ exitRecorded: true }));
    expect(verdict.cause).toBe("worker_died");
    expect(verdict.outcome).toBe("interrupted");
    expect(verdict.failureCategory).toBe("harness");
  });

  it("no exit observed and no cancellation is a machine crash, category unknown", () => {
    const verdict = classifyInterruption(evidence());
    expect(verdict.cause).toBe("machine_crashed");
    expect(verdict.outcome).toBe("interrupted");
    expect(verdict.failureCategory).toBe("unknown");
  });

  it("a missing pid is never read as still running", () => {
    const verdict = classifyInterruption(evidence({ pid: null, pidAlive: false }));
    expect(verdict.cause).toBe("machine_crashed");
  });

  it("an unknown crash asks for evidence instead of guessing (#52)", () => {
    const classification = interruptionClassification(classifyInterruption(evidence()));
    expect(classification.category).toBe("unknown");
    expect(classification.needsEvidence).toBe(true);
    expect(classification.evidenceRequests.length).toBeGreaterThan(0);
  });

  it("an attributable crash is harness and needs no further evidence", () => {
    const classification = interruptionClassification(classifyInterruption(evidence({ exitRecorded: true })));
    expect(classification.category).toBe("harness");
    expect(classification.needsEvidence).toBe(false);
  });
});
