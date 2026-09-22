/**
 * Dependency-graph validation, ready-set, and topological order (issue #40;
 * PLAN §3.C "Schema and dependency-graph validation (including cycles) in
 * code", §6 "Graph algorithms, arithmetic, counters, schema checks in
 * code.").
 *
 * `plan-schema.ts` (#37) already validates the dependency graph of a *plan
 * document* before it is ever persisted (planner-local ids, no status). This
 * module operates one layer down, on persisted `Task` records: unknown
 * references, self-dependencies, cross-phase edges that run backwards, and
 * cycles — the same graph facts, checked again wherever a graph reaches this
 * module rather than only at plan-parse time — plus the two things that need
 * `Task.status` and therefore cannot live in `plan-schema.ts`: the ready set
 * (#41's scheduler input) and a topological order for dispatch.
 *
 * Pure and deterministic: no Jev, no I/O, no clock. A dependency cycle is a
 * graph fact, not a judgment (issue #40) — this module is the only place
 * that decides whether a graph is valid.
 */
import type { Phase, Task, TaskId } from "../storage/records.ts";
import { TASK_TRANSITIONS } from "./transitions.ts";

// ---------------------------------------------------------------------------
// Generic cycle detection, shared by validateGraph and topoOrder
// ---------------------------------------------------------------------------

/** The minimal shape `findGraphCycles` needs: a stable id and its dependency ids. */
export interface DependencyEdge {
  readonly id: string;
  readonly dependencies: readonly string[];
}

export interface CycleSearchResult {
  /** Every distinct cycle found, each as the ordered ids that close it (no repeated closing id). */
  readonly cycles: readonly (readonly string[])[];
  /** Ids not part of any cycle, in an order where every dependency precedes its dependents. */
  readonly order: readonly string[];
}

/**
 * Iterative depth-first search with an explicit stack — a deep dependency
 * chain must not blow the call stack, and a stack overflow is not a
 * validation error a user can act on. Returns every distinct cycle (as the
 * ordered ids that close it) plus a topological order of the acyclic part.
 * Unknown dependency ids are ignored here; `validateGraph` reports those
 * separately as `unknown_dependency`.
 *
 * Deterministic: nodes and each node's own dependency list are visited in
 * the order given, so the same graph always reports the same cycle first.
 */
export function findGraphCycles(nodes: readonly DependencyEdge[]): CycleSearchResult {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const colour = new Map<string, number>(nodes.map((n) => [n.id, WHITE] as const));
  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  const order: string[] = [];

  for (const root of nodes) {
    if (colour.get(root.id) !== WHITE) continue;
    const path: string[] = [];
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    colour.set(root.id, GREY);
    path.push(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const node = byId.get(frame.id) as DependencyEdge;
      const deps = node.dependencies.filter((d) => byId.has(d));
      if (frame.next < deps.length) {
        const dep = deps[frame.next] as string;
        frame.next += 1;
        const state = colour.get(dep);
        if (state === GREY) {
          const start = path.indexOf(dep);
          const cycle = path.slice(start === -1 ? 0 : start);
          const key = canonicalCycleKey(cycle);
          if (!seenCycle.has(key)) {
            seenCycle.add(key);
            cycles.push(cycle);
          }
          continue;
        }
        if (state === WHITE) {
          colour.set(dep, GREY);
          path.push(dep);
          stack.push({ id: dep, next: 0 });
        }
        continue;
      }
      colour.set(frame.id, BLACK);
      order.push(frame.id);
      path.pop();
      stack.pop();
    }
  }
  return { cycles, order };
}

/** Rotation-independent key so the same cycle is reported once. */
function canonicalCycleKey(cycle: readonly string[]): string {
  if (cycle.length === 0) return "";
  const sorted = [...cycle].sort();
  const start = cycle.indexOf(sorted[0] as string);
  return [...cycle.slice(start), ...cycle.slice(0, start)].join(">");
}

// ---------------------------------------------------------------------------
// Task-record graph validation
// ---------------------------------------------------------------------------

/** Stable ids for the rules this module reports. Kept disjoint from `plan-schema.ts`'s `PlanRuleId`. */
export type GraphRuleId = "unknown_dependency" | "self_dependency" | "dependency_cycle" | "forward_phase_dependency";

export interface GraphIssue {
  readonly rule: GraphRuleId;
  /** The task whose `dependencies` entry produced this finding. */
  readonly taskId: TaskId;
  /** The offending dependency id, when the rule concerns one specific edge. */
  readonly dependsOn: TaskId | null;
  readonly message: string;
}

export interface GraphValidationResult {
  readonly ok: boolean;
  readonly issues: readonly GraphIssue[];
  /** Every cycle found, each as the ordered task ids that close it (PLAN §6: named exactly). */
  readonly cycles: readonly (readonly TaskId[])[];
  /** Task ids in an order where every dependency precedes its dependents. Excludes tasks in a cycle. */
  readonly topologicalOrder: readonly TaskId[];
}

/**
 * Validate the dependency graph of a set of persisted `Task` records:
 * unknown dependency ids, self-dependencies, cross-phase edges that point
 * into a *later* phase (phases run in order, so such a task can never become
 * ready), and cycles — reported with every task id in the cycle, in cycle
 * order, so a user can fix it without re-deriving the graph themselves.
 *
 * `phases` is optional; when omitted, forward-phase checking is skipped (a
 * caller validating a single phase's tasks in isolation has no ordering to
 * check against).
 */
export function validateGraph(
  tasks: readonly Task[],
  phases: readonly Phase[] = [],
): GraphValidationResult {
  const issues: GraphIssue[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const phaseOrder = new Map(phases.map((p) => [p.id, p.order] as const));

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (dep === task.id) {
        issues.push({
          rule: "self_dependency",
          taskId: task.id,
          dependsOn: dep,
          message: `task "${task.id}" depends on itself`,
        });
        continue;
      }
      const depTask = byId.get(dep);
      if (depTask === undefined) {
        issues.push({
          rule: "unknown_dependency",
          taskId: task.id,
          dependsOn: dep,
          message: `task "${task.id}" depends on unknown task "${dep}"`,
        });
        continue;
      }
      const here = phaseOrder.get(task.phaseId);
      const there = phaseOrder.get(depTask.phaseId);
      if (here !== undefined && there !== undefined && there > here) {
        issues.push({
          rule: "forward_phase_dependency",
          taskId: task.id,
          dependsOn: dep,
          message:
            `task "${task.id}" in phase ${here} depends on "${dep}" in later phase ${there}; ` +
            `phases run in order, so this can never become ready`,
        });
      }
    }
  }

  const { cycles, order } = findGraphCycles(
    tasks.map((t) => ({ id: t.id, dependencies: t.dependencies })),
  );
  for (const cycle of cycles) {
    const first = cycle[0] as TaskId;
    issues.push({
      rule: "dependency_cycle",
      taskId: first,
      dependsOn: null,
      message: `dependency cycle: ${[...cycle, first].join(" -> ")}`,
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    cycles: cycles as readonly (readonly TaskId[])[],
    topologicalOrder: order as readonly TaskId[],
  };
}

// ---------------------------------------------------------------------------
// Ready set (PLAN §3.C; feeds #41's scheduler)
// ---------------------------------------------------------------------------

/** Task statuses that count as "the dependency is satisfied" for readiness purposes. */
const DONE_STATUS = "done";

/**
 * Tasks whose every dependency is `done`, restricted to tasks that are
 * themselves candidates to run (default: `proposed` or `ready`; a task already
 * `running`/terminal is not something the scheduler needs to (re)admit).
 *
 * This is a graph fact over `Task.status`, computed the same way regardless
 * of caller: a task with an unmet, unknown, or cyclic dependency is never in
 * the ready set, matching `readiness_valid` in `transitions.ts`.
 */
export function readySet(
  tasks: readonly Task[],
  options: { readonly candidateStatuses?: readonly Task["status"][] } = {},
): readonly TaskId[] {
  const candidateStatuses = new Set(options.candidateStatuses ?? ["proposed", "ready"]);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const graph = validateGraph(tasks);
  const inCycle = new Set(graph.cycles.flat());

  const out: TaskId[] = [];
  for (const task of tasks) {
    if (!candidateStatuses.has(task.status)) continue;
    if (inCycle.has(task.id)) continue;
    const depsOk = task.dependencies.every((dep) => {
      const depTask = byId.get(dep);
      return depTask !== undefined && depTask.status === DONE_STATUS;
    });
    if (depsOk) out.push(task.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Topological order for the scheduler (Stage 6)
// ---------------------------------------------------------------------------

export interface TopoOrderResult {
  readonly ok: boolean;
  /** Task ids in dependency order. Empty when the graph has a cycle. */
  readonly order: readonly TaskId[];
  /** Every cycle found, when `ok` is `false`. */
  readonly cycles: readonly (readonly TaskId[])[];
}

/**
 * A total topological order over `tasks`, for the scheduler to walk in
 * dispatch order (Stage 6). Refuses (returns `ok: false`) rather than
 * producing a partial order when the graph has a cycle — a scheduler must
 * never silently skip the cyclic tasks and proceed as if the graph were
 * fine.
 */
export function topoOrder(tasks: readonly Task[]): TopoOrderResult {
  const graph = validateGraph(tasks);
  if (graph.cycles.length > 0) {
    return { ok: false, order: [], cycles: graph.cycles };
  }
  return { ok: true, order: graph.topologicalOrder, cycles: [] };
}

// ---------------------------------------------------------------------------
// Reference to the transition table, so the precondition text this module
// implements cannot silently drift from what it enforces.
// ---------------------------------------------------------------------------

/** The `transitions.ts` precondition this module's `readySet`/`validateGraph` satisfy the graph half of. */
export const READINESS_GRAPH_PRECONDITION = "readiness_valid" satisfies (typeof TASK_TRANSITIONS)[number]["preconditions"][number];
