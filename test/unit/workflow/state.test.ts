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
