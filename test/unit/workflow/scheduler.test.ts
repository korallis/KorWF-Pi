/**
 * `src/workflow/scheduler.ts` (issue #75; PLAN §3.E).
 *
 * Test names reference the acceptance criterion they exercise:
 * - AC1 "random DAGs execute in a valid topological order with no task
 *   dispatched twice";
 * - AC2 "concurrency never exceeds the cap";
 * - AC3 "cancel mid-run → all attempts cancelled, `run` resumes".
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, Task, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  claimTask,
  conflictsOnOwnership,
  planPass,
  runScheduler,
  UNCERTAIN_COUPLING,
  type DispatchOutcome,
} from "../../../src/workflow/scheduler.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const e = open.pop();
    e?.store.close();
    e?.dir.cleanup();
  }
});

const actor = { kind: "engine", identity: "korwf" } as const;
const now = (): string => AT;
function newId(): string {
  return `id-${(counter += 1)}`;
}

function freshStore(): Store {
  const dir = makeTempDir("korwf-scheduler-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "running" }));
  return store;
}

/** A task with disjoint ownership, so ownership never confounds a concurrency test. */
function insertTask(
  store: Store,
  id: string,
  options: { readonly dependencies?: readonly string[]; readonly status?: Task["status"] } = {},
): Task {
  const task = makeTask({
    id: id as TaskId,
    workflowId: WF,
    phaseId: PH,
    status: options.status ?? "ready",
    dependencies: (options.dependencies ?? []) as readonly TaskId[],
    ownership: { paths: [`src/${id}.ts`], components: [id] },
  });
  store.tasks.insert(task);
  return task;
}

/** Every pair independent: isolates the property under test from the serial default. */
const independent = (): "independent" => "independent";

function okOutcome(task: Task): DispatchOutcome {
  return { taskId: task.id, ok: true };
}

/** A deferred promise, so a test controls exactly when a worker finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

/** The hooks every run needs, with budget and authorisation permissive. */
function baseParams(store: Store): {
  store: Store;
  workflowId: WorkflowId;
  phaseIds: readonly PhaseId[];
  actor: typeof actor;
  now: () => string;
  newId: () => string;
  authorizationCurrent: () => boolean;
  dispatchAllowed: () => boolean;
  reserve: () => { release: () => void };
} {
  return {
    store,
    workflowId: WF,
    phaseIds: [PH],
    actor,
    now,
    newId,
    authorizationCurrent: () => true,
    dispatchAllowed: () => true,
    reserve: () => ({ release: () => {} }),
  };
}

describe("AC2: concurrency never exceeds the cap", () => {
  it("never runs more workers at once than the configured limit", async () => {
    const store = freshStore();
    for (let i = 0; i < 12; i += 1) insertTask(store, `t${i}`);

    let live = 0;
    let peak = 0;
    const gates: (() => void)[] = [];

    const promise = runScheduler({
      ...baseParams(store),
      limit: 3,
      coupling: independent,
      dispatch: async (task: Task) => {
        live += 1;
        peak = Math.max(peak, live);
        const gate = deferred();
        gates.push(gate.resolve);
        await gate.promise;
        live -= 1;
        return okOutcome(task);
      },
    });

    // Release workers one at a time; the loop refills up to the cap each time.
    for (let released = 0; released < 12; released += 1) {
      // Let the loop start whatever it can before releasing the next worker.
      await new Promise((r) => setImmediate(r));
      const next = gates.shift();
      if (next === undefined) break;
      next();
    }
    // Drain anything started after the last release.
    while (gates.length > 0) {
      await new Promise((r) => setImmediate(r));
      gates.shift()?.();
    }

    const result = await promise;
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.peakConcurrency).toBeLessThanOrEqual(3);
    expect(result.dispatched).toHaveLength(12);
  });

  it("a limit of 1 is a sequential run: two workers are never live together", async () => {
    const store = freshStore();
    for (let i = 0; i < 4; i += 1) insertTask(store, `s${i}`);

    let live = 0;
    let peak = 0;
    const result = await runScheduler({
      ...baseParams(store),
      limit: 1,
      coupling: independent,
      dispatch: async (task: Task) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 1));
        live -= 1;
        return okOutcome(task);
      },
    });
    expect(peak).toBe(1);
    expect(result.dispatched).toHaveLength(4);
  });

  it("planPass holds ready tasks over the cap with reason concurrency_cap", () => {
    const store = freshStore();
    insertTask(store, "a");
    insertTask(store, "b");
    insertTask(store, "c");

    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: 2, coupling: independent });
    expect(plan.dispatch).toHaveLength(2);
    expect(plan.held.map((h) => h.reason)).toEqual(["concurrency_cap"]);
  });

  it("a refused budget reservation holds the task instead of dispatching it", async () => {
    const store = freshStore();
    insertTask(store, "a");
    insertTask(store, "b");

    let granted = 0;
    const result = await runScheduler({
      ...baseParams(store),
      limit: null,
      coupling: independent,
      reserve: () => {
        granted += 1;
        return granted === 1 ? { release: () => {} } : null;
      },
      dispatch: async (task: Task) => okOutcome(task),
    });

    expect(result.dispatched).toHaveLength(1);
    expect(result.held.some((h) => h.reason === "budget_refused")).toBe(true);
  });
});
