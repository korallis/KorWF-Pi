/**
 * `src/workflow/blockers.ts` (issue #41): "Blocker add/remove API; `blocked`
 * is derived, not set directly."
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId } from "../../../src/storage/records.ts";
import {
  BLOCKER_KINDS,
  activeBlockers,
  describeBlockers,
  isBlocked,
  raisePhaseBlocker,
  raiseTaskBlocker,
  resolveBlocker,
  resolveBlockersOfKind,
} from "../../../src/workflow/blockers.ts";
import { TransitionRejected, transitionTask } from "../../../src/workflow/state.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const PH = "ph-1" as PhaseId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function freshStore(): Store {
  const dir = makeTempDir("korwf-blockers-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ planRevision: 1, status: "running" }));
  store.phases.insert(makePhase());
  return store;
}

function ctx(store: Store) {
  return {
    store,
    actor: { kind: "engine", identity: "engine" } as const,
    now: () => AT,
    newId: () => `id-${(counter += 1)}`,
  };
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("raising a blocker drives the task to blocked", () => {
  it("records the reason and transitions the task in one go", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    const result = raiseTaskBlocker({
      ...ctx(store),
      taskId: TK,
      kind: BLOCKER_KINDS.dependency,
      detail: "tk-2 is not done",
    });
    expect(result.transition?.subject.status).toBe("blocked");
    expect(store.tasks.require(TK).status).toBe("blocked");
    expect(result.blocker.kind).toBe("dependency");
    expect(result.blocker.resolvedAt).toBeNull();
    expect(isBlocked(store, "task", TK)).toBe(true);
  });

  it("derives Task.blocker from the rows rather than a caller string", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "dependency", detail: "a" });
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "information", detail: "b" });
    expect(store.tasks.require(TK).blocker).toBe("dependency,information");
    expect(activeBlockers(store, "task", TK)).toHaveLength(2);
  });

  it("an already blocked task accumulates the reason without a second transition", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "dependency", detail: "a" });
    const second = raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "approval", detail: "b" });
    expect(second.transition).toBeNull();
    expect(store.tasks.require(TK).status).toBe("blocked");
    expect(activeBlockers(store, "task", TK).map((b) => b.kind)).toEqual(["dependency", "approval"]);
  });

  it("a terminal task keeps its status but the reason is still recorded", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "done" }));
    const result = raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "information", detail: "late question" });
    expect(result.transition).toBeNull();
    expect(store.tasks.require(TK).status).toBe("done");
    expect(store.blockers.forSubject("task", TK)).toHaveLength(1);
  });

  it("blocked cannot be set directly: task-block needs a blocker on record", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "blocked",
        trigger: "blocker_or_user_pause",
        actor: { kind: "engine", identity: "engine" },
        // A caller claiming the guard directly: refused, because the
        // structural verdict is computed from the blocker table.
        guards: { blocker_present: () => true },
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId: () => `id-${(counter += 1)}`,
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.failedGuards).toContain("blocker_present");
    expect(store.tasks.require(TK).status).toBe("ready");
  });
});

describe("resolving a blocker never grants readiness", () => {
  it("leaves the task blocked: readiness is a separate transition with its own guards", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    const raised = raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "dependency", detail: "a" });
    const resolved = resolveBlocker({ ...ctx(store), blockerId: raised.blocker.blockerId, detail: "dep finished" });
    expect(resolved.clear).toBe(true);
    expect(store.tasks.require(TK).status).toBe("blocked");
    expect(store.tasks.require(TK).blocker).toBeNull();
  });

  it("reports the reasons that remain when several were raised", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    const first = raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "dependency", detail: "a" });
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "approval", detail: "b" });
    const resolved = resolveBlocker({ ...ctx(store), blockerId: first.blocker.blockerId, detail: "done" });
    expect(resolved.clear).toBe(false);
    expect(resolved.remaining.map((b) => b.kind)).toEqual(["approval"]);
    expect(store.tasks.require(TK).blocker).toBe("approval");
  });

  it("a resolved blocker is kept, not deleted, and cannot be resolved twice", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    const raised = raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "dependency", detail: "a" });
    resolveBlocker({ ...ctx(store), blockerId: raised.blocker.blockerId, detail: "first" });
    expect(store.blockers.forSubject("task", TK)).toHaveLength(1);
    expect(() => resolveBlocker({ ...ctx(store), blockerId: raised.blocker.blockerId, detail: "again" })).toThrow(
      /already resolved/,
    );
    expect(() =>
      store.connection.prepare("DELETE FROM blocker WHERE blockerId = ?").run(raised.blocker.blockerId),
    ).toThrow(/never deleted/);
  });

  it("clearing a cap does not clear another unresolved reason", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: BLOCKER_KINDS.cap, detail: "all capped" });
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: BLOCKER_KINDS.approval, detail: "needs approval" });
    resolveBlockersOfKind({
      ...ctx(store),
      subjectKind: "task",
      subjectId: TK,
      kind: BLOCKER_KINDS.cap,
      detail: "quota reset",
    });
    expect(isBlocked(store, "task", TK)).toBe(true);
    expect(activeBlockers(store, "task", TK).map((b) => b.kind)).toEqual(["approval"]);
  });

  it("readiness is refused while the reason is unresolved, and granted after", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    const raised = raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "dependency", detail: "a" });
    const readyRequest = {
      store,
      taskId: TK,
      to: "ready" as const,
      trigger: "readiness_validated",
      actor: { kind: "engine", identity: "engine" } as const,
      guards: { authorization_current: () => true as const, recovery_authorized: () => true as const },
      evidenceRefs: ["ev:checks", "ev:deps"],
      now: () => AT,
      newId: () => `id-${(counter += 1)}`,
    };
    expect(() => transitionTask(readyRequest)).toThrow(/readiness_valid/);

    resolveBlocker({ ...ctx(store), blockerId: raised.blocker.blockerId, detail: "dep finished" });
    const ready = transitionTask(readyRequest);
    expect(ready.subject.status).toBe("ready");
    expect(ready.subject.blocker).toBeNull();
    const rows = store.blockers.forSubject("task", TK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolvedAt).toBe(AT);
  });

  it("task-cancel resolves the outstanding reasons, keeping them as history", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "dependency", detail: "a" });
    const cancelled = transitionTask({
      store,
      taskId: TK,
      to: "cancelled",
      trigger: "cancel",
      actor: { kind: "user", identity: "owner" },
      guards: { cancellation_requested: () => true },
      evidenceRefs: ["ev:request", "ev:children"],
      now: () => AT,
      newId: () => `id-${(counter += 1)}`,
    });
    expect(cancelled.subject.status).toBe("cancelled");
    const rows = store.blockers.forSubject("task", TK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolvedAt).toBe(AT);
    expect(rows[0]?.resolutionDetail).toContain("task-cancel");
  });

  it("refuses to resolve an unknown blocker", () => {
    const store = freshStore();
    expect(() => resolveBlocker({ ...ctx(store), blockerId: "nope", detail: "x" })).toThrow(TransitionRejected);
  });
});

describe("phase blockers pause the phase", () => {
  it("pauses a running phase and stores the reason", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "running" });
    const result = raisePhaseBlocker({
      ...ctx(store),
      phaseId: PH,
      kind: BLOCKER_KINDS.userPause,
      detail: "owner asked to stop",
    });
    expect(result.transition?.subject.gateStatus).toBe("paused_approval");
    expect(activeBlockers(store, "phase", PH)).toHaveLength(2);
  });

  it("an already paused phase accumulates the reason without a second transition", () => {
    const store = freshStore();
    store.phases.update(PH, { gateStatus: "paused_cap" });
    const result = raisePhaseBlocker({ ...ctx(store), phaseId: PH, kind: "approval", detail: "x" });
    expect(result.transition).toBeNull();
    expect(store.phases.require(PH).gateStatus).toBe("paused_cap");
  });

  it("describeBlockers renders one line per unresolved reason", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "ready" }));
    expect(describeBlockers([])).toBe("no unresolved blockers");
    raiseTaskBlocker({ ...ctx(store), taskId: TK, kind: "information", detail: "which database?" });
    const text = describeBlockers(activeBlockers(store, "task", TK));
    expect(text).toContain("information");
    expect(text).toContain("which database?");
    expect(text).toContain("engine:engine");
  });
});
