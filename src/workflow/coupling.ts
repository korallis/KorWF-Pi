/**
 * Ownership overlap, the semantic-coupling cache, and the writing-worker
 * worktree rule (issue #76; PLAN §3.E).
 *
 * > Separate Git worktrees for parallel writing workers; one integration
 * > owner; never concurrent uncontrolled integration into the user's tree.
 * > Declared ownership conflicts detected in code; Jev adds a
 * > semantic-coupling signal; default to serial when coupling is uncertain.
 *
 * Three things live here, and the separation between them is the point:
 *
 * 1. **Ownership overlap is a set computation.** `ownershipConflict` below
 *    intersects the tasks' declared globs and components. It takes no
 *    signal, consults no model, and its answer is not overridable. #75's
 *    `scheduler.mayRunConcurrently` already refuses to let a coupling
 *    verdict unblock an overlap; this module widens *what counts as an
 *    overlap* from exact string equality to glob intersection, and does not
 *    touch that ordering.
 * 2. **Jev only adds.** A `CouplingCache` holds `tasks.coupling@1` verdicts
 *    (`src/decisions/questions/coupling.ts`). A pair with no cached verdict
 *    reads as `"unknown"`, and `"unknown"` means serial — so no key, no
 *    answer, a stale answer or a thrown request all land on the safe side.
 * 3. **A writing worker never works in the user's tree.** `assertWorkerTree`
 *    composes #69's read-only roles with #70's repository identity: a role
 *    that can mutate must be given a linked worktree of the same repository,
 *    never the main tree.
 */
import type { Ownership, Revision, Task, TaskId } from "../storage/records.ts";
import type { RoleId } from "../workers/roles.ts";
import type { GitEnvRunner, WorktreeIdentity } from "../git/index.ts";
import type { CouplingSignal, CouplingVerdict } from "./scheduler.ts";

/** Why two tasks may not run at the same time; `null` when they may. */
export type SerialReason = "ownership_conflict" | "coupled" | "coupling_uncertain";

/** The verdict for one ordered pair, with the evidence that produced it. */
export interface ConcurrencyVerdict {
  readonly ok: boolean;
  readonly reason: SerialReason | null;
  readonly detail: string;
  /** Declared ownership the two tasks both claim; empty when disjoint. */
  readonly overlap: OwnershipIntersection;
  /** The semantic signal consulted, or `"unknown"` when none was available. */
  readonly coupling: CouplingVerdict;
}

/** The declared ownership two tasks both claim, as matched glob/component pairs. */
export interface OwnershipIntersection {
  readonly paths: readonly OverlappingPaths[];
  readonly components: readonly string[];
}

/** One pair of declared path patterns that can match a common file. */
export interface OverlappingPaths {
  readonly a: string;
  readonly b: string;
  readonly rule: PathOverlapRule;
}

/** Why two declared path patterns were judged to overlap. */
export type PathOverlapRule = "identical" | "containment" | "glob_intersection";

// ---------------------------------------------------------------------------
// Glob intersection (issue #76 Scope: "ownership overlap via glob intersection")
// ---------------------------------------------------------------------------

type SegToken =
  | { readonly kind: "star" }
  | { readonly kind: "any" }
  | { readonly kind: "lit"; readonly ch: string }
  | { readonly kind: "class"; readonly negated: boolean; readonly body: string };

/** Characters probed when deciding whether two character classes can agree. */
const PROBE_CHARS = (() => {
  const chars: string[] = [];
  for (let code = 0x20; code <= 0x7e; code += 1) chars.push(String.fromCharCode(code));
  return chars.filter((c) => c !== "/");
})();

/** Tokenise one path segment's glob syntax. Unterminated `[` is a literal. */
function tokenise(segment: string): readonly SegToken[] {
  const out: SegToken[] = [];
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] ?? "";
    if (ch === "*") {
      if (out[out.length - 1]?.kind !== "star") out.push({ kind: "star" });
      continue;
    }
    if (ch === "?") {
      out.push({ kind: "any" });
      continue;
    }
    if (ch === "[") {
      const close = segment.indexOf("]", i + 1);
      if (close > i + 1) {
        const raw = segment.slice(i + 1, close);
        const negated = raw.startsWith("!") || raw.startsWith("^");
        out.push({ kind: "class", negated, body: negated ? raw.slice(1) : raw });
        i = close;
        continue;
      }
    }
    out.push({ kind: "lit", ch });
  }
  return out;
}

/** Does a character-class body (already un-negated) contain `ch`? Supports `a-z` ranges. */
function classContains(body: string, ch: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    const lo = body[i] ?? "";
    if (body[i + 1] === "-" && i + 2 < body.length) {
      const hi = body[i + 2] ?? "";
      if (ch >= lo && ch <= hi) return true;
      i += 2;
      continue;
    }
    if (ch === lo) return true;
  }
  return false;
}

function matchesToken(token: SegToken, ch: string): boolean {
  switch (token.kind) {
    case "any":
      return true;
    case "lit":
      return token.ch === ch;
    case "class":
      return token.negated ? !classContains(token.body, ch) : classContains(token.body, ch);
    case "star":
      return true;
  }
}

/** Is there any single character both single-character tokens accept? */
function tokensIntersect(a: SegToken, b: SegToken): boolean {
  if (a.kind === "lit") return matchesToken(b, a.ch);
  if (b.kind === "lit") return matchesToken(a, b.ch);
  if (a.kind === "any" || b.kind === "any") return true;
  return PROBE_CHARS.some((ch) => matchesToken(a, ch) && matchesToken(b, ch));
}

/**
 * Can two single-segment glob patterns match a common string? Decided by
 * memoised pattern-against-pattern matching, so `foo*` and `*bar` correctly
 * intersect (`foobar`) while `foo*` and `bar*` correctly do not. This is a
 * decision about the patterns; the filesystem is never consulted, so it
 * holds for files that do not exist yet — which is the case for every task
 * that has not run.
 */
export function segmentsIntersect(a: string, b: string): boolean {
  const ta = tokenise(a);
  const tb = tokenise(b);
  const seen = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (tb.length + 1) + j;
    const cached = seen.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === ta.length && j === tb.length) result = true;
    else if (i === ta.length) result = tb.slice(j).every((t) => t.kind === "star");
    else if (j === tb.length) result = ta.slice(i).every((t) => t.kind === "star");
    else {
      const x = ta[i] as SegToken;
      const y = tb[j] as SegToken;
      if (x.kind === "star" && y.kind === "star") result = go(i + 1, j) || go(i, j + 1);
      else if (x.kind === "star") result = go(i + 1, j) || go(i, j + 1);
      else if (y.kind === "star") result = go(i, j + 1) || go(i + 1, j);
      else result = tokensIntersect(x, y) && go(i + 1, j + 1);
    }
    seen.set(key, result);
    return result;
  };
  return go(0, 0);
}

/**
 * Declared ownership of a path is ownership of everything under it: a task
 * that claims `src/workflow` claims `src/workflow/coupling.ts` too. A
 * pattern that does not already end in a wildcard therefore stands for both
 * itself and its subtree. (`src/x.ts` also gains `src/x.ts/**`, which is
 * vacuous for a file and costs nothing.)
 */
export function expandOwnershipPattern(pattern: string): readonly string[] {
  const p = normaliseOwnershipPath(pattern);
  if (p.length === 0) return [];
  if (p.endsWith("*")) return [p];
  return [p, `${p}/**`];
}

/** `/` separators, no `./`, no doubled or trailing slash, no leading `/`. */
export function normaliseOwnershipPath(pattern: string): string {
  if (typeof pattern !== "string") return "";
  let out = pattern.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  while (out.startsWith("/")) out = out.slice(1);
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Segment-wise intersection with `**` matching zero or more segments. */
function segmentListsIntersect(a: readonly string[], b: readonly string[]): boolean {
  const seen = new Set<number>();
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === a.length && j === b.length) return true;
    if (i === a.length) return b.slice(j).every((s) => s === "**");
    if (j === b.length) return a.slice(i).every((s) => s === "**");
    const x = a[i] as string;
    const y = b[j] as string;
    if (x === "**") return go(i + 1, j) || go(i, j + 1);
    if (y === "**") return go(i, j + 1) || go(i + 1, j);
    return segmentsIntersect(x, y) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/**
 * Could the two declared ownership patterns ever name the same file?
 *
 * This is the deterministic half of PLAN §3.E. It answers a question about
 * *patterns*, not about files on disk, so it is stable, cheap, and correct
 * before any worker has written anything. It errs towards "yes": an
 * unsupported or malformed pattern is compared literally rather than
 * discarded, because a pattern that failed to parse and was dropped would
 * fail open into an uncontrolled concurrent write.
 */
export function pathsIntersect(a: string, b: string): PathOverlapRule | null {
  const na = normaliseOwnershipPath(a);
  const nb = normaliseOwnershipPath(b);
  if (na.length === 0 || nb.length === 0) return null;
  if (na === nb) return "identical";
  const plainPrefix =
    (!hasGlobSyntax(na) && !hasGlobSyntax(nb)) && (nb.startsWith(`${na}/`) || na.startsWith(`${nb}/`));
  if (plainPrefix) return "containment";
  for (const pa of expandOwnershipPattern(na)) {
    for (const pb of expandOwnershipPattern(nb)) {
      if (segmentListsIntersect(pa.split("/"), pb.split("/"))) return "glob_intersection";
    }
  }
  return null;
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

// ---------------------------------------------------------------------------
// Ownership overlap between two tasks
// ---------------------------------------------------------------------------

const EMPTY_INTERSECTION: OwnershipIntersection = Object.freeze({
  paths: Object.freeze([]) as readonly OverlappingPaths[],
  components: Object.freeze([]) as readonly string[],
});

/**
 * Every declared path pattern pair that can name a common file, plus every
 * component both tasks claim. A pure set computation over the two
 * `Ownership` records — no store, no clock, no signal.
 */
export function ownershipIntersection(a: Ownership, b: Ownership): OwnershipIntersection {
  const paths: OverlappingPaths[] = [];
  for (const pa of a.paths) {
    for (const pb of b.paths) {
      const rule = pathsIntersect(pa, pb);
      if (rule !== null) paths.push({ a: pa, b: pb, rule });
    }
  }
  const aComponents = new Set(a.components.map((c) => c.trim()).filter((c) => c.length > 0));
  const components = [...new Set(b.components.map((c) => c.trim()))].filter((c) => aComponents.has(c));
  if (paths.length === 0 && components.length === 0) return EMPTY_INTERSECTION;
  return { paths, components };
}

/** `true` when the intersection names anything at all. */
export function hasOwnershipOverlap(overlap: OwnershipIntersection): boolean {
  return overlap.paths.length > 0 || overlap.components.length > 0;
}

/**
 * Declared ownership conflict between two tasks, decided in code.
 *
 * This is deliberately *not* parameterised by anything: there is no options
 * bag, no signal, no escape hatch. A caller cannot ask it to be lenient,
 * which is what makes "overlapping globs → serial regardless of Jev" a
 * property of the module rather than a convention callers must follow.
 */
export function ownershipConflict(a: Task, b: Task): OwnershipIntersection {
  if (a.id === b.id) return EMPTY_INTERSECTION;
  return ownershipIntersection(a.ownership, b.ownership);
}

/** Human-readable naming of what two tasks both claim. */
export function describeOverlap(overlap: OwnershipIntersection): string {
  const parts = [
    ...overlap.paths.map((p) => (p.a === p.b ? p.a : `${p.a} ∩ ${p.b}`)),
    ...overlap.components.map((c) => `component ${c}`),
  ];
  return parts.join(", ");
}
