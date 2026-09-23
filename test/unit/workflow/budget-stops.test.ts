/**
 * `src/workflow/budget-stops.ts` (issue #81; PLAN §2.6, §3.E).
 *
 * Test names reference the acceptance criterion they exercise:
 * - AC1 "Cap hit mid-phase → `paused(budget)`, no further model calls (spy)";
 * - AC2 "Raise cap in config → `run` resumes and completes".
 *
 * Plus the properties PLAN §3.E makes non-negotiable for any stop: the stop
 * is HARD (nothing starts after the cap is reached) and it PAUSES rather than
 * failing; it leaves the same resumable shape #74's `stopRun` and #72's
 * reconciliation produce; and spend already recorded survives it, because the
 * ledger is append-only and enforcement stays in `src/telemetry/ledger.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, Task, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  applyBudgetStop,
  budgetReservationHook,
  BudgetGovernor,
  BUDGET_STOP_BLOCKER,
  breachOf,
  remainingBudget,
  resumeAfterCapRaised,
} from "../../../src/workflow/budget-stops.ts";
import { runScheduler, type DispatchOutcome } from "../../../src/workflow/scheduler.ts";
import { startRun } from "../../../src/workflow/run.ts";
import { transitionTask, CAP_BLOCKER_KINDS } from "../../../src/workflow/state.ts";
import { raisePhaseBlocker } from "../../../src/workflow/blockers.ts";
import { BudgetExceededError, Ledger } from "../../../src/telemetry/ledger.ts";
import { budgetsWith, knownUsage } from "../../helpers/ledger.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;
const PH2 = "ph-2" as PhaseId;

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
/**
 * Resuming is a USER act: `state.ts` only lets a user trigger `phase-resume`,
 * and raising a cap in config is the user doing exactly that. The engine
 * actor above stops and pauses; it may not un-pause itself.
 */
const userActor = { kind: "user", identity: "owner" } as const;
const now = (): string => AT;
function newId(): string {
  return `id-${(counter += 1)}`;
}

function freshStore(): Store {
  const dir = makeTempDir("korwf-budget-stops-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }));
  return store;
}

/** A task with disjoint ownership, so ownership never confounds a budget test. */
function insertTask(store: Store, id: string, phaseId: PhaseId = PH): Task {
  const task = makeTask({
    id: id as TaskId,
    workflowId: WF,
    phaseId,
    status: "ready",
    ownership: { paths: [`src/${id}.ts`], components: [id] },
  });
  store.tasks.insert(task);
  return task;
}

/** A ledger over exactly the caps under test; the only budget authority. */
function ledgerOver(store: Store, maxSpendUsd: number | null): Ledger {
  return new Ledger(store, {
    budgets: budgetsWith({ workflow: { maxSpendUsd } }),
    now,
    newId: () => `res-${(counter += 1)}`,
    sessionId: "session-under-test",
  });
}

const independent = (): "independent" => "independent";

function okOutcome(task: Task): DispatchOutcome {
  return { taskId: task.id, ok: true };
}

/** Drive a dispatched task to `done` the way the engine would (`state.ts` only). */
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

describe("AC1: cap hit mid-phase → paused(budget), and nothing further is dispatched", () => {
  it("the scheduler stops dispatching the moment the ledger refuses: no model call after the cap", async () => {
    const store = freshStore();
    for (const id of ["t1", "t2", "t3", "t4"]) insertTask(store, id);
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    // Cap of $0.20 against a $0.10 estimate per task: exactly two dispatches
    // fit, and the third must be refused by the LEDGER, not by a counter here.
    const ledger = ledgerOver(store, 0.2);
    const governor = new BudgetGovernor();
    const dispatched: TaskId[] = [];

    const result = await runScheduler({
      store,
      workflowId: WF,
      phaseIds: [PH],
      actor,
      now,
      newId,
      limit: 1,
      coupling: independent,
      authorizationCurrent: () => true,
      dispatchAllowed: () => true,
      reserve: budgetReservationHook({
        ledger,
        governor,
        workflowId: WF,
        estimateFor: () => knownUsage(0.1),
        // Settled, not released: this is spend the run really incurred, so it
        // stays on the ledger and keeps consuming the cap.
        actualFor: () => knownUsage(0.1),
        now,
      }),
      dispatch: (task: Task) => {
        dispatched.push(task.id);
        markDone(store, task.id);
        return Promise.resolve(okOutcome(task));
      },
    });

    expect(dispatched).toHaveLength(2);
    expect(result.dispatched).toHaveLength(2);
    expect(governor.shouldStop()).toBe(true);
    expect(governor.stopBreach?.cap).toBe("maxSpendUsd");
    expect(governor.stopBreach?.scope).toBe("workflow");
    // The held tasks say why, and are still `ready` — nothing was failed.
    expect(result.held.some((h) => h.reason === "budget_refused")).toBe(true);
    for (const id of ["t3", "t4"]) {
      expect(store.tasks.require(id as TaskId).status).toBe("ready");
    }
  });

  it("once latched, the governor refuses without touching the ledger at all (spy)", () => {
    const store = freshStore();
    const task = insertTask(store, "t1");
    const governor = new BudgetGovernor();
    governor.record(
      breachOf(
        new BudgetExceededError({
          scope: "workflow",
          cap: "maxSpendUsd",
          limit: 1,
          committed: 1,
          requested: 0.5,
        }),
        AT,
        null,
      ),
    );

    let reserveCalls = 0;
    const ledger = ledgerOver(store, null);
    const spy = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === "reserve") {
          return (...args: unknown[]) => {
            reserveCalls += 1;
            return (target.reserve as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Ledger;

    const hook = budgetReservationHook({
      ledger: spy,
      governor,
      workflowId: WF,
      estimateFor: () => knownUsage(0.01),
      now,
    });

    expect(hook(task)).toBeNull();
    expect(reserveCalls).toBe(0);
  });

  it("a maxConcurrency refusal is recorded but does NOT stop the run: it clears when a worker settles", () => {
    const store = freshStore();
    const task = insertTask(store, "t1");
    const governor = new BudgetGovernor();
    const ledger = new Ledger(store, {
      budgets: budgetsWith({ workflow: { maxConcurrency: 0 } }),
      now,
      newId: () => `res-${(counter += 1)}`,
      sessionId: "session-under-test",
    });

    const hook = budgetReservationHook({
      ledger,
      governor,
      workflowId: WF,
      estimateFor: () => knownUsage(0.01),
      now,
    });

    expect(hook(task)).toBeNull();
    expect(governor.breaches).toHaveLength(1);
    expect(governor.breaches[0]?.cap).toBe("maxConcurrency");
    expect(governor.breaches[0]?.cumulative).toBe(false);
    expect(governor.shouldStop()).toBe(false);
  });

  it("applyBudgetStop pauses the phase as paused_cap with a budget_hard_stop blocker: a pause, not a failure", () => {
    const store = freshStore();
    const task = insertTask(store, "t1");
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    const governor = new BudgetGovernor();
    governor.record(
      breachOf(
        new BudgetExceededError({ scope: "workflow", cap: "maxSpendUsd", limit: 1, committed: 1, requested: 0.5 }),
        AT,
        task.id,
      ),
    );

    const stop = applyBudgetStop({ store, workflowId: WF, governor, actor, now, newId, phaseIds: [PH] });

    expect(stop.stopped).toBe(true);
    expect(stop.phases[0]?.ok).toBe(true);
    const phase = store.phases.require(PH);
    expect(phase.gateStatus).toBe("paused_cap");
    // Not failed, not cancelled — PLAN §3.E: the run PAUSES.
    expect(phase.gateStatus).not.toBe("failed");
    const blockers = store.blockers.unresolvedForSubject("phase", PH);
    expect(blockers.map((b) => b.kind)).toContain(BUDGET_STOP_BLOCKER);
    expect(CAP_BLOCKER_KINDS).toContain(BUDGET_STOP_BLOCKER);
    expect(stop.reason).toMatch(/maxSpendUsd/);
  });

  it("does nothing when nothing breached: no phase is paused on a healthy run", () => {
    const store = freshStore();
    insertTask(store, "t1");
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    const stop = applyBudgetStop({
      store,
      workflowId: WF,
      governor: new BudgetGovernor(),
      actor,
      now,
      newId,
      phaseIds: [PH],
    });

    expect(stop.stopped).toBe(false);
    expect(store.phases.require(PH).gateStatus).toBe("running");
  });

  it("a phase-scope breach pauses only the phase that breached, not its siblings", () => {
    const store = freshStore();
    store.phases.insert(makePhase({ id: PH2, workflowId: WF, order: 1, gateStatus: "pending" }));
    const task = insertTask(store, "t1", PH);
    insertTask(store, "t2", PH2);
    startRun({ store, workflowId: WF, phaseIds: [PH, PH2], actor, now, newId, authorizationCurrent: () => true });

    const governor = new BudgetGovernor();
    governor.record(
      breachOf(
        new BudgetExceededError({ scope: "phase", cap: "maxRequests", limit: 2, committed: 2, requested: 1 }),
        AT,
        task.id,
      ),
    );

    applyBudgetStop({ store, workflowId: WF, governor, actor, now, newId, phaseIds: [PH, PH2] });

    expect(store.phases.require(PH).gateStatus).toBe("paused_cap");
    expect(store.phases.require(PH2).gateStatus).toBe("running");
  });
});

describe("The stop leaves RESUMABLE state, the same shape #74 and #72 produce", () => {
  it("keeps the run id, the tasks and the ledger rows: nothing is deleted or rewound", async () => {
    const store = freshStore();
    for (const id of ["t1", "t2", "t3"]) insertTask(store, id);
    const outcome = startRun({
      store,
      workflowId: WF,
      phaseIds: [PH],
      actor,
      now,
      newId,
      authorizationCurrent: () => true,
    });

    const ledger = ledgerOver(store, 0.1);
    const governor = new BudgetGovernor();
    await runScheduler({
      store,
      workflowId: WF,
      phaseIds: [PH],
      actor,
      now,
      newId,
      limit: 1,
      coupling: independent,
      authorizationCurrent: () => true,
      dispatchAllowed: () => true,
      reserve: budgetReservationHook({
        ledger,
        governor,
        workflowId: WF,
        estimateFor: () => knownUsage(0.1),
        actualFor: () => knownUsage(0.1),
        now,
      }),
      dispatch: (task: Task) => {
        markDone(store, task.id);
        return Promise.resolve(okOutcome(task));
      },
    });

    const spentBefore = ledger.status({ workflowId: WF }).scopes.find((s) => s.scope === "workflow")?.spendUsd.used;
    const rowsBefore = store.ledger.count();

    applyBudgetStop({ store, workflowId: WF, governor, actor, now, newId, phaseIds: [PH] });

    // Same resumable shape as a #74 stop: paused, blocker naming why, runId
    // intact, undispatched tasks still `ready`.
    const phase = store.phases.require(PH);
    expect(phase.gateStatus).toBe("paused_cap");
    expect(phase.runId).toBe(outcome.runId);
    expect(store.runs.get(outcome.runId)).toBeDefined();
    expect(store.tasks.require("t3" as TaskId).status).toBe("ready");

    // Append-only: the stop added no ledger rows and removed none, and the
    // spend it recorded is still there.
    expect(store.ledger.count()).toBe(rowsBefore);
    const spentAfter = ledger.status({ workflowId: WF }).scopes.find((s) => s.scope === "workflow")?.spendUsd.used;
    expect(spentAfter).toBe(spentBefore);
    expect(spentAfter).toBeCloseTo(0.1, 6);
  });

  it("survives a restart: a fresh Store over the same root reads the paused phase and the spend back", () => {
    const dir = makeTempDir("korwf-budget-stops-restart-");
    const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId });
    open.push({ dir, store });
    store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
    store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }));
    const task = insertTask(store, "t1");
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    const ledger = ledgerOver(store, 1);
    const reservation = ledger.reserve({ scope: { workflowId: WF, phaseId: PH, taskId: task.id }, estimate: knownUsage(0.4) });
    ledger.settle(reservation, knownUsage(0.4));

    const governor = new BudgetGovernor();
    governor.record(
      breachOf(
        new BudgetExceededError({ scope: "workflow", cap: "maxSpendUsd", limit: 0.4, committed: 0.4, requested: 0.4 }),
        AT,
        task.id,
      ),
    );
    applyBudgetStop({ store, workflowId: WF, governor, actor, now, newId, phaseIds: [PH] });
    store.close();

    const reopened = openStore({ storageRoot: dir.path, writable: false, reconcile: false });
    expect(reopened.store.phases.require(PH).gateStatus).toBe("paused_cap");
    expect(reopened.store.blockers.unresolvedForSubject("phase", PH).map((b) => b.kind)).toContain(
      BUDGET_STOP_BLOCKER,
    );
    const reread = new Ledger(reopened.store, {
      budgets: budgetsWith({ workflow: { maxSpendUsd: 1 } }),
      now,
      newId,
      sessionId: "session-2",
    });
    expect(reread.status({ workflowId: WF }).scopes.find((s) => s.scope === "workflow")?.spendUsd.used).toBeCloseTo(
      0.4,
      6,
    );
    reopened.store.close();
  });
});

describe("AC2: raise the cap in config → run resumes and completes", () => {
  it("resumes the paused phase against a ledger over the NEW caps and finishes the remaining tasks", async () => {
    const store = freshStore();
    for (const id of ["t1", "t2", "t3"]) insertTask(store, id);
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    const governor = new BudgetGovernor();
    const dispatchedFirst: TaskId[] = [];
    const tight = ledgerOver(store, 0.1);
    await runScheduler({
      store,
      workflowId: WF,
      phaseIds: [PH],
      actor,
      now,
      newId,
      limit: 1,
      coupling: independent,
      authorizationCurrent: () => true,
      dispatchAllowed: () => true,
      reserve: budgetReservationHook({
        ledger: tight,
        governor,
        workflowId: WF,
        estimateFor: () => knownUsage(0.1),
        actualFor: () => knownUsage(0.1),
        now,
      }),
      dispatch: (task: Task) => {
        dispatchedFirst.push(task.id);
        markDone(store, task.id);
        return Promise.resolve(okOutcome(task));
      },
    });
    applyBudgetStop({ store, workflowId: WF, governor, actor, now, newId, phaseIds: [PH] });
    expect(dispatchedFirst).toHaveLength(1);
    expect(store.phases.require(PH).gateStatus).toBe("paused_cap");

    // The user raises the cap in config. A ledger over the RELOADED budgets.
    const raised = ledgerOver(store, 1);
    const resume = resumeAfterCapRaised({
      store,
      workflowId: WF,
      ledger: raised,
      governor,
      actor: userActor,
      now,
      newId,
      phaseIds: [PH],
    });

    expect(resume.refusal).toBeNull();
    expect(resume.resumed).toBe(true);
    expect(governor.shouldStop()).toBe(false);
    // `phase-resume` lands in `pending`: the user re-enters through `run`.
    expect(store.phases.require(PH).gateStatus).toBe("pending");
    expect(store.blockers.unresolvedForSubject("phase", PH)).toHaveLength(0);

    // `run` again, and the run completes: the earlier spend is still charged
    // against the new cap, and the remaining tasks all dispatch.
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });
    const dispatchedSecond: TaskId[] = [];
    await runScheduler({
      store,
      workflowId: WF,
      phaseIds: [PH],
      actor,
      now,
      newId,
      limit: 1,
      coupling: independent,
      authorizationCurrent: () => true,
      dispatchAllowed: () => true,
      reserve: budgetReservationHook({
        ledger: raised,
        governor,
        workflowId: WF,
        estimateFor: () => knownUsage(0.1),
        actualFor: () => knownUsage(0.1),
        now,
      }),
      dispatch: (task: Task) => {
        dispatchedSecond.push(task.id);
        markDone(store, task.id);
        return Promise.resolve(okOutcome(task));
      },
    });

    expect([...dispatchedSecond].sort()).toEqual(["t2", "t3"]);
    for (const id of ["t1", "t2", "t3"]) {
      expect(store.tasks.require(id as TaskId).status).toBe("done");
    }
    // Spend accumulated across the stop; the pre-stop $0.10 was never rolled back.
    const spend = raised.status({ workflowId: WF }).scopes.find((s) => s.scope === "workflow")?.spendUsd.used;
    expect(spend).toBeCloseTo(0.3, 6);
  });

  it("refuses to resume while the NEW cap is still exhausted: the phase stays paused", () => {
    const store = freshStore();
    const task = insertTask(store, "t1");
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    const ledger = ledgerOver(store, 1);
    const reservation = ledger.reserve({ scope: { workflowId: WF, phaseId: PH, taskId: task.id }, estimate: knownUsage(0.5) });
    ledger.settle(reservation, knownUsage(0.5));

    const governor = new BudgetGovernor();
    governor.record(
      breachOf(
        new BudgetExceededError({ scope: "workflow", cap: "maxSpendUsd", limit: 0.5, committed: 0.5, requested: 0.5 }),
        AT,
        task.id,
      ),
    );
    applyBudgetStop({ store, workflowId: WF, governor, actor, now, newId, phaseIds: [PH] });

    // "Raised" to exactly what is already spent: still no headroom.
    const barely = ledgerOver(store, 0.5);
    const resume = resumeAfterCapRaised({
      store,
      workflowId: WF,
      ledger: barely,
      governor,
      actor: userActor,
      now,
      newId,
      phaseIds: [PH],
    });

    expect(resume.resumed).toBe(false);
    expect(resume.refusal).toMatch(/still exhausted/);
    expect(store.phases.require(PH).gateStatus).toBe("paused_cap");
    expect(governor.shouldStop()).toBe(true);
  });

  it("raising a budget is not permission for anything else: another blocker keeps the phase paused", () => {
    const store = freshStore();
    const task = insertTask(store, "t1");
    startRun({ store, workflowId: WF, phaseIds: [PH], actor, now, newId, authorizationCurrent: () => true });

    const governor = new BudgetGovernor();
    governor.record(
      breachOf(
        new BudgetExceededError({ scope: "workflow", cap: "maxSpendUsd", limit: 1, committed: 1, requested: 0.5 }),
        AT,
        task.id,
      ),
    );
    applyBudgetStop({ store, workflowId: WF, governor, actor, now, newId, phaseIds: [PH] });
    raisePhaseBlocker({
      store,
      actor,
      now,
      newId,
      phaseId: PH,
      kind: "awaiting_approval",
      detail: "scope change needs the owner",
    });

    const resume = resumeAfterCapRaised({
      store,
      workflowId: WF,
      ledger: ledgerOver(store, 10),
      governor,
      actor: userActor,
      now,
      newId,
      phaseIds: [PH],
    });

    expect(resume.resumed).toBe(false);
    expect(resume.phases[0]?.reason ?? "").toMatch(/awaiting_approval/);
    expect(store.phases.require(PH).gateStatus).toBe("paused_cap");
  });
});

describe("Status shows remaining budget per scope", () => {
  it("reports headroom per scope from the ledger's own status, marking cumulative exhaustion only", () => {
    const store = freshStore();
    const task = insertTask(store, "t1");
    const ledger = ledgerOver(store, 1);
    const reservation = ledger.reserve({ scope: { workflowId: WF, phaseId: PH, taskId: task.id }, estimate: knownUsage(0.75) });
    ledger.settle(reservation, knownUsage(0.75));

    const remaining = remainingBudget(ledger, { workflowId: WF, phaseId: PH, taskId: task.id });
    const workflow = remaining.find((r) => r.scope === "workflow");

    expect(workflow).toBeDefined();
    expect(workflow?.id).toBe(WF);
    const spend = workflow?.caps.find((c) => c.cap === "maxSpendUsd");
    expect(spend?.limit).toBe(1);
    expect(spend?.used).toBeCloseTo(0.75, 6);
    expect(spend?.remaining).toBeCloseTo(0.25, 6);
    expect(workflow?.exhausted).toBe(false);
    // Every scope a task-level charge touches is reported.
    expect(remaining.map((r) => r.scope)).toEqual(["workflow", "phase", "task"]);
  });

  it("an uncapped scope reports null, never a fabricated zero, and unknown cost is counted separately", () => {
    const store = freshStore();
    const task = insertTask(store, "t1");
    const ledger = ledgerOver(store, null);
    const reservation = ledger.reserve({
      scope: { workflowId: WF, phaseId: PH, taskId: task.id },
      estimate: { inputTokens: null, outputTokens: null, requests: 1, spendUsd: null, costBasis: "unknown" },
    });
    ledger.settle(reservation, { inputTokens: null, outputTokens: null, requests: 1, spendUsd: null, costBasis: "unknown" });

    const workflow = remainingBudget(ledger, { workflowId: WF, phaseId: PH, taskId: task.id }).find(
      (r) => r.scope === "workflow",
    );

    const spend = workflow?.caps.find((c) => c.cap === "maxSpendUsd");
    expect(spend?.limit).toBeNull();
    expect(spend?.remaining).toBeNull();
    expect(spend?.exhausted).toBe(false);
    expect(workflow?.unknownCostRequests).toBe(1);
  });
});

