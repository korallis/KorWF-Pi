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
import type { PhaseId, TaskId, TaskStatus, WorkflowId } from "../../../src/storage/records.ts";
import {
  PHASE_STATES,
  PHASE_TRANSITIONS,
  TASK_STATES,
  TASK_TRANSITIONS,
  type PhaseState,
} from "../../../src/workflow/transitions.ts";
import {
  TransitionRejected,
  evaluateGuards,
  findPhaseTransition,
  findTaskTransition,
  hasExecutableCheck,
  isLegalPhaseEdge,
  isLegalTaskEdge,
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
const WF = "wf-1" as WorkflowId;
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

  function requestDone(store: Store, guards: GuardTable) {
    return transitionTask({
      store,
      taskId: TK,
      to: "done",
      trigger: "task_gate_passed",
      actor: { kind: "engine", identity: "engine" },
      guards,
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
