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
import { transitionTask } from "../../../src/workflow/state.ts";
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

/**
 * Drive a `running` task all the way to `done` the way the engine would:
 * through `state.ts` only, with a passing gate receipt, because nothing else
 * may write `Task.status` and only a `done` dependency satisfies readiness.
 */
function markDone(store: Store, taskId: TaskId): void {
  const evidenceRefs = ["ev:checks", "ev:coverage", "ev:review"];
  const gitRevision = "a".repeat(40);
  transitionTask({
    store,
    taskId,
    to: "verifying",
    trigger: "completion_requested",
    actor,
    now,
    newId,
    evidenceRefs,
    guards: { attempt_settled: () => true },
  });
  transitionTask({
    store,
    taskId,
    to: "review",
    trigger: "checks_and_gap_assessed",
    actor,
    now,
    newId,
    evidenceRefs,
    gitRevision,
    guards: {
      checks_registered: () => true,
      all_checks_pass_exact_revision: () => true,
      no_jev_gap_or_disabled: () => true,
    },
  });
  const receiptId = `rcpt-${(counter += 1)}`;
  const task = store.tasks.require(taskId);
  store.gateReceipts.record({
    receiptId,
    createdAt: AT,
    workflowId: task.workflowId,
    gate: "task",
    subjectId: task.id,
    subjectRevision: task.revision,
    revision: gitRevision,
    disposition: "pass",
    reasonCode: null,
    detail: null,
    inputHash: "c".repeat(64),
    evaluatedAt: AT,
    consumedAt: null,
    conditions: [],
  });
  transitionTask({
    store,
    taskId,
    to: "done",
    trigger: "task_gate_passed",
    actor,
    now,
    newId,
    evidenceRefs,
    gitRevision,
    gateReceiptId: receiptId,
    guards: {
      checks_registered: () => true,
      all_checks_pass_exact_revision: () => true,
      no_jev_gap_or_disabled: () => true,
      policy_review_satisfied: () => true,
    },
  });
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

/** Deterministic PRNG: a failing seed is reproducible, unlike Math.random. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * A random DAG: task `i` may only depend on tasks with a lower index, so the
 * graph is acyclic by construction and the index order is one valid
 * topological order (not necessarily the one the scheduler picks).
 */
function randomDag(store: Store, size: number, next: () => number): readonly TaskId[] {
  const ids: TaskId[] = [];
  for (let i = 0; i < size; i += 1) {
    const dependencies = ids.filter(() => next() < 0.3);
    const id = `d${i}`;
    insertTask(store, id, { dependencies, status: i === 0 ? "ready" : "ready" });
    ids.push(id as TaskId);
  }
  return ids;
}

describe("AC1: random DAGs run in a valid topological order, each task once", () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`seed ${seed}: no task starts before its dependencies finished, and none runs twice`, async () => {
      const store = freshStore();
      const next = rng(seed);
      const ids = randomDag(store, 12, next);
      const deps = new Map(ids.map((id) => [id, store.tasks.require(id).dependencies]));

      const finished = new Set<TaskId>();
      const startedAt = new Map<TaskId, number>();
      const violations: string[] = [];
      let tick = 0;

      const result = await runScheduler({
        ...baseParams(store),
        limit: 4,
        coupling: independent,
        dispatch: async (task: Task) => {
          if (startedAt.has(task.id)) violations.push(`${task.id} dispatched twice`);
          startedAt.set(task.id, (tick += 1));
          for (const dep of deps.get(task.id) ?? []) {
            if (!finished.has(dep)) violations.push(`${task.id} started before ${dep} finished`);
          }
          // Random latency, so completion order differs from dispatch order.
          await new Promise((r) => setTimeout(r, Math.floor(next() * 3)));
          finished.add(task.id);
          // Only a `done` task satisfies a dependency, and only `state.ts`
          // may write that, so the test drives it the way the engine would.
          markDone(store, task.id);
          return okOutcome(task);
        },
      });

      expect(violations).toEqual([]);
      expect([...result.dispatched].sort()).toEqual([...ids].sort());
      expect(new Set(result.dispatched).size).toBe(result.dispatched.length);
    });
  }

  it("a task whose dependency never completes is never dispatched", async () => {
    const store = freshStore();
    insertTask(store, "root");
    insertTask(store, "leaf", { dependencies: ["root"] });

    const result = await runScheduler({
      ...baseParams(store),
      limit: 4,
      coupling: independent,
      // The worker "fails": the task never reaches `done`.
      dispatch: async (task: Task) => ({ taskId: task.id, ok: false }),
    });

    expect(result.dispatched).toEqual(["root"]);
  });

  it("two claims of the same ready task: exactly one wins (duplicate-dispatch prevention)", () => {
    const store = freshStore();
    const task = insertTask(store, "once");

    const hooks = {
      store,
      taskId: task.id,
      actor,
      now,
      newId,
      authorizationCurrent: () => true,
      dispatchAllowed: () => true,
    };
    const first = claimTask(hooks);
    const second = claimTask(hooks);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(store.tasks.require(task.id).status).toBe("running");
  });

  it("a ready task with no executable check is never offered for dispatch", () => {
    const store = freshStore();
    store.tasks.insert(
      makeTask({
        id: "nocheck" as TaskId,
        workflowId: WF,
        phaseId: PH,
        status: "ready",
        checks: [],
        ownership: { paths: ["src/nocheck.ts"], components: ["nocheck"] },
      }),
    );
    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, coupling: independent });
    expect(plan.dispatch).toEqual([]);
  });
});

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

  it("an in-process counter is not the authority: the reservation hook is asked per dispatch", async () => {
    const store = freshStore();
    for (let i = 0; i < 3; i += 1) insertTask(store, `r${i}`);
    const asked: string[] = [];

    await runScheduler({
      ...baseParams(store),
      limit: null,
      coupling: independent,
      reserve: (task: Task) => {
        asked.push(task.id);
        return { release: () => {} };
      },
      dispatch: async (task: Task) => okOutcome(task),
    });

    expect([...asked].sort()).toEqual(["r0", "r1", "r2"]);
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

  it("a refused reservation leaves the task ready, not stranded in running", async () => {
    const store = freshStore();
    insertTask(store, "a");

    await runScheduler({
      ...baseParams(store),
      limit: null,
      coupling: independent,
      reserve: () => null,
      dispatch: async (task: Task) => okOutcome(task),
    });

    expect(store.tasks.require("a" as TaskId).status).toBe("ready");
  });
});

describe("PLAN §3.E: ownership conflicts in code, serial when coupling is uncertain", () => {
  it("two tasks claiming the same path never run at the same time", () => {
    const store = freshStore();
    const shared = { paths: ["src/shared.ts"], components: ["ui"] };
    store.tasks.insert(makeTask({ id: "o1" as TaskId, workflowId: WF, phaseId: PH, status: "ready", ownership: shared }));
    store.tasks.insert(makeTask({ id: "o2" as TaskId, workflowId: WF, phaseId: PH, status: "ready", ownership: shared }));

    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, coupling: independent });
    expect(plan.dispatch).toEqual(["o1"]);
    expect(plan.held).toEqual([
      expect.objectContaining({ taskId: "o2", reason: "ownership_conflict" }),
    ]);
  });

  it("an 'independent' coupling verdict cannot override a declared ownership overlap", () => {
    const a = makeTask({ id: "a" as TaskId, ownership: { paths: ["src/x.ts"], components: [] } });
    const b = makeTask({ id: "b" as TaskId, ownership: { paths: ["src/x.ts"], components: [] } });
    expect(conflictsOnOwnership(a, b)).toBe(true);

    const store = freshStore();
    store.tasks.insert({ ...a, workflowId: WF, phaseId: PH, status: "ready" });
    store.tasks.insert({ ...b, workflowId: WF, phaseId: PH, status: "ready" });
    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, coupling: independent });
    expect(plan.dispatch).toHaveLength(1);
  });

  it("uncertain coupling (the no-Jev default) serialises disjoint tasks", () => {
    const store = freshStore();
    insertTask(store, "u1");
    insertTask(store, "u2");

    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, coupling: UNCERTAIN_COUPLING });
    expect(plan.dispatch).toEqual(["u1"]);
    expect(plan.held.map((h) => h.reason)).toEqual(["coupling_uncertain"]);
  });

  it("omitting the coupling signal entirely is the same conservative default", () => {
    const store = freshStore();
    insertTask(store, "v1");
    insertTask(store, "v2");

    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: null });
    expect(plan.dispatch).toEqual(["v1"]);
    expect(plan.held.map((h) => h.reason)).toEqual(["coupling_uncertain"]);
  });

  it("a 'coupled' verdict on disjoint ownership also serialises", () => {
    const store = freshStore();
    insertTask(store, "c1");
    insertTask(store, "c2");

    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, coupling: () => "coupled" });
    expect(plan.dispatch).toEqual(["c1"]);
    expect(plan.held.map((h) => h.reason)).toEqual(["coupled"]);
  });

  it("a task conflicting with something already in flight is held, not dispatched", () => {
    const store = freshStore();
    const shared = { paths: ["src/shared.ts"], components: [] };
    store.tasks.insert(makeTask({ id: "f1" as TaskId, workflowId: WF, phaseId: PH, status: "running", ownership: shared }));
    store.tasks.insert(makeTask({ id: "f2" as TaskId, workflowId: WF, phaseId: PH, status: "ready", ownership: shared }));

    const plan = planPass({
      store,
      phaseIds: [PH],
      inFlight: ["f1" as TaskId],
      limit: null,
      coupling: independent,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.held.map((h) => h.reason)).toEqual(["ownership_conflict"]);
  });
});
