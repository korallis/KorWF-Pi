/**
 * `src/workflow/state.ts` (issue #41): the runtime task/phase state machine.
 *
 * Acceptance criteria exercised here:
 *  - AC1 "Every illegal transition in the Stage 1 table is rejected
 *    (table-driven test)" — `describe("AC1: ...")` enumerates every
 *    (from, to) pair of both tables and asserts the listed ones are the only
 *    ones accepted.
 *  - AC2 "`done` is unreachable without evidence records satisfying the gate
 *    preconditions (the precondition hook exists and defaults to reject)".
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId, TaskStatus } from "../../../src/storage/records.ts";
import {
  PHASE_STATES,
  PHASE_TRANSITIONS,
  TASK_STATES,
  TASK_TRANSITIONS,
  type PhaseState,
} from "../../../src/workflow/transitions.ts";
import {
  TransitionRejected,
  advanceGatingSubstage,
  allPhaseTasksDone,
  evaluateGuards,
  findPhaseTransition,
  findTaskTransition,
  hasExecutableCheck,
  isGateReviewStage,
  isLegalPhaseEdge,
  isLegalTaskEdge,
  phaseDoneGuards,
  phaseLifecycleState,
  taskDoneGuards,
  transitionPhase,
  transitionTask,
  type GuardContext,
  type GuardTable,
} from "../../../src/workflow/state.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const PH = "ph-1" as PhaseId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function freshStore(): Store {
  const dir = makeTempDir("korwf-state-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ planRevision: 1, status: "running" }));
  store.phases.insert(makePhase());
  return store;
}

function newId(): string {
  return `id-${(counter += 1)}`;
}

/**
 * A passing task-gate receipt for `taskId` (#46).
 *
 * `task-done` now requires one: the store refuses the status write without a
 * passing, unconsumed, revision-matched receipt. These tests are about the
 * *edge*, so they mint a receipt directly; the receipt's own contents are
 * exercised in `test/unit/verification/task-gate.test.ts`.
 */
function passingReceipt(store: Store, taskId: string = TK): string {
  const receiptId = `rcpt-${(counter += 1)}`;
  const task = store.tasks.require(taskId);
  store.gateReceipts.record({
    receiptId,
    createdAt: AT,
    workflowId: task.workflowId,
    gate: "task",
    subjectId: task.id,
    subjectRevision: task.revision,
    revision: "a".repeat(40),
    disposition: "pass",
    reasonCode: null,
    detail: null,
    inputHash: "c".repeat(64),
    evaluatedAt: AT,
    consumedAt: null,
    conditions: [],
  });
  return receiptId;
}

/** An actor a given transition row permits. */
function actorFor(whoMayTrigger: readonly string[]): { kind: "engine" | "user" | "worker"; identity: string } {
  if (whoMayTrigger.includes("engine_only")) return { kind: "engine", identity: "test-engine" };
  if (whoMayTrigger.includes("user")) return { kind: "user", identity: "owner" };
  return { kind: "worker", identity: "worker-1" };
}

/** Every guard true: used to prove that only the *edge* is what gets rejected. */
function allGuardsTrue(): GuardTable {
  const table: Record<string, () => true> = {};
  for (const row of [...TASK_TRANSITIONS, ...PHASE_TRANSITIONS]) {
    for (const precondition of row.preconditions) table[precondition] = () => true;
  }
  return table as GuardTable;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("the tables are the contract", () => {
  it("accepts only listed task edges", () => {
    expect(isLegalTaskEdge("proposed", "ready")).toBe(true);
    expect(isLegalTaskEdge("proposed", "done")).toBe(false);
    expect(isLegalTaskEdge("ready", "done")).toBe(false);
  });

  it("accepts only listed phase edges", () => {
    expect(isLegalPhaseEdge("pending", "running")).toBe(true);
    expect(isLegalPhaseEdge("pending", "done")).toBe(false);
    expect(isLegalPhaseEdge("running", "done")).toBe(false);
  });

  it("projects every persisted gate status onto a lifecycle state", () => {
    expect(phaseLifecycleState("integrating")).toBe("gating");
    expect(phaseLifecycleState("review")).toBe("gating");
    expect(phaseLifecycleState("paused_approval")).toBe("paused");
    expect(phaseLifecycleState("passed")).toBe("done");
  });
});

describe("AC1: every illegal transition in the Stage 1 table is rejected", () => {
  // Every ordered pair of task states, with every guard satisfied and the
  // engine as actor, so the *only* reason a request can fail is the edge.
  const taskPairs: { from: TaskStatus; to: TaskStatus }[] = [];
  for (const from of TASK_STATES) for (const to of TASK_STATES) taskPairs.push({ from, to });

  for (const { from, to } of taskPairs) {
    const listed = findTaskTransition(from, to);
    const label = `task ${from} -> ${to}`;
    if (listed === undefined) {
      it(`rejects unlisted ${label}`, () => {
        const store = freshStore();
        store.tasks.insert(makeTask({ status: from }));
        let error: unknown;
        try {
          transitionTask({
            store,
            taskId: TK,
            to,
            // Use a real trigger so the refusal is about the edge, not the name.
            trigger: TASK_TRANSITIONS[0].trigger,
            actor: { kind: "engine", identity: "test" },
            guards: allGuardsTrue(),
            evidenceRefs: ["ev:1"],
            now: () => AT,
            newId,
          });
        } catch (caught) {
          error = caught;
        }
        expect(error, label).toBeInstanceOf(TransitionRejected);
        const rejected = error as TransitionRejected;
        expect(["unlisted_edge", "terminal_subject", "unknown_trigger"]).toContain(rejected.code);
        // Nothing changed, and the refusal is on the record.
        expect(store.tasks.require(TK).status).toBe(from);
        expect(rejected.event?.disposition).toBe("rejected");
        expect(rejected.event?.beforeHash).toBe(rejected.event?.afterHash);
      });
      continue;
    }
    it(`accepts listed ${label} (${listed.id}) when every guard holds`, () => {
      const store = freshStore();
      store.tasks.insert(makeTask({ status: from }));
      const result = transitionTask({
        store,
        taskId: TK,
        to,
        trigger: listed.trigger,
        // Some rows (task-replan) are user-triggered only; use an actor the
        // row allows, so this test is about the edge and not authorisation.
        actor: actorFor(listed.whoMayTrigger),
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        ...(to === "blocked" ? { blocker: { kind: "dependency", detail: "dep not done" } } : {}),
        ...(to === "done" ? { gateReceiptId: passingReceipt(store) } : {}),
        now: () => AT,
        newId,
      });
      expect(result.subject.status).toBe(to);
      expect(result.transitionId).toBe(listed.id);
      expect(result.event.disposition).toBe("accepted");
    });
  }
});

describe("AC1: the same, for every phase (from, to) pair", () => {
  const pairs: { from: PhaseState; to: PhaseState }[] = [];
  for (const from of PHASE_STATES) for (const to of PHASE_STATES) pairs.push({ from, to });

  for (const { from, to } of pairs) {
    const listed = findPhaseTransition(from, to);
    const label = `phase ${from} -> ${to}`;
    const gateStatus = from === "gating" ? "integrating" : from === "paused" ? "paused_cap" : from === "done" ? "passed" : from;

    if (listed === undefined) {
      it(`rejects unlisted ${label}`, () => {
        const store = freshStore();
        store.phases.update(PH, { gateStatus });
        let error: unknown;
        try {
          transitionPhase({
            store,
            phaseId: PH,
            to,
            trigger: PHASE_TRANSITIONS[0].trigger,
            actor: { kind: "engine", identity: "test" },
            guards: allGuardsTrue(),
            evidenceRefs: ["ev:1"],
            now: () => AT,
            newId,
          });
        } catch (caught) {
          error = caught;
        }
        expect(error, label).toBeInstanceOf(TransitionRejected);
        expect(["unlisted_edge", "terminal_subject", "unknown_trigger"]).toContain((error as TransitionRejected).code);
        expect(store.phases.require(PH).gateStatus).toBe(gateStatus);
      });
      continue;
    }
    it(`accepts listed ${label} (${listed.id}) when every guard holds`, () => {
      const store = freshStore();
      store.phases.update(PH, { gateStatus });
      const result = transitionPhase({
        store,
        phaseId: PH,
        to,
        trigger: listed.trigger,
        actor: actorFor(listed.whoMayTrigger),
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      });
      expect(phaseLifecycleState(result.subject.gateStatus)).toBe(to);
      expect(result.transitionId).toBe(listed.id);
    });
  }
});

describe("AC2: done is unreachable without the gate preconditions", () => {
  function reviewTask(store: Store): void {
    store.tasks.insert(makeTask({ status: "review" }));
  }

  function requestDone(store: Store, guards: GuardTable, gateReceiptId?: string) {
    return transitionTask({
      store,
      taskId: TK,
      to: "done",
      trigger: "task_gate_passed",
      actor: { kind: "engine", identity: "engine" },
      guards,
      ...(gateReceiptId === undefined ? {} : { gateReceiptId }),
      evidenceRefs: ["ev:checks", "ev:coverage", "ev:review"],
      gitRevision: "a".repeat(40),
      now: () => AT,
      newId,
    });
  }

  it("rejects done when no gate hooks are supplied at all (the default)", () => {
    const store = freshStore();
    reviewTask(store);
    expect(() => requestDone(store, taskDoneGuards())).toThrow(TransitionRejected);
    expect(store.tasks.require(TK).status).toBe("review");
  });

  it("names every unsatisfied gate guard on the rejection and its audit row", () => {
    const store = freshStore();
    reviewTask(store);
    let error: TransitionRejected | undefined;
    try {
      requestDone(store, taskDoneGuards());
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("precondition_failed");
    expect([...(error?.failedGuards ?? [])].sort()).toEqual([
      "all_checks_pass_exact_revision",
      "no_jev_gap_or_disabled",
      "policy_review_satisfied",
    ]);
    const events = store.transitionLog.rejectionsForSubject("task", TK);
    expect(events).toHaveLength(1);
    expect(events[0]?.failedGuards.length).toBe(3);
    expect(events[0]?.beforeHash).toBe(events[0]?.afterHash);
  });

  for (const omitted of [
    "allChecksPassAtExactRevision",
    "noJevGapOrDisabled",
    "policyReviewSatisfied",
  ] as const) {
    it(`rejects done when only ${omitted} is missing`, () => {
      const store = freshStore();
      reviewTask(store);
      const full = {
        allChecksPassAtExactRevision: () => true as const,
        noJevGapOrDisabled: () => true as const,
        policyReviewSatisfied: () => true as const,
      };
      const partial = { ...full };
      delete (partial as Record<string, unknown>)[omitted];
      expect(() => requestDone(store, taskDoneGuards(partial))).toThrow(TransitionRejected);
      expect(store.tasks.require(TK).status).toBe("review");
    });
  }

  it("rejects done when a gate evaluator answers \"unknown\" — unknown is not pass", () => {
    const store = freshStore();
    reviewTask(store);
    expect(() =>
      requestDone(
        store,
        taskDoneGuards({
          allChecksPassAtExactRevision: () => "unknown",
          noJevGapOrDisabled: () => true,
          policyReviewSatisfied: () => true,
        }),
      ),
    ).toThrow(TransitionRejected);
    expect(store.tasks.require(TK).status).toBe("review");
  });

  it("rejects done when a gate evaluator throws", () => {
    const store = freshStore();
    reviewTask(store);
    expect(() =>
      requestDone(
        store,
        taskDoneGuards({
          allChecksPassAtExactRevision: () => {
            throw new Error("check runner unavailable");
          },
          noJevGapOrDisabled: () => true,
          policyReviewSatisfied: () => true,
        }),
      ),
    ).toThrow(TransitionRejected);
    expect(store.tasks.require(TK).status).toBe("review");
  });

  it("rejects done for a task with no executable check, even with every hook passing", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "review", checks: [] }));
    expect(() =>
      requestDone(
        store,
        taskDoneGuards({
          allChecksPassAtExactRevision: () => true,
          noJevGapOrDisabled: () => true,
          policyReviewSatisfied: () => true,
        }),
      ),
    ).toThrow(/checks_registered/);
    expect(store.tasks.require(TK).status).toBe("review");
  });

  it("a worker request can never set done, whatever it supplies", () => {
    const store = freshStore();
    reviewTask(store);
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "done",
        trigger: "task_gate_passed",
        actor: { kind: "worker", identity: "worker-1" },
        guards: taskDoneGuards({
          allChecksPassAtExactRevision: () => true,
          noJevGapOrDisabled: () => true,
          policyReviewSatisfied: () => true,
        }),
        evidenceRefs: ["ev:claim"],
        now: () => AT,
        newId,
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("unauthorized_actor");
    expect(store.tasks.require(TK).status).toBe("review");
  });

  it("a user instruction can never set done", () => {
    const store = freshStore();
    reviewTask(store);
    expect(() =>
      transitionTask({
        store,
        taskId: TK,
        to: "done",
        trigger: "task_gate_passed",
        actor: { kind: "user", identity: "owner" },
        guards: taskDoneGuards({
          allChecksPassAtExactRevision: () => true,
          noJevGapOrDisabled: () => true,
          policyReviewSatisfied: () => true,
        }),
        evidenceRefs: ["ev:user"],
        now: () => AT,
        newId,
      }),
    ).toThrow(/may not trigger task-done/);
  });

  it("accepts done only from review with the full conjunction satisfied", () => {
    const store = freshStore();
    reviewTask(store);
    const result = requestDone(
      store,
      taskDoneGuards({
        allChecksPassAtExactRevision: () => true,
        noJevGapOrDisabled: () => true,
        policyReviewSatisfied: () => true,
      }),
      passingReceipt(store),
    );
    expect(result.subject.status).toBe("done");
    expect(result.event.gitRevision).toBe("a".repeat(40));
    expect(result.event.disposition).toBe("accepted");
  });

  it("a done task is terminal: no further transition is accepted", () => {
    const store = freshStore();
    reviewTask(store);
    requestDone(
      store,
      taskDoneGuards({
        allChecksPassAtExactRevision: () => true,
        noJevGapOrDisabled: () => true,
        policyReviewSatisfied: () => true,
      }),
      passingReceipt(store),
    );
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "cancelled",
        trigger: "cancel",
        actor: { kind: "user", identity: "owner" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("terminal_subject");
    expect(store.tasks.require(TK).status).toBe("done");
  });
});

describe("ready requires at least one executable check, at transition time too", () => {
  it("refuses ready for a task with no checks", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "proposed", checks: [] }));
    expect(() =>
      transitionTask({
        store,
        taskId: TK,
        to: "ready",
        trigger: "readiness_validated",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      }),
    ).toThrow(/checks_registered/);
    expect(store.tasks.require(TK).status).toBe("proposed");
  });

  it("refuses ready for a task whose only check is an optional human check", () => {
    const store = freshStore();
    store.tasks.insert(
      makeTask({
        status: "proposed",
        checks: [
          {
            id: "chk-h",
            kind: "human",
            command: "reviewer confirms the acceptance criterion",
            cwd: ".",
            expectedExitCode: 0,
            coversCriteria: ["ac-1"],
            required: false,
          },
        ],
      }),
    );
    expect(hasExecutableCheck(store.tasks.require(TK))).toBe(false);
    expect(() =>
      transitionTask({
        store,
        taskId: TK,
        to: "ready",
        trigger: "readiness_validated",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      }),
    ).toThrow(/checks_registered/);
  });

  it("accepts a required human check as a registered means of verification", () => {
    const store = freshStore();
    store.tasks.insert(
      makeTask({
        status: "proposed",
        checks: [
          {
            id: "chk-h",
            kind: "human",
            command: "reviewer confirms the acceptance criterion",
            cwd: ".",
            expectedExitCode: 0,
            coversCriteria: ["ac-1"],
            required: true,
          },
        ],
      }),
    );
    expect(hasExecutableCheck(store.tasks.require(TK))).toBe(true);
  });

  it("refuses ready while a dependency is not done, whatever the caller claims", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "tk-dep" as TaskId, status: "running" }));
    store.tasks.insert(makeTask({ status: "proposed", dependencies: ["tk-dep" as TaskId] }));
    expect(() =>
      transitionTask({
        store,
        taskId: TK,
        to: "ready",
        trigger: "readiness_validated",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      }),
    ).toThrow(/readiness_valid/);
  });

  it("accepts ready once the dependency is done", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ id: "tk-dep" as TaskId, status: "done" }));
    store.tasks.insert(makeTask({ status: "proposed", dependencies: ["tk-dep" as TaskId] }));
    const result = transitionTask({
      store,
      taskId: TK,
      to: "ready",
      trigger: "readiness_validated",
      actor: { kind: "engine", identity: "engine" },
      guards: allGuardsTrue(),
      evidenceRefs: ["ev:1"],
      now: () => AT,
      newId,
    });
    expect(result.subject.status).toBe("ready");
  });
});

describe("guard evaluation fails closed in every shape", () => {
  const context = {} as GuardContext;

  it("an omitted evaluator is a failure, not a pass", () => {
    expect(evaluateGuards(["checks_registered"], {}, context)).toEqual({
      satisfied: false,
      failed: ["checks_registered"],
    });
  });

  it("false, unknown and throwing all fail, and all failures are reported", () => {
    const result = evaluateGuards(
      ["checks_registered", "readiness_valid", "authorization_current"],
      {
        checks_registered: () => false,
        readiness_valid: () => "unknown",
        authorization_current: () => {
          throw new Error("boom");
        },
      },
      context,
    );
    expect(result.satisfied).toBe(false);
    expect(result.failed).toHaveLength(3);
  });

  it("only an explicit `true` satisfies a guard", () => {
    expect(evaluateGuards(["checks_registered"], { checks_registered: () => true }, context).satisfied).toBe(true);
  });
});

describe("every attempt is audited, accepted or rejected", () => {
  it("records revisions, mode, policy and actor on an accepted transition", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    const result = transitionTask({
      store,
      taskId: TK,
      to: "running",
      trigger: "dispatch",
      actor: { kind: "engine", identity: "engine" },
      guards: allGuardsTrue(),
      evidenceRefs: ["ev:auth", "ev:budget"],
      gitRevision: "b".repeat(40),
      now: () => AT,
      newId,
    });
    const event = store.transitionLog.get(result.event.eventId);
    expect(event?.fromState).toBe("ready");
    expect(event?.toState).toBe("running");
    expect(event?.transitionId).toBe("task-dispatch");
    expect(event?.taskRevision).toBe(1);
    expect(event?.planRevision).toBe(1);
    expect(event?.mode).toBe("supervised");
    expect(event?.policyVersion).toBeTruthy();
    expect(event?.actor).toEqual({ kind: "engine", identity: "engine" });
    expect(event?.evidenceRefs).toEqual(["ev:auth", "ev:budget"]);
    expect(event?.beforeHash).not.toBe(event?.afterHash);
  });

  it("a rejection is persisted even though the transaction rolled back", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    expect(() =>
      transitionTask({
        store,
        taskId: TK,
        to: "done",
        trigger: "task_gate_passed",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      }),
    ).toThrow(TransitionRejected);
    const events = store.transitionLog.forSubject("task", TK);
    expect(events).toHaveLength(1);
    expect(events[0]?.disposition).toBe("rejected");
    expect(store.tasks.require(TK).status).toBe("ready");
  });

  it("the transition log cannot be updated or deleted", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    const result = transitionTask({
      store,
      taskId: TK,
      to: "running",
      trigger: "dispatch",
      actor: { kind: "engine", identity: "engine" },
      guards: allGuardsTrue(),
      evidenceRefs: ["ev:1"],
      now: () => AT,
      newId,
    });
    expect(() =>
      store.connection
        .prepare("UPDATE transition_event SET disposition = 'accepted' WHERE eventId = ?")
        .run(result.event.eventId),
    ).toThrow(/append-only/);
    expect(() =>
      store.connection.prepare("DELETE FROM transition_event WHERE eventId = ?").run(result.event.eventId),
    ).toThrow(/append-only/);
  });

  it("rejects a request made against a stale snapshot", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "running",
        trigger: "dispatch",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        expected: { status: "proposed", revision: 1 },
        now: () => AT,
        newId,
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("stale_snapshot");
    expect(store.tasks.require(TK).status).toBe("ready");
  });

  it("rejects an edge that requires evidence when none is supplied", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "running",
        trigger: "dispatch",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        now: () => AT,
        newId,
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("missing_evidence");
  });

  it("rejects an unknown trigger and an unknown target state", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    let unknownTrigger: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "running",
        trigger: "make_it_so",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      });
    } catch (caught) {
      unknownTrigger = caught as TransitionRejected;
    }
    expect(unknownTrigger?.code).toBe("unknown_trigger");

    let unknownState: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "finished" as TaskStatus,
        trigger: "dispatch",
        actor: { kind: "engine", identity: "engine" },
        guards: allGuardsTrue(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      });
    } catch (caught) {
      unknownState = caught as TransitionRejected;
    }
    expect(unknownState?.code).toBe("unknown_state");
  });
});

describe("phase gating is entered at its first substage and walked, not skipped", () => {
  it("phase-gate stores `integrating`, not `review`", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "running" });
    store.tasks.insert(makeTask({ status: "done" }));
    const result = transitionPhase({
      store,
      phaseId: PH,
      to: "gating",
      trigger: "tasks_completed",
      actor: { kind: "engine", identity: "engine" },
      guards: { all_tasks_done: allPhaseTasksDone, authorization_current: () => true },
      evidenceRefs: ["ev:receipts"],
      now: () => AT,
      newId,
    });
    expect(result.subject.gateStatus).toBe("integrating");
    expect(isGateReviewStage(result.subject)).toBe(false);
  });

  it("advances integrating -> verifying -> review and refuses to go past review", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "integrating" });
    expect(advanceGatingSubstage({ store, phaseId: PH, now: () => AT }).gateStatus).toBe("verifying");
    const atReview = advanceGatingSubstage({ store, phaseId: PH, now: () => AT });
    expect(atReview.gateStatus).toBe("review");
    expect(isGateReviewStage(atReview)).toBe(true);
    expect(() => advanceGatingSubstage({ store, phaseId: PH, now: () => AT })).toThrow(TransitionRejected);
  });

  it("refuses to advance substages on a phase that is not gating", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "running" });
    expect(() => advanceGatingSubstage({ store, phaseId: PH, now: () => AT })).toThrow(/not gating/);
  });

  it("all_tasks_done is false when any task of the phase is not done", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "running" });
    store.tasks.insert(makeTask({ status: "done" }));
    store.tasks.insert(makeTask({ id: "tk-2" as TaskId, status: "failed" }));
    expect(() =>
      transitionPhase({
        store,
        phaseId: PH,
        to: "gating",
        trigger: "tasks_completed",
        actor: { kind: "engine", identity: "engine" },
        guards: { all_tasks_done: allPhaseTasksDone, authorization_current: () => true },
        evidenceRefs: ["ev:receipts"],
        now: () => AT,
        newId,
      }),
    ).toThrow(/all_tasks_done/);
  });

  it("phase-done is unreachable with no gate hooks supplied", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "review" });
    expect(() =>
      transitionPhase({
        store,
        phaseId: PH,
        to: "done",
        trigger: "phase_gate_passed",
        actor: { kind: "engine", identity: "engine" },
        guards: phaseDoneGuards(),
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId,
      }),
    ).toThrow(TransitionRejected);
    expect(store.phases.require(PH).gateStatus).toBe("review");
  });

  it("a cap pause stores paused_cap; an approval pause stores paused_approval", () => {
    const capStore = freshStore();
    capStore.phases.update(PH, { gateStatus: "running" });
    const capped = transitionPhase({
      store: capStore,
      phaseId: PH,
      to: "paused",
      trigger: "all_candidates_capped",
      actor: { kind: "engine", identity: "engine" },
      guards: { all_eligible_models_capped: () => true },
      evidenceRefs: ["ev:availability"],
      now: () => AT,
      newId,
    });
    expect(capped.subject.gateStatus).toBe("paused_cap");

    const approvalStore = freshStore();
    approvalStore.phases.update(PH, { gateStatus: "running" });
    const paused = transitionPhase({
      store: approvalStore,
      phaseId: PH,
      to: "paused",
      trigger: "phase_stop",
      actor: { kind: "user", identity: "owner" },
      guards: { phase_stop_present: () => true },
      evidenceRefs: ["ev:request"],
      blocker: { kind: "user_pause", detail: "owner asked to stop" },
      now: () => AT,
      newId,
    });
    expect(paused.subject.gateStatus).toBe("paused_approval");
  });

  it("phase-stale-evidence returns the substage to verifying", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "review" });
    const result = transitionPhase({
      store,
      phaseId: PH,
      to: "gating",
      trigger: "git_revision_changed",
      actor: { kind: "engine", identity: "engine" },
      guards: { revision_changed: () => true },
      evidenceRefs: ["ev:old-sha", "ev:new-sha"],
      now: () => AT,
      newId,
    });
    expect(result.subject.gateStatus).toBe("verifying");
  });
});
