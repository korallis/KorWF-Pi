/**
 * `src/extension/session-hooks.ts` (issue #42): the Pi session lifecycle
 * seam. Acceptance criterion 1 is exercised end-to-end here — a *forked*
 * session, with its own session id, opens the same store, finds the mutated
 * repository, reports the drift and marks the approvals stale.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { ApprovalId, PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  PI_START_REASONS,
  SESSION_EVENT_FOR_REASON,
  needsWrite,
  registerSessionHooks,
  runReconciliation,
} from "../../../src/extension/session-hooks.ts";
import { SESSION_EVENTS } from "../../../src/workflow/reconcile.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;
const TK = "tk-1" as TaskId;

const dirs: TempDir[] = [];
const stores: Store[] = [];
const repos: TestRepo[] = [];
let counter = 0;

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) dirs.pop()?.cleanup();
  while (repos.length > 0) repos.pop()?.cleanup();
});

/**
 * A project with a repository and a store: exactly the shape a real session
 * resumes into. The store handle is re-opened per hook invocation, as a
 * separate Pi session would.
 */
function makeProject(): { repo: TestRepo; storageRoot: string } {
  const repo = makeTestRepo();
  repos.push(repo);
  const dir = makeTempDir("korwf-hook-store-");
  dirs.push(dir);

  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  store.workflows.insert(makeWorkflow({ baseRevision: repo.head(), planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "running" }));
  store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
  store.close();

  return { repo, storageRoot: dir.path };
}

function openProjectStore(storageRoot: string, writable: boolean): Store {
  const { store } = openStore({
    storageRoot,
    writable,
    reconcile: false,
    now: () => AT,
    newId: () => `b-${(counter += 1)}`,
  });
  stores.push(store);
  return store;
}

function runHook(
  event: Parameters<typeof runReconciliation>[0],
  project: { repo: TestRepo; storageRoot: string },
  sessionId: string,
) {
  const notices: { message: string; level?: string }[] = [];
  const result = runReconciliation(
    event,
    {
      cwd: project.repo.path,
      sessionId,
      ui: { notify: (message, level) => notices.push({ message, ...(level === undefined ? {} : { level }) }) },
    },
    {
      now: () => AT,
      newId: () => `h-${(counter += 1)}`,
      openStoreFor: (_cwd, writable) => openProjectStore(project.storageRoot, writable),
    },
  );
  return { result, notices };
}

describe("AC1: fork the session in a harness, mutate the repo, resume", () => {
  it("shows the drift and marks the approvals stale in the forked session", () => {
    const project = makeProject();

    // The original session saw a clean repository at the plan base revision.
    const before = runHook("startup", project, "session-original");
    expect(before.result.reports[0]?.drift.relation).toBe("same");
    expect(before.result.message).toBe("");

    // Someone commits while the conversation is elsewhere. Forking rewinds
    // the transcript; it does not rewind this.
    project.repo.commitFile("landed.ts", "export const landed = true;\n", "work landed out of band");

    const forked = runHook("fork", project, "session-fork");

    const report = forked.result.reports[0];
    expect(report?.drift.relation).toBe("advanced");
    expect(forked.result.message).toContain("revision_drift");
    expect(report?.invalidatedApprovals).toEqual(["ap-1"]);

    // And the effect is durable: a subsequent resume reads it back from disk.
    const resumed = runHook("resume", project, "session-resumed");
    const store = openProjectStore(project.storageRoot, false);
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("session_reconciled");
    expect(store.tasks.require(TK).status).toBe("blocked");
    expect(store.phases.require(PH).gateStatus).toBe("paused_approval");
    expect(resumed.result.reports[0]?.alreadyInvalidApprovals).toEqual(["ap-1"]);
  });

  it("a dirty working tree is surfaced to the user as a warning notice", () => {
    const project = makeProject();
    project.repo.writeDirty("scratch.ts", "// left behind\n");

    const { notices } = runHook("resume", project, "session-resumed");

    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe("warning");
    expect(notices[0]?.message).toContain("working_tree_dirty");
    expect(notices[0]?.message).toContain("scratch.ts");
  });

  it("says nothing at all when the repository still matches the plan", () => {
    const project = makeProject();
    const { notices, result } = runHook("resume", project, "session-resumed");
    expect(notices).toEqual([]);
    expect(result.message).toBe("");
    expect(result.degraded).toBe(false);
  });

  it("tree navigation reconciles too — it rewinds the conversation with no session start", () => {
    const project = makeProject();
    project.repo.commitFile("moved.ts", "moved\n", "moved");

    const { result } = runHook("tree", project, "session-original");

    expect(result.event).toBe("tree");
    expect(result.reports[0]?.invalidatedApprovals).toEqual(["ap-1"]);
  });
});

describe("session hooks degrade rather than breaking the session", () => {
  it("reports degraded and notifies nothing when the store cannot be opened", () => {
    const repo = makeTestRepo();
    repos.push(repo);
    const notices: string[] = [];
    const result = runReconciliation(
      "resume",
      { cwd: repo.path, sessionId: "s", ui: { notify: (m) => notices.push(m) } },
      {
        openStoreFor: () => {
          throw new Error("store is locked by another session");
        },
      },
    );
    expect(result.degraded).toBe(true);
    expect(result.reports).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("a read-only store reports drift without writing (dry run)", () => {
    const project = makeProject();
    project.repo.commitFile("moved.ts", "moved\n", "moved");

    const notices: string[] = [];
    const result = runReconciliation(
      "resume",
      { cwd: project.repo.path, sessionId: "s", ui: { notify: (m) => notices.push(m) } },
      {
        now: () => AT,
        newId: () => "x",
        openStoreFor: () => openProjectStore(project.storageRoot, false),
      },
    );

    expect(result.reports[0]?.drift.relation).toBe("advanced");
    expect(result.reports[0]?.invalidatedApprovals).toEqual([]);
    const store = openProjectStore(project.storageRoot, false);
    expect(store.approvals.require("ap-1").invalidation).toBeNull();
  });

  it("skips workflows that are already completed or cancelled", () => {
    const project = makeProject();
    const writable = openProjectStore(project.storageRoot, true);
    writable.workflows.update(WF, { status: "completed" });
    writable.close();
    stores.pop();
    project.repo.commitFile("moved.ts", "moved\n", "moved");

    const { result } = runHook("fork", project, "session-fork");
    expect(result.reports).toEqual([]);
  });
});

describe("the Pi event map is total, so a new rewind cannot go unhandled", () => {
  it("maps every Pi session_start reason onto a KorWF session event", () => {
    for (const reason of PI_START_REASONS) {
      expect(SESSION_EVENTS).toContain(SESSION_EVENT_FOR_REASON[reason]);
    }
    // `/tree` is the one KorWF event with no Pi session_start reason.
    const mapped = new Set(PI_START_REASONS.map((r) => SESSION_EVENT_FOR_REASON[r]));
    expect(SESSION_EVENTS.filter((e) => !mapped.has(e))).toEqual(["tree"]);
  });

  it("only reporting events run read-only; every rewinding event may write", () => {
    expect(needsWrite("startup")).toBe(false);
    expect(needsWrite("new")).toBe(false);
    for (const event of ["reload", "resume", "fork", "tree"] as const) {
      expect(needsWrite(event)).toBe(true);
    }
  });

  it("registers handlers for both session_start and session_tree", () => {
    const registered: string[] = [];
    const pi = {
      on: (event: string) => {
        registered.push(event);
        return () => {};
      },
    };
    registerSessionHooks(pi as unknown as Parameters<typeof registerSessionHooks>[0]);
    expect(registered).toEqual(["session_start", "session_tree"]);
  });
});
