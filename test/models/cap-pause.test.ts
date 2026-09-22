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
import type { PhaseId, RouteId, TaskId } from "../../src/storage/records.ts";
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
