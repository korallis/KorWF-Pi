/**
 * `src/workflow/reconcile.ts` idempotency half (issue #42 acceptance
 * criterion 2: "Re-executing a recorded action id is refused with a notice").
 *
 * PLAN §5: fork/resume "never … replays completed actions". A conversation
 * rewind restores the transcript, not the repository, so the same turn can ask
 * for the same effect twice; the receipt in `store.actions` is what makes the
 * second request a refusal.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { actionIdFor } from "../../../src/storage/action-log.ts";
import type { TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  RECONCILE_CODES,
  guardAction,
  recordCompletedAction,
  reconcileSession,
} from "../../../src/workflow/reconcile.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
const repos: TestRepo[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
  while (repos.length > 0) repos.pop()?.cleanup();
});

function freshStore(baseRevision = "a".repeat(40)): Store {
  const dir = makeTempDir("korwf-replay-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ baseRevision, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "running" }));
  return store;
}

function guard(store: Store, actionId: string, sessionId = "session-fork") {
  return guardAction({
    store,
    workflowId: WF,
    actionId,
    sessionId,
    now: () => AT,
    newId: () => `rep-${(counter += 1)}`,
  });
}

describe("AC2: re-executing a recorded action id is refused with a notice", () => {
  it("permits an action that has never run", () => {
    const store = freshStore();
    const verdict = guard(store, actionIdFor({ workflowId: WF, kind: "git_commit", subjectId: TK }));
    expect(verdict.kind).toBe("proceed");
  });

  it("refuses the second request for the same action id, with a notice naming it", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_commit", subjectId: TK });

    expect(guard(store, actionId, "session-original").kind).toBe("proceed");
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "git_commit",
      sessionId: "session-original",
      summary: "commit the task worktree",
      subjectKind: "task",
      subjectId: TK,
      gitRevision: "b".repeat(40),
      now: () => AT,
    });

    const second = guard(store, actionId, "session-fork");
    expect(second.kind).toBe("refused");
    if (second.kind !== "refused") return;
    expect(second.code).toBe(RECONCILE_CODES.actionAlreadyCompleted);
    expect(second.notice).toContain("Refused");
    expect(second.notice).toContain("commit the task worktree");
    expect(second.notice).toContain("session session-original");
    expect(second.notice).toContain("Rewinding the conversation does not undo it");
  });

  it("records the refusal so a no-op turn is never silent", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_push", subjectId: null });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "git_push",
      sessionId: "session-original",
      summary: "push the integration branch",
      externalEffect: true,
      now: () => AT,
    });

    guard(store, actionId, "session-fork");
    guard(store, actionId, "session-fork");

    const attempts = store.actions.replayAttempts(actionId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.sessionId).toBe("session-fork");
    expect(attempts[0]?.reasonCode).toBe(RECONCILE_CODES.externalEffectRecorded);
  });

  it("flags an external effect distinctly: it cannot be undone by rewinding", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "publish", discriminator: { tag: "v1.0.0" } });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "publish",
      sessionId: "session-original",
      summary: "publish release v1.0.0",
      externalEffect: true,
      now: () => AT,
    });

    const verdict = guard(store, actionId);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.code).toBe(RECONCILE_CODES.externalEffectRecorded);
    expect(verdict.notice).toContain("left this repository");
  });

  it("refuses a replay from the very same session, not only from a fork", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_merge", subjectId: TK });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "git_merge",
      sessionId: "session-original",
      summary: "merge the task branch",
      now: () => AT,
    });

    const verdict = guard(store, actionId, "session-original");
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.notice).toContain("this session");
  });

  it("throws rather than overwriting a receipt when the guard was skipped", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_commit", subjectId: TK });
    const write = () =>
      recordCompletedAction({
        store,
        workflowId: WF,
        actionId,
        kind: "git_commit",
        sessionId: "session-original",
        summary: "commit",
        now: () => AT,
      });
    write();
    expect(write).toThrow();
    expect(store.actions.forWorkflow(WF)).toHaveLength(1);
  });

  it("a receipt can never be deleted or rewritten, so a replay cannot be unlocked", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_push" });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "git_push",
      sessionId: "s",
      summary: "push",
      externalEffect: true,
      now: () => AT,
    });
    expect(() =>
      store.write(() => store.connection.prepare("DELETE FROM completed_action WHERE actionId = ?").run(actionId)),
    ).toThrow(/append-only/);
    expect(() =>
      store.write(() =>
        store.connection.prepare("UPDATE completed_action SET summary = 'x' WHERE actionId = ?").run(actionId),
      ),
    ).toThrow(/append-only/);
  });
});

describe("AC2: actionIdFor is derived from the effect, not from the moment", () => {
  it("produces the same id for the same effect requested twice", () => {
    const facts = { workflowId: WF, kind: "git_commit", subjectId: TK, discriminator: { paths: ["a.ts"] } };
    expect(actionIdFor(facts)).toBe(actionIdFor({ ...facts }));
  });

  it("produces different ids for genuinely different effects", () => {
    const base = { workflowId: WF, kind: "git_commit", subjectId: TK };
    expect(actionIdFor({ ...base, discriminator: { paths: ["a.ts"] } })).not.toBe(
      actionIdFor({ ...base, discriminator: { paths: ["b.ts"] } }),
    );
    expect(actionIdFor(base)).not.toBe(actionIdFor({ ...base, kind: "git_push" }));
  });

  it("is order-independent over the discriminator's object keys", () => {
    const a = actionIdFor({ workflowId: WF, kind: "k", discriminator: { x: 1, y: 2 } });
    const b = actionIdFor({ workflowId: WF, kind: "k", discriminator: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });
});

describe("AC1+AC2: reconciliation lists completed actions so a resumed session cannot repeat them", () => {
  it("reports every completed action and flags the external ones", () => {
    const repo = makeTestRepo();
    repos.push(repo);
    const store = freshStore(repo.head());
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId: "act-internal",
      kind: "git_commit",
      sessionId: "session-original",
      summary: "commit the worktree",
      now: () => AT,
    });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId: "act-external",
      kind: "git_push",
      sessionId: "session-original",
      summary: "push the integration branch",
      externalEffect: true,
      now: () => AT,
    });

    const report = reconcileSession({
      store,
      workflowId: WF,
      event: "fork",
      sessionId: "session-fork",
      cwd: repo.path,
      now: () => AT,
      newId: () => `id-${(counter += 1)}`,
    });

    expect([...report.completedActions].sort()).toEqual(["act-external", "act-internal"]);
    const external = report.findings.filter((f) => f.code === RECONCILE_CODES.externalEffectRecorded);
    expect(external.map((f) => f.subjects).flat()).toEqual(["act-external"]);
  });
});
