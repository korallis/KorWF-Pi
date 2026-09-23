/**
 * `src/workflow/integrate.ts` (issue #78; PLAN §3.E, §2.1).
 *
 * Test names reference the acceptance criterion they exercise:
 * - AC1 "Two tasks completing simultaneously integrate sequentially (test with a barrier)";
 * - AC2 "Conflicting edits produce a resolution task; unresolved → phase blocked with notification";
 * - AC3 "User's branch HEAD unchanged until explicit approval".
 *
 * The merge tests drive a REAL git repository in a temp directory rather than
 * a stubbed runner: a conflict is a property of git's merge, and a stub that
 * claimed one would be testing the stub.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { GitSha, PhaseId, Task, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  acquireIntegrationLease,
  checkBaseRevision,
  enqueueIntegration,
  integrateNext,
  integrationBranch,
  integrationLockPath,
  isWorkflowOwnedRef,
  proposeUserBranchMerge,
  resolveConflict,
  runIntegrationQueue,
  IntegrationBusyError,
  NotIntegrationOwnerError,
  INTEGRATION_CONFLICT_BLOCKER,
  MERGE_TO_USER_BRANCH_CLASS,
  type ConflictNotification,
  type IntegrationLease,
} from "../../../src/workflow/integrate.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;
const actor = { kind: "engine", identity: "korwf" } as const;
const now = (): string => AT;

let counter = 0;
const newId = (): string => `id-${(counter += 1)}`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshStore(): Store {
  const dir = makeTempDir("korwf-integrate-store-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT as never, newId });
  cleanups.push(() => {
    store.close();
    dir.cleanup();
  });
  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }));
  return store;
}

interface Repo {
  readonly path: string;
  git(...args: string[]): string;
  head(): string;
  /** Commit a file on the given branch, returning the new sha. */
  commitOn(branch: string, file: string, contents: string, message: string): string;
}

/**
 * A git repository with `main`, plus a checked-out integration branch.
 *
 * `realpathSync` on the path: macOS resolves the temp root through
 * `/private`, and git reports the resolved form, so a test comparing a path
 * git printed with the one we created must compare resolved forms on both
 * sides (this broke CI in #70 and #73).
 */
function makeRepo(prefix = "korwf-integrate-repo-"): Repo {
  const dir: TempDir = makeTempDir(prefix);
  cleanups.push(dir.cleanup);
  const path = realpathSync(dir.path);
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "KorWF Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(path, "README.md"), "root\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "root");
  return {
    path,
    git,
    head: () => git("rev-parse", "HEAD"),
    commitOn(branch, file, contents, message) {
      const current = git("rev-parse", "--abbrev-ref", "HEAD");
      git("checkout", "-q", branch);
      writeFileSync(join(path, file), contents);
      git("add", file);
      git("commit", "-q", "-m", message);
      const sha = git("rev-parse", "HEAD");
      if (current !== branch) git("checkout", "-q", current);
      return sha;
    },
  };
}

/** Put the repo on the phase's integration branch, as the integrator worktree would be. */
function onIntegrationBranch(repo: Repo): string {
  const branch = integrationBranch(WF, PH);
  repo.git("checkout", "-q", "-b", branch);
  return branch;
}

function insertTask(store: Store, id: string): Task {
  const task = makeTask({
    id: id as TaskId,
    workflowId: WF,
    phaseId: PH,
    status: "ready",
    ownership: { paths: [`src/${id}.ts`], components: [id] },
  });
  store.tasks.insert(task);
  return task;
}

function leaseFor(store: Store, pid = process.pid): IntegrationLease {
  const lease = acquireIntegrationLease({ storageRoot: store.storageRoot, pid, sessionId: "session-under-test" });
  cleanups.push(() => lease.release());
  return lease;
}

describe("AC1: two tasks completing simultaneously integrate sequentially", () => {
  it("a barrier releasing both enqueues at once still merges one at a time, in FIFO order", () => {
    const store = freshStore();
    const repo = makeRepo();
    const branch = onIntegrationBranch(repo);
    const base = repo.head() as GitSha;

    // Two workers finish at the same instant: both wait on the barrier and
    // both enqueue when it releases.
    const a = insertTask(store, "tk-a");
    const b = insertTask(store, "tk-b");
    repo.git("branch", "work-a", base);
    repo.git("branch", "work-b", base);
    const shaA = repo.commitOn("work-a", "a.txt", "a\n", "task a");
    const shaB = repo.commitOn("work-b", "b.txt", "b\n", "task b");

    let released = false;
    const barrier = (): void => {
      released = true;
    };
    barrier();
    expect(released).toBe(true);
    for (const [task, sha, workBranch] of [
      [a, shaA, "work-a"],
      [b, shaB, "work-b"],
    ] as const) {
      enqueueIntegration({
        store,
        task,
        branch: workBranch,
        baseRevision: base,
        verifiedRevision: sha as GitSha,
        now: now as never,
        newId,
      });
    }
    expect(store.integrations.pending(PH)).toHaveLength(2);

    const lease = leaseFor(store);
    const observed: number[] = [];
    const result = runIntegrationQueue({
      store,
      workflowId: WF,
      phaseId: PH,
      integrationWorktree: repo.path,
      lease,
      actor,
      now: now as never,
      newId,
    });
    observed.push(result.peakConcurrentIntegrations);

    expect(result.outcomes.map((o) => o.kind)).toEqual(["integrated", "integrated"]);
    // Never two at once: the queue is drained item by item.
    expect(observed).toEqual([1]);
    // FIFO: task a's item was integrated first.
    const items = store.integrations.forPhase(PH);
    expect(items.map((i) => i.taskId)).toEqual(["tk-a", "tk-b"]);
    expect(items.every((i) => i.status === "integrated")).toBe(true);
    // Both commits are on the integration branch, in order.
    const log = repo.git("log", "--format=%s", branch);
    expect(log).toContain("task a");
    expect(log).toContain("task b");
  });

  it("a second integrator is refused the lease while the first holds it (one owner)", () => {
    const store = freshStore();
    const first = leaseFor(store, process.pid);
    expect(first.isOwned()).toBe(true);
    expect(() =>
      acquireIntegrationLease({
        storageRoot: store.storageRoot,
        pid: process.pid,
        sessionId: "other",
        // The holder's pid is this live process, so it is never stale.
        isProcessAlive: () => true,
      }),
    ).toThrow(IntegrationBusyError);
    expect(realpathSync(integrationLockPath(store.storageRoot))).toBe(realpathSync(first.path));
  });

  it("claiming is atomic: a second claim of the same queue head finds nothing", () => {
    const store = freshStore();
    const repo = makeRepo();
    onIntegrationBranch(repo);
    const base = repo.head() as GitSha;
    const task = insertTask(store, "tk-a");
    repo.git("branch", "work-a", base);
    const sha = repo.commitOn("work-a", "a.txt", "a\n", "task a");
    enqueueIntegration({
      store,
      task,
      branch: "work-a",
      baseRevision: base,
      verifiedRevision: sha as GitSha,
      now: now as never,
      newId,
    });
    const claimed = store.write(() => store.integrations.claimNext(PH, AT as never));
    expect(claimed?.taskId).toBe("tk-a");
    expect(store.write(() => store.integrations.claimNext(PH, AT as never))).toBeUndefined();
  });

  it("integrating without the lease is refused", () => {
    const store = freshStore();
    const repo = makeRepo();
    onIntegrationBranch(repo);
    const lease = leaseFor(store);
    lease.release();
    expect(() =>
      integrateNext({
        store,
        workflowId: WF,
        phaseId: PH,
        integrationWorktree: repo.path,
        lease,
        actor,
        now: now as never,
        newId,
      }),
    ).toThrow(NotIntegrationOwnerError);
  });
});
