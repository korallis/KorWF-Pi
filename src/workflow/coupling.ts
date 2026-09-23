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
