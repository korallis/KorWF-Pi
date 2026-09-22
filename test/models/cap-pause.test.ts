/**
 * Tests for src/models/cap-pause.ts (issue #63; PLAN §3.D "Caps and
 * fallback"; docs/state-machine.md §4.1).
 *
 * AC: "All candidates capped -> task paused(cap), phase paused, status
 *   shows earliest estimated reset."
 * AC: "Cap clears (fake clock) -> auto-resume without user action."
 * AC: "Attempt record shows both models and the reason after a switch."
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../src/storage/db.ts";
import type { PhaseId, TaskId } from "../../src/storage/records.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../helpers/records.ts";
import { makeTempDir, type TempDir } from "../helpers/temp-dir.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { applyCapPause, recordFallbackSwitch, resumeIfCapCleared } from "../../src/models/cap-pause.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import type { FallbackDecision } from "../../src/models/fallback.ts";

const PH = "ph-1" as PhaseId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function isoAt(clock: FakeClock): string {
  return new Date(clock.now()).toISOString();
}

function freshStore(clock: FakeClock): Store {
  const dir = makeTempDir("korwf-cap-pause-");
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => isoAt(clock),
    newId: () => `id-${(counter += 1)}`,
  });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ id: PH, gateStatus: "running" }));
  store.tasks.insert(makeTask({ id: TK, phaseId: PH, status: "running" }));
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

function deps(store: Store, clock: FakeClock) {
  return {
    store,
    taskId: TK,
    phaseId: PH,
    actor: { kind: "engine" as const, identity: "engine" },
    now: () => isoAt(clock),
    newId: () => `id-${(counter += 1)}`,
  };
}

describe("AC: all candidates capped -> task paused(cap), phase paused, earliest reset surfaced", () => {
  it("transitions the task to paused_cap and the phase to paused, through state.ts", () => {
    const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const store = freshStore(clock);
    const decision: Extract<FallbackDecision, { kind: "pause" }> = {
      kind: "pause",
      reason: "all_capped",
      earliestReset: "2026-01-01T00:30:00.000Z",
      blocker: "all eligible candidates capped",
      watchRoutes: [deriveRouteId("acme", "primary"), deriveRouteId("acme", "sub")],
    };

    const result = applyCapPause(deps(store, clock), decision);

    expect(result.task.subject.status).toBe("paused_cap");
    expect(result.task.subject.blocker).toContain("all_candidates_capped");
    expect(result.phase.subject.gateStatus).toBe("paused_cap");

    const reread = store.tasks.require(TK);
    expect(reread.status).toBe("paused_cap");
    const phaseReread = store.phases.require(PH);
    expect(phaseReread.gateStatus).toBe("paused_cap");

    // Earliest estimated reset is recorded on the pause transition's evidence,
    // so status surfaces can read it back without re-deriving it.
    expect(result.task.event.evidenceRefs.some((r) => r.includes("2026-01-01T00:30:00.000Z"))).toBe(true);
  });

  it("is not recorded as a failure: no failed transition and the task keeps paused_cap, not failed", () => {
    const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const store = freshStore(clock);
    const decision: Extract<FallbackDecision, { kind: "pause" }> = {
      kind: "pause",
      reason: "no_adequate",
      earliestReset: null,
      blocker: "Jev found no adequate substitute",
      watchRoutes: [deriveRouteId("acme", "primary")],
    };

    applyCapPause(deps(store, clock), decision);

    expect(store.tasks.require(TK).status).toBe("paused_cap");
    expect(store.tasks.require(TK).status).not.toBe("failed");
  });
});

describe("AC: cap clears (fake clock) -> auto-resume without user action", () => {
  it("stays paused_cap while every watched route is still capped, then resumes once one clears", () => {
    const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const store = freshStore(clock);
    const routeId = deriveRouteId("acme", "primary");
    const decision: Extract<FallbackDecision, { kind: "pause" }> = {
      kind: "pause",
      reason: "all_capped",
      earliestReset: "2026-01-01T00:30:00.000Z",
      blocker: "all eligible candidates capped",
      watchRoutes: [routeId],
    };
    applyCapPause(deps(store, clock), decision);
    expect(store.tasks.require(TK).status).toBe("paused_cap");

    const table = new RouteAvailabilityTable();
    table.markCapped(
      { routeId, providerId: "acme", modelId: "primary", ref: "acme/primary" },
      { capKind: "quota_exhausted", at: isoAt(clock), estimatedReset: "2026-01-01T00:30:00.000Z" },
    );

    // Before the reset: no user action taken, and the fake clock has not
    // advanced past it — resume must not happen yet.
    clock.set(Date.parse("2026-01-01T00:15:00.000Z"));
    const early = resumeIfCapCleared(deps(store, clock), [routeId], table);
    expect(early).toBeNull();
    expect(store.tasks.require(TK).status).toBe("paused_cap");
    expect(store.phases.require(PH).gateStatus).toBe("paused_cap");

    // Advance the fake clock past the reset and mark the route available —
    // this is the only "cap clears" signal; nothing here sleeps.
    clock.set(Date.parse("2026-01-01T00:30:00.000Z"));
    table.markAvailable({ routeId, providerId: "acme", modelId: "primary", ref: "acme/primary" }, isoAt(clock));

    const resumed = resumeIfCapCleared(deps(store, clock), [routeId], table);
    expect(resumed).not.toBeNull();
    expect(resumed?.task.subject.status).toBe("ready");
    expect(resumed?.phase.subject.gateStatus).toBe("running");
    expect(store.tasks.require(TK).status).toBe("ready");
    expect(store.phases.require(PH).gateStatus).toBe("running");
  });

  it("resumes to ready, never directly to running/done", () => {
    const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const store = freshStore(clock);
    const routeId = deriveRouteId("acme", "sub");
    applyCapPause(deps(store, clock), {
      kind: "pause",
      reason: "all_capped",
      earliestReset: null,
      blocker: "all eligible candidates capped",
      watchRoutes: [routeId],
    });

    const table = new RouteAvailabilityTable();
    table.markAvailable({ routeId, providerId: "acme", modelId: "sub", ref: "acme/sub" }, isoAt(clock));
    const resumed = resumeIfCapCleared(deps(store, clock), [routeId], table);

    expect(resumed?.task.subject.status).toBe("ready");
    expect(resumed?.task.subject.status).not.toBe("running");
    expect(resumed?.task.subject.status).not.toBe("done");
  });

  it("does not resume when no watched route has cleared (unknown reset stays paused)", () => {
    const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const store = freshStore(clock);
    const routeId = deriveRouteId("acme", "primary");
    applyCapPause(deps(store, clock), {
      kind: "pause",
      reason: "all_capped",
      earliestReset: null,
      blocker: "all eligible candidates capped",
      watchRoutes: [routeId],
    });

    const table = new RouteAvailabilityTable();
    table.markCapped(
      { routeId, providerId: "acme", modelId: "primary", ref: "acme/primary" },
      { capKind: "quota_exhausted", at: isoAt(clock), estimatedReset: null },
    );

    clock.set(Date.parse("2026-01-02T00:00:00.000Z"));
    const result = resumeIfCapCleared(deps(store, clock), [routeId], table);
    expect(result).toBeNull();
    expect(store.tasks.require(TK).status).toBe("paused_cap");
  });
});

describe("AC: Attempt record shows both models and the reason after a switch", () => {
  it("recordFallbackSwitch persists requestedModel, usedModel and fallbackReason", () => {
    const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const store = freshStore(clock);
    store.attempts.insert(
      makeAttempt({
        id: "at-1" as never,
        taskId: TK,
        requestedModel: "acme/primary",
        usedModel: "acme/primary",
        fallbackReason: null,
      }),
    );

    const decision: Extract<FallbackDecision, { kind: "switch" }> = {
      kind: "switch",
      requestedModel: "acme/primary",
      usedModel: "acme/sub",
      fallbackReason: "quota_exhausted",
      rationale: "jev ranked acme/sub adequate",
      decisionId: null,
    };

    const updated = recordFallbackSwitch(store, "at-1" as never, decision);
    expect(updated.requestedModel).toBe("acme/primary");
    expect(updated.usedModel).toBe("acme/sub");
    expect(updated.fallbackReason).toBe("quota_exhausted");

    const reread = store.attempts.require("at-1");
    expect(reread.requestedModel).toBe("acme/primary");
    expect(reread.usedModel).toBe("acme/sub");
    expect(reread.fallbackReason).toBe("quota_exhausted");
  });
});
