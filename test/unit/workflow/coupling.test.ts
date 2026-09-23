/**
 * `src/workflow/coupling.ts` (issue #76; PLAN §3.E).
 *
 * Test names reference the acceptance criterion they exercise:
 * - AC1 "overlapping globs → serial regardless of Jev";
 * - AC2 "`unknown` → serial";
 * - AC3 "independent + Jev independent → parallel" (the scheduler half of
 *   AC3 lives in `coupling-scheduler.test.ts`).
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import type { PhaseId, Task, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  assertWorkerTree,
  canRunConcurrently,
  checkRoleWorkerTree,
  checkWorkerTree,
  couplingSignalFrom,
  couplingViewOf,
  fillCouplingCache,
  WorkerTreeRefused,
  couplingKey,
  CouplingCache,
  describeOverlap,
  expandOwnershipPattern,
  hasOwnershipOverlap,
  normaliseOwnershipPath,
  ownershipConflict,
  ownershipIntersection,
  pathsIntersect,
  segmentsIntersect,
  selectConcurrentBatch,
} from "../../../src/workflow/coupling.ts";
import { planPass } from "../../../src/workflow/scheduler.ts";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { worktreeIdentity } from "../../../src/git/checkpoint.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function task(id: string, paths: readonly string[], components: readonly string[] = []): Task {
  return makeTask({ id: id as TaskId, ownership: { paths, components } });
}

describe("AC1: declared ownership overlap is a set computation over patterns", () => {
  it("identical paths overlap", () => {
    expect(pathsIntersect("src/a.ts", "src/a.ts")).toBe("identical");
  });

  it("a directory claim contains everything under it", () => {
    expect(pathsIntersect("src/workflow", "src/workflow/graph.ts")).toBe("containment");
    expect(pathsIntersect("src/workflow/graph.ts", "src/workflow")).toBe("containment");
  });

  it("a recursive glob intersects a concrete file it would match", () => {
    expect(pathsIntersect("src/**/*.ts", "src/api/orders.ts")).toBe("glob_intersection");
  });

  it("a prefix glob and a suffix glob intersect on a common name", () => {
    expect(segmentsIntersect("foo*", "*bar")).toBe(true);
    expect(pathsIntersect("src/foo*.ts", "src/*bar.ts")).toBe("glob_intersection");
  });

  it("disjoint single-segment globs do not intersect", () => {
    expect(segmentsIntersect("foo*", "bar*")).toBe(false);
    expect(pathsIntersect("src/foo*.ts", "src/bar*.ts")).toBeNull();
  });

  it("sibling directories do not intersect", () => {
    expect(pathsIntersect("src/ui", "src/api")).toBeNull();
    expect(pathsIntersect("src/ui/**", "src/api/**")).toBeNull();
  });

  it("character classes intersect only when some character satisfies both", () => {
    expect(pathsIntersect("src/[a-f]x.ts", "src/[e-z]x.ts")).toBe("glob_intersection");
    expect(pathsIntersect("src/[a-c]x.ts", "src/[x-z]x.ts")).toBeNull();
  });

  it("a negated class intersects a literal it does not exclude", () => {
    expect(pathsIntersect("src/[!a]x.ts", "src/bx.ts")).toBe("glob_intersection");
    expect(pathsIntersect("src/[!b]x.ts", "src/bx.ts")).toBeNull();
  });

  it("`**` spans any number of segments, including zero", () => {
    expect(pathsIntersect("src/**/x.ts", "src/x.ts")).toBe("glob_intersection");
    expect(pathsIntersect("src/**/x.ts", "src/a/b/c/x.ts")).toBe("glob_intersection");
  });

  it("normalises separators, leading ./ and trailing / before comparing", () => {
    expect(normaliseOwnershipPath("./src//workflow/")).toBe("src/workflow");
    expect(pathsIntersect("./src/a.ts", "src/a.ts")).toBe("identical");
  });

  it("a non-wildcard pattern also stands for its subtree", () => {
    expect(expandOwnershipPattern("src/ui")).toEqual(["src/ui", "src/ui/**"]);
    expect(expandOwnershipPattern("src/ui/**")).toEqual(["src/ui/**"]);
  });

  it("components overlap on exact name, independent of paths", () => {
    const overlap = ownershipIntersection(
      { paths: ["src/a.ts"], components: ["api"] },
      { paths: ["src/b.ts"], components: ["api"] },
    );
    expect(overlap.components).toEqual(["api"]);
    expect(overlap.paths).toEqual([]);
    expect(hasOwnershipOverlap(overlap)).toBe(true);
    expect(describeOverlap(overlap)).toBe("component api");
  });

  it("a task never overlaps itself as a pair (identity is handled before the set math)", () => {
    const a = task("t1", ["src/a.ts"]);
    expect(hasOwnershipOverlap(ownershipConflict(a, a))).toBe(false);
  });
});

describe("AC1: overlapping globs are serial regardless of what Jev says", () => {
  const a = task("t1", ["src/api/**"], []);
  const b = task("t2", ["src/api/orders.ts"], []);

  it("an `independent` cached verdict cannot clear a declared overlap", () => {
    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "independent", source: "tasks.coupling@1", decisionId: "dc-1" });
    const verdict = canRunConcurrently(a, b, { cache });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("ownership_conflict");
    expect(verdict.overlap.paths).toEqual([
      { a: "src/api/**", b: "src/api/orders.ts", rule: "glob_intersection" },
    ]);
  });

  it("an `independent` raw signal cannot clear a declared overlap either", () => {
    const verdict = canRunConcurrently(a, b, { signal: () => "independent" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("ownership_conflict");
  });

  it("the signal is never even consulted on the overlap path", () => {
    let consulted = 0;
    const verdict = canRunConcurrently(a, b, {
      signal: () => {
        consulted += 1;
        return "independent";
      },
    });
    expect(verdict.ok).toBe(false);
    expect(consulted).toBe(0);
  });

  it("a component-only overlap is serial even with an `independent` verdict", () => {
    const c = task("t3", ["src/x.ts"], ["billing"]);
    const d = task("t4", ["src/y.ts"], ["billing"]);
    const verdict = canRunConcurrently(c, d, { signal: () => "independent" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("ownership_conflict");
    expect(verdict.overlap.components).toEqual(["billing"]);
  });

  it("ownershipConflict takes no options, so there is no lenient call site to write", () => {
    expect(ownershipConflict.length).toBe(2);
    expect(hasOwnershipOverlap(ownershipConflict(a, b))).toBe(true);
  });

  it("a task is never concurrent with itself", () => {
    const verdict = canRunConcurrently(a, a, { signal: () => "independent" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("ownership_conflict");
  });
});

describe("AC2: uncertain coupling is serial — the default is the safe one", () => {
  const a = task("d1", ["src/one.ts"], ["one"]);
  const b = task("d2", ["src/two.ts"], ["two"]);

  it("disjoint ownership with no cache and no signal serialises", () => {
    const verdict = canRunConcurrently(a, b);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("coupling_uncertain");
    expect(verdict.coupling).toBe("unknown");
  });

  it("a cold cache is exactly as safe as no cache", () => {
    const verdict = canRunConcurrently(a, b, { cache: new CouplingCache() });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("coupling_uncertain");
  });

  it("a stored `unknown` behaves identically to a miss", () => {
    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "unknown", source: "tasks.coupling@1", decisionId: "dc-2" });
    expect(cache.has(a, b)).toBe(true);
    expect(canRunConcurrently(a, b, { cache }).reason).toBe("coupling_uncertain");
  });

  it("an explicit `coupled` verdict serialises, with its own reason", () => {
    const verdict = canRunConcurrently(a, b, { signal: () => "coupled" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("coupled");
  });

  it("a throwing signal degrades to unknown rather than failing the pass", () => {
    const verdict = canRunConcurrently(a, b, {
      signal: () => {
        throw new Error("transport exploded");
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("coupling_uncertain");
  });
});

describe("AC3: disjoint ownership plus an `independent` verdict runs in parallel", () => {
  const a = task("p1", ["src/one.ts"], ["one"]);
  const b = task("p2", ["src/two.ts"], ["two"]);

  it("a cached `independent` verdict permits concurrency", () => {
    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "independent", source: "tasks.coupling@1", decisionId: "dc-3" });
    const verdict = canRunConcurrently(a, b, { cache });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.coupling).toBe("independent");
  });

  it("selectConcurrentBatch admits a whole independent set and holds the rest", () => {
    const c = task("p3", ["src/one.ts"], ["one"]);
    const batch = selectConcurrentBatch([a, b, c], { signal: () => "independent" });
    expect(batch.parallel).toEqual(["p1", "p2"]);
    expect(batch.serial).toEqual([
      expect.objectContaining({ taskId: "p3", reason: "ownership_conflict" }),
    ]);
  });

  it("admission is transitive: three tasks run together only if all three pairs are clear", () => {
    const x = task("q1", ["src/x.ts"]);
    const y = task("q2", ["src/y.ts"]);
    const z = task("q3", ["src/z.ts"]);
    const coupledWithX = (l: Task, r: Task): "independent" | "coupled" =>
      [l.id, r.id].includes("q1" as TaskId) && [l.id, r.id].includes("q3" as TaskId)
        ? "coupled"
        : "independent";
    const batch = selectConcurrentBatch([x, y, z], { signal: coupledWithX });
    expect(batch.parallel).toEqual(["q1", "q2"]);
    expect(batch.serial.map((s) => s.reason)).toEqual(["coupled"]);
  });

  it("with no signal at all the batch is a single task — serial by default", () => {
    expect(selectConcurrentBatch([a, b]).parallel).toEqual(["p1"]);
  });
});

describe("the cache is keyed by the pair *and* the revisions it was judged at", () => {
  const a = task("k1", ["src/one.ts"]);
  const b = task("k2", ["src/two.ts"]);

  it("the key is order-independent for the same pair", () => {
    expect(couplingKey(a, b)).toBe(couplingKey(b, a));
  });

  it("an edited task misses the cache, and a miss serialises", () => {
    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "independent", source: "tasks.coupling@1", decisionId: "dc-4" });
    expect(canRunConcurrently(a, b, { cache }).ok).toBe(true);

    const edited: Task = { ...a, revision: a.revision + 1, goal: "a materially different goal" };
    expect(cache.has(edited, b)).toBe(false);
    expect(canRunConcurrently(edited, b, { cache }).reason).toBe("coupling_uncertain");
  });

  it("invalidateTask drops every entry mentioning the task, at any revision", () => {
    const cache = new CouplingCache();
    const entry = { verdict: "independent" as const, source: "tasks.coupling@1", decisionId: null };
    cache.set(a, b, entry);
    cache.set({ ...a, revision: 2 }, b, entry);
    expect(cache.size).toBe(2);
    expect(cache.invalidateTask("k1" as TaskId)).toBe(2);
    expect(cache.size).toBe(0);
  });

  it("cache.signal() exposes the cached verdict to the scheduler, unknown on a miss", () => {
    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "independent", source: "tasks.coupling@1", decisionId: null });
    const signal = cache.signal();
    expect(signal(a, b)).toBe("independent");
    expect(signal({ ...a, revision: 9 }, b)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// PLAN §3.E: "a writing worker never works in the user's main tree"
// ---------------------------------------------------------------------------

/** The user's repository plus a linked worktree standing in for a task tree. */
function repoWithWorktree(): { main: TestRepo; worktree: string } {
  const main = makeTestRepo("korwf-coupling-main-");
  cleanups.push(main.cleanup);
  const dir: TempDir = makeTempDir("korwf-coupling-wt-");
  cleanups.push(dir.cleanup);
  const worktree = join(dir.path, "task");
  main.git("worktree", "add", "-q", "-b", "korwf/coupling-task", worktree);
  cleanups.push(() => {
    try {
      main.git("worktree", "remove", "--force", worktree);
    } catch {
      /* the temp dir is going away anyway */
    }
  });
  return { main, worktree };
}

describe("a writing worker never works in the user's main tree", () => {
  it("refuses a writing role in the main tree, naming the worktree remedy", () => {
    const { main } = repoWithWorktree();
    const verdict = checkRoleWorkerTree({ role: "implementer", workerCwd: main.path, projectRoot: main.path });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("is_main_tree");
    expect(verdict.detail).toContain("worktree");
  });

  it("admits a writing role in a linked worktree of the same repository", () => {
    const { main, worktree } = repoWithWorktree();
    const verdict = checkRoleWorkerTree({ role: "implementer", workerCwd: worktree, projectRoot: main.path });
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBeNull();
  });

  it("refuses a linked worktree belonging to a different repository", () => {
    const { worktree } = repoWithWorktree();
    const other = makeTestRepo("korwf-coupling-other-");
    cleanups.push(other.cleanup);
    const verdict = checkRoleWorkerTree({ role: "implementer", workerCwd: worktree, projectRoot: other.path });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("different_repository");
  });

  it("refuses a directory that is not a git repository at all", () => {
    const dir = makeTempDir("korwf-coupling-nonrepo-");
    cleanups.push(dir.cleanup);
    const { main } = repoWithWorktree();
    const verdict = checkRoleWorkerTree({ role: "implementer", workerCwd: dir.path, projectRoot: main.path });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("not_a_repository");
  });

  it("a read-only role (#69's scout/reviewer) may observe the user's main tree", () => {
    const { main } = repoWithWorktree();
    for (const role of ["scout", "reviewer"] as const) {
      expect(checkRoleWorkerTree({ role, workerCwd: main.path, projectRoot: main.path }).ok).toBe(true);
    }
  });

  it("every writing role is refused in the main tree, from the role table, not a list here", () => {
    const { main } = repoWithWorktree();
    for (const role of ["planner", "implementer", "verifier", "integrator"] as const) {
      expect(checkRoleWorkerTree({ role, workerCwd: main.path, projectRoot: main.path }).code).toBe("is_main_tree");
    }
  });

  it("with no main tree to compare against, an unlinked tree is still refused", () => {
    const { main } = repoWithWorktree();
    expect(checkWorkerTree({ worker: worktreeIdentity(main.path), main: null, writes: true }).code).toBe(
      "is_main_tree",
    );
  });

  it("assertWorkerTree throws WorkerTreeRefused carrying the code", () => {
    const { main } = repoWithWorktree();
    const input = { worker: worktreeIdentity(main.path), main: worktreeIdentity(main.path), writes: true };
    expect(() => assertWorkerTree(input)).toThrow(WorkerTreeRefused);
    try {
      assertWorkerTree(input);
    } catch (error) {
      expect((error as WorkerTreeRefused).code).toBe("is_main_tree");
    }
    expect(() => assertWorkerTree({ ...input, writes: false })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Filling the cache: Jev only ever ADDS a signal
// ---------------------------------------------------------------------------

/**
 * A transport that answers `tasks.coupling@1` with a fixed choice. The
 * distribution covers every option the question actually offered and sums to
 * one, because `src/jev/validate.ts` rejects anything else — a test that sent
 * a short distribution would be exercising the invalid-response path while
 * appearing to exercise the answer path.
 */
function respondingTransport(choice: string, confidence = 0.95): MockJevTransport {
  return new MockJevTransport({
    responder: (request) => ({
      kind: "ok",
      response: {
        model: "jev-test",
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            const options = question.type === "choice" ? Object.keys(question.criteria) : [choice];
            const rest = (1 - confidence) / Math.max(1, options.length - 1);
            const probabilities = Object.fromEntries(
              options.map((option) => [option, option === choice ? confidence : rest]),
            );
            return [key, { type: "choice", choice, confidence, probabilities }];
          }),
        ),
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      requestId: "req-1",
      attempts: 1,
      elapsedMs: 1,
    }),
  });
}

describe("fillCouplingCache: Jev adds a signal and can only subtract concurrency", () => {
  const a = task("j1", ["src/one.ts"], ["one"]);
  const b = task("j2", ["src/two.ts"], ["two"]);
  const overlapping = task("j3", ["src/one.ts"], ["one"]);

  it("an `independent` answer is cached and makes the disjoint pair parallel", async () => {
    const ctx: AskContext = { transport: respondingTransport("independent"), model: "jev-test" };
    const cache = await fillCouplingCache(ctx, [a, b], new CouplingCache());
    expect(cache.get(a, b)?.verdict).toBe("independent");
    expect(canRunConcurrently(a, b, { cache }).ok).toBe(true);
  });

  it("a `coupled` answer serialises a pair code would have allowed", async () => {
    const ctx: AskContext = { transport: respondingTransport("coupled"), model: "jev-test" };
    const cache = await fillCouplingCache(ctx, [a, b], new CouplingCache());
    expect(canRunConcurrently(a, b, { cache }).reason).toBe("coupled");
  });

  it("with no Jev key every pair degrades to unknown — serial, never an error", async () => {
    const ctx: AskContext = { transport: new DisabledJevTransport(), model: "jev-test" };
    const cache = await fillCouplingCache(ctx, [a, b], new CouplingCache());
    expect(cache.get(a, b)?.verdict).toBe("unknown");
    expect(canRunConcurrently(a, b, { cache }).reason).toBe("coupling_uncertain");
  });

  it("a low-confidence `independent` is abstained into unknown, not trusted", async () => {
    const ctx: AskContext = { transport: respondingTransport("independent", 0.4), model: "jev-test" };
    const cache = await fillCouplingCache(ctx, [a, b], new CouplingCache());
    expect(cache.get(a, b)?.verdict).toBe("unknown");
  });

  it("a throwing transport is caught and stored as unknown", async () => {
    const throwing = new MockJevTransport({
      responder: () => {
        throw new Error("network down");
      },
    });
    const ctx: AskContext = { transport: throwing, model: "jev-test" };
    const cache = await fillCouplingCache(ctx, [a, b], new CouplingCache());
    expect(cache.get(a, b)?.verdict).toBe("unknown");
  });

  it("pairs with a declared ownership overlap are never sent to Jev at all", async () => {
    const transport = respondingTransport("independent");
    const ctx: AskContext = { transport, model: "jev-test" };
    const cache = await fillCouplingCache(ctx, [a, overlapping], new CouplingCache());
    expect(transport.calls).toHaveLength(0);
    expect(cache.size).toBe(0);
    expect(canRunConcurrently(a, overlapping, { cache }).reason).toBe("ownership_conflict");
  });

  it("an already-cached pair is not asked about again", async () => {
    const transport = respondingTransport("independent");
    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "coupled", source: "tasks.coupling@1", decisionId: null });
    await fillCouplingCache({ transport, model: "jev-test" }, [a, b], cache);
    expect(transport.calls).toHaveLength(0);
    expect(cache.get(a, b)?.verdict).toBe("coupled");
  });

  it("the state sent outbound is the minimal task view: no file contents", () => {
    const view = couplingViewOf(a);
    expect(Object.keys(view).sort()).toEqual([
      "acceptanceCriteria",
      "goal",
      "id",
      "ownershipComponents",
      "ownershipPaths",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC3, at the scheduler: "independent + Jev independent → parallel"
// ---------------------------------------------------------------------------

function freshStore(): Store {
  const dir: TempDir = makeTempDir("korwf-coupling-store-");
  let n = 0;
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `id-${(n += 1)}` });
  cleanups.push(() => {
    store.close();
    dir.cleanup();
  });
  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "running" }));
  return store;
}

function insert(store: Store, t: Task): Task {
  const row: Task = { ...t, workflowId: WF, phaseId: PH, status: "ready" };
  store.tasks.insert(row);
  return row;
}

describe("AC3 (scheduler): the cache is what turns an independent pair parallel", () => {
  it("a cold cache holds the second task; a filled one dispatches both", () => {
    const store = freshStore();
    const a = insert(store, task("s1", ["src/one.ts"], ["one"]));
    const b = insert(store, task("s2", ["src/two.ts"], ["two"]));

    const cold = new CouplingCache();
    const before = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, couplingCache: cold });
    expect(before.dispatch).toEqual(["s1"]);
    expect(before.held.map((h) => h.reason)).toEqual(["coupling_uncertain"]);

    cold.set(a, b, { verdict: "independent", source: "tasks.coupling@1", decisionId: "dc-5" });
    const after = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, couplingCache: cold });
    expect(after.dispatch).toEqual(["s1", "s2"]);
    expect(after.held).toEqual([]);
  });

  it("the scheduler refuses an overlapping pair even with an `independent` cache entry", () => {
    const store = freshStore();
    const a = insert(store, task("s3", ["src/api/**"], []));
    const b = insert(store, task("s4", ["src/api/orders.ts"], []));

    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "independent", source: "tasks.coupling@1", decisionId: "dc-6" });
    const plan = planPass({ store, phaseIds: [PH], inFlight: [], limit: null, couplingCache: cache });
    expect(plan.dispatch).toEqual(["s3"]);
    expect(plan.held).toEqual([expect.objectContaining({ taskId: "s4", reason: "ownership_conflict" })]);
  });

  it("couplingSignalFrom prefers the cache and falls through to the raw signal on a miss", () => {
    const a = task("s5", ["src/one.ts"]);
    const b = task("s6", ["src/two.ts"]);
    const cache = new CouplingCache();
    cache.set(a, b, { verdict: "coupled", source: "tasks.coupling@1", decisionId: null });
    const signal = couplingSignalFrom({ cache, signal: () => "independent" });
    expect(signal(a, b)).toBe("coupled");
    expect(signal({ ...a, revision: 7 }, b)).toBe("independent");
    const empty = couplingSignalFrom();
    expect(empty(a, b)).toBe("unknown");
  });
});
