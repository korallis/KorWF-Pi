/**
 * `src/workflow/coupling.ts` (issue #76; PLAN §3.E).
 *
 * Test names reference the acceptance criterion they exercise:
 * - AC1 "overlapping globs → serial regardless of Jev";
 * - AC2 "`unknown` → serial";
 * - AC3 "independent + Jev independent → parallel" (the scheduler half of
 *   AC3 lives in `coupling-scheduler.test.ts`).
 */
import { describe, it, expect } from "vitest";
import type { Task, TaskId } from "../../../src/storage/records.ts";
import {
  canRunConcurrently,
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
import { makeTask } from "../../helpers/records.ts";

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
