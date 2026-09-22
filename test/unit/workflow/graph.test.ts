/**
 * `src/workflow/graph.ts` (issue #40): dependency-graph validation, ready
 * set, and topological order over persisted `Task` records.
 */
import { describe, it, expect } from "vitest";
import { findGraphCycles, readySet, topoOrder, validateGraph } from "../../../src/workflow/graph.ts";
import { makePhase, makeTask } from "../../helpers/records.ts";
import type { Task, TaskId, PhaseId } from "../../../src/storage/records.ts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return makeTask({ id: id as TaskId, ...overrides });
}

describe("AC: validateGraph rejects unknown, self, and forward-phase dependencies", () => {
  it("reports a self-dependency", () => {
    const result = validateGraph([task("t1", { dependencies: ["t1" as TaskId] })]);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rule: "self_dependency", taskId: "t1", dependsOn: "t1" }),
    );
  });

  it("reports a dependency on a task that does not exist", () => {
    const result = validateGraph([task("t1", { dependencies: ["ghost" as TaskId] })]);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rule: "unknown_dependency", taskId: "t1", dependsOn: "ghost" }),
    );
  });

  it("reports a task depending on a later phase", () => {
    const phases = [
      makePhase({ id: "p0" as PhaseId, order: 0 }),
      makePhase({ id: "p1" as PhaseId, order: 1 }),
    ];
    const tasks = [
      task("t1", { phaseId: "p0" as PhaseId, dependencies: ["t2" as TaskId] }),
      task("t2", { phaseId: "p1" as PhaseId }),
    ];
    const result = validateGraph(tasks, phases);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ rule: "forward_phase_dependency", taskId: "t1" }));
  });

  it("accepts an acyclic graph with no unknown/self/forward-phase edges", () => {
    const tasks = [task("t1"), task("t2", { dependencies: ["t1" as TaskId] }), task("t3", { dependencies: ["t2" as TaskId] })];
    const result = validateGraph(tasks);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.topologicalOrder.indexOf("t1" as TaskId)).toBeLessThan(result.topologicalOrder.indexOf("t3" as TaskId));
  });
});

describe("AC: cycle error names every task in the cycle", () => {
  it("names all three tasks of a three-cycle in the reported message", () => {
    const tasks = [
      task("t1", { dependencies: ["t2" as TaskId] }),
      task("t2", { dependencies: ["t3" as TaskId] }),
      task("t3", { dependencies: ["t1" as TaskId] }),
    ];
    const result = validateGraph(tasks);
    expect(result.ok).toBe(false);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toEqual(expect.arrayContaining(["t1", "t2", "t3"]));
    const cycleIssue = result.issues.find((i) => i.rule === "dependency_cycle");
    expect(cycleIssue?.message).toContain("t1");
    expect(cycleIssue?.message).toContain("t2");
    expect(cycleIssue?.message).toContain("t3");
  });

  it("reports two distinct cycles in a graph containing both", () => {
    const tasks = [
      task("a1", { dependencies: ["a2" as TaskId] }),
      task("a2", { dependencies: ["a1" as TaskId] }),
      task("b1", { dependencies: ["b2" as TaskId] }),
      task("b2", { dependencies: ["b1" as TaskId] }),
    ];
    const result = validateGraph(tasks);
    expect(result.cycles).toHaveLength(2);
  });

  it("a two-cycle is found via findGraphCycles directly", () => {
    const { cycles } = findGraphCycles([
      { id: "x", dependencies: ["y"] },
      { id: "y", dependencies: ["x"] },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(expect.arrayContaining(["x", "y"]));
  });
});

describe("AC: ready set excludes tasks with any non-done dependency", () => {
  it("includes a proposed task with no dependencies", () => {
    const tasks = [task("t1", { status: "proposed" })];
    expect(readySet(tasks)).toEqual(["t1"]);
  });

  it("excludes a task whose dependency is not done", () => {
    const tasks = [
      task("t1", { status: "running" }),
      task("t2", { status: "proposed", dependencies: ["t1" as TaskId] }),
    ];
    expect(readySet(tasks)).toEqual([]);
  });

  it("includes a task once its dependency is done", () => {
    const tasks = [
      task("t1", { status: "done" }),
      task("t2", { status: "proposed", dependencies: ["t1" as TaskId] }),
    ];
    expect(readySet(tasks)).toEqual(["t2"]);
  });

  it("excludes tasks that are part of a cycle even with no other blockers", () => {
    const tasks = [
      task("t1", { status: "proposed", dependencies: ["t2" as TaskId] }),
      task("t2", { status: "proposed", dependencies: ["t1" as TaskId] }),
    ];
    expect(readySet(tasks)).toEqual([]);
  });

  it("excludes a task already running by default candidate statuses", () => {
    const tasks = [task("t1", { status: "running" })];
    expect(readySet(tasks)).toEqual([]);
  });

  it("respects a custom candidateStatuses set", () => {
    const tasks = [task("t1", { status: "blocked" })];
    expect(readySet(tasks, { candidateStatuses: ["blocked"] })).toEqual(["t1"]);
  });
});

describe("AC: topoOrder", () => {
  it("produces a valid order for an acyclic graph", () => {
    const tasks = [
      task("t3", { dependencies: ["t2" as TaskId] }),
      task("t2", { dependencies: ["t1" as TaskId] }),
      task("t1"),
    ];
    const result = topoOrder(tasks);
    expect(result.ok).toBe(true);
    const idx = (id: string) => result.order.indexOf(id as TaskId);
    expect(idx("t1")).toBeLessThan(idx("t2"));
    expect(idx("t2")).toBeLessThan(idx("t3"));
  });

  it("refuses to produce a partial order when the graph has a cycle", () => {
    const tasks = [task("t1", { dependencies: ["t2" as TaskId] }), task("t2", { dependencies: ["t1" as TaskId] })];
    const result = topoOrder(tasks);
    expect(result.ok).toBe(false);
    expect(result.order).toEqual([]);
    expect(result.cycles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC: property test — random DAGs never produce a false cycle.
// ---------------------------------------------------------------------------

/** Small deterministic PRNG so the property test is reproducible without a dependency. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random DAG on `n` nodes: edges only go from a lower index to a higher one, so it is acyclic by construction. */
function randomDag(n: number, edgeProb: number, rand: () => number): Task[] {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  return ids.map((id, i) => {
    const deps: string[] = [];
    for (let j = 0; j < i; j += 1) {
      if (rand() < edgeProb) deps.push(ids[j] as string);
    }
    return task(id, { dependencies: deps as TaskId[] });
  });
}

describe("property: random DAGs never produce a false cycle", () => {
  it("finds zero cycles across many random acyclic graphs", () => {
    const rand = mulberry32(1337);
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 1 + Math.floor(rand() * 12);
      const edgeProb = rand() * 0.6;
      const tasks = randomDag(n, edgeProb, rand);
      const result = validateGraph(tasks);
      expect(result.cycles).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.topologicalOrder).toHaveLength(n);
      const position = new Map(result.topologicalOrder.map((id, idx) => [id, idx] as const));
      for (const t of tasks) {
        for (const dep of t.dependencies) {
          expect(position.get(dep as TaskId)).toBeLessThan(position.get(t.id) as number);
        }
      }
    }
  });

  it("still finds the injected cycle when one edge is reversed into a random DAG", () => {
    const rand = mulberry32(4242);
    for (let trial = 0; trial < 50; trial += 1) {
      const n = 3 + Math.floor(rand() * 8);
      const tasks = randomDag(n, 0.3, rand);
      const last = tasks[n - 1] as Task;
      if (last.dependencies.length === 0) continue;
      const target = last.dependencies[0] as TaskId;
      const mutated = tasks.map((t) => (t.id === target ? { ...t, dependencies: [...t.dependencies, last.id] } : t));
      const result = validateGraph(mutated);
      expect(result.ok).toBe(false);
      expect(result.cycles.length).toBeGreaterThan(0);
    }
  });
});
