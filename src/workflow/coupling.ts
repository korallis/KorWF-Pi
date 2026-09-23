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

// ---------------------------------------------------------------------------
// The coupling cache (issue #76 Scope: "scheduler consults a
// canRunConcurrently(a, b) cache")
// ---------------------------------------------------------------------------

/** Cache key for an unordered task pair at the revisions it was judged at. */
export function couplingKey(a: Task, b: Task): string {
  const left = `${a.id}@${a.revision}`;
  const right = `${b.id}@${b.revision}`;
  return left <= right ? `${left}|${right}` : `${right}|${left}`;
}

/** One cached semantic-coupling verdict. */
export interface CachedCoupling {
  readonly verdict: CouplingVerdict;
  /** `id@version` of the question that produced it, or `null` for a fallback. */
  readonly source: string | null;
  readonly decisionId: string | null;
}

/**
 * Memoised `tasks.coupling@1` verdicts, keyed by the unordered task pair
 * **at the revisions asked about**.
 *
 * Including the revision is not decoration. `Task.revision` bumps whenever
 * `goal`, `acceptanceCriteria` or `checks` change — exactly the fields the
 * question is asked about — so an edited task cannot be served a verdict
 * computed for its earlier wording. The cache misses instead, and a miss
 * reads as `"unknown"`, which serialises.
 *
 * A miss is never an error, and `get` never throws: the absence of a
 * verdict is a legitimate, expected state (no Jev key, request refused,
 * deadline exceeded) and it is the safe one.
 */
export class CouplingCache {
  readonly #entries = new Map<string, CachedCoupling>();

  /** The cached verdict for this pair, or `"unknown"` when there is none. */
  verdict(a: Task, b: Task): CouplingVerdict {
    return this.#entries.get(couplingKey(a, b))?.verdict ?? "unknown";
  }

  /** The full cached entry, or `undefined` on a miss. */
  get(a: Task, b: Task): CachedCoupling | undefined {
    return this.#entries.get(couplingKey(a, b));
  }

  has(a: Task, b: Task): boolean {
    return this.#entries.has(couplingKey(a, b));
  }

  /**
   * Record a verdict for a pair. Storing `"unknown"` is meaningful — it
   * says "this pair was asked about and the answer was not usable" — and
   * behaves identically to a miss at decision time.
   */
  set(a: Task, b: Task, entry: CachedCoupling): void {
    this.#entries.set(couplingKey(a, b), entry);
  }

  /** Drop every entry mentioning `taskId`, whatever revision it was judged at. */
  invalidateTask(taskId: TaskId): number {
    let removed = 0;
    for (const key of [...this.#entries.keys()]) {
      if (key.split("|").some((side) => side.slice(0, side.lastIndexOf("@")) === taskId)) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** A `CouplingSignal` for #75's `planPass`, reading this cache. */
  signal(): CouplingSignal {
    return (a: Task, b: Task) => this.verdict(a, b);
  }
}

/** Revision pair a cached verdict was computed against, for auditing. */
export function couplingRevisions(a: Task, b: Task): readonly [Revision, Revision] {
  return a.id <= b.id ? [a.revision, b.revision] : [b.revision, a.revision];
}

/** Human-readable naming of what two tasks both claim. */
export function describeOverlap(overlap: OwnershipIntersection): string {
  const parts = [
    ...overlap.paths.map((p) => (p.a === p.b ? p.a : `${p.a} ∩ ${p.b}`)),
    ...overlap.components.map((c) => `component ${c}`),
  ];
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// canRunConcurrently: code first, Jev second, unknown → serial
// ---------------------------------------------------------------------------

/** Optional inputs to {@link canRunConcurrently}. */
export interface ConcurrencyOptions {
  /** Cached `tasks.coupling@1` verdicts. Omitted → every pair is uncertain. */
  readonly cache?: CouplingCache;
  /**
   * A raw signal, for callers that hold verdicts somewhere other than a
   * `CouplingCache`. Consulted only when the cache has no entry, and only
   * after the ownership check has already passed — it cannot be used to
   * clear an overlap.
   */
  readonly signal?: CouplingSignal;
}

/**
 * May these two tasks run at the same time?
 *
 * The order of the two checks is the whole design, so it is spelled out:
 *
 * 1. `ownershipConflict` runs **first and unconditionally**. If the tasks'
 *    declared globs or components intersect, the function returns `ok:
 *    false` from inside that branch. No signal is read on that path — not
 *    consulted and discarded, simply never reached — so no Jev verdict,
 *    cache entry or caller option can make an overlapping pair parallel.
 * 2. Only for disjoint ownership does the semantic signal get a say, and
 *    there it can only *subtract* concurrency: `"independent"` permits what
 *    ownership already permitted, while `"coupled"` and `"unknown"`
 *    serialise. A missing cache, a missing signal, a disabled Jev and a
 *    refused request all produce `"unknown"`, so the no-key configuration
 *    is the conservative one (PLAN §3.E "default to serial when coupling is
 *    uncertain").
 *
 * A task is never concurrent with itself; that pair returns `ok: false`.
 */
export function canRunConcurrently(a: Task, b: Task, options: ConcurrencyOptions = {}): ConcurrencyVerdict {
  if (a.id === b.id) {
    return {
      ok: false,
      reason: "ownership_conflict",
      detail: `task ${a.id} cannot run concurrently with itself`,
      overlap: EMPTY_INTERSECTION,
      coupling: "unknown",
    };
  }
  const overlap = ownershipConflict(a, b);
  if (hasOwnershipOverlap(overlap)) {
    return {
      ok: false,
      reason: "ownership_conflict",
      detail: `tasks ${a.id} and ${b.id} both declare ownership of ${describeOverlap(overlap)}`,
      overlap,
      coupling: "unknown",
    };
  }
  const coupling = couplingVerdictFor(a, b, options);
  if (coupling === "coupled") {
    return {
      ok: false,
      reason: "coupled",
      detail: `tasks ${a.id} and ${b.id} are semantically coupled; running them serially`,
      overlap,
      coupling,
    };
  }
  if (coupling === "unknown") {
    return {
      ok: false,
      reason: "coupling_uncertain",
      detail:
        `coupling between tasks ${a.id} and ${b.id} is uncertain; ` +
        `defaulting to serial (PLAN §3.E)`,
      overlap,
      coupling,
    };
  }
  return {
    ok: true,
    reason: null,
    detail: `tasks ${a.id} and ${b.id} declare disjoint ownership and were judged independent`,
    overlap,
    coupling,
  };
}

/**
 * The semantic verdict for a disjoint pair: cache first, then the raw
 * signal, then `"unknown"`. A signal that throws is treated as `"unknown"`
 * rather than propagating — a scheduling pass must not fail because an
 * advisory signal did, and the failure direction is serial.
 */
function couplingVerdictFor(a: Task, b: Task, options: ConcurrencyOptions): CouplingVerdict {
  const cached = options.cache?.get(a, b);
  if (cached !== undefined) return cached.verdict;
  if (options.signal === undefined) return "unknown";
  try {
    return options.signal(a, b);
  } catch {
    return "unknown";
  }
}

/**
 * A `CouplingSignal` for #75's `planPass` that reads a cache and an optional
 * raw signal. Note what this returns to the scheduler: the *semantic*
 * verdict only. The scheduler applies its own ownership check first and is
 * not asked to trust this one — both layers refuse an overlap independently,
 * which is why neither can be the single point of failure.
 */
export function couplingSignalFrom(options: ConcurrencyOptions = {}): CouplingSignal {
  return (a, b) => couplingVerdictFor(a, b, options);
}

/** Partition a candidate set into one parallel batch and the tasks held for later. */
export interface ConcurrentBatch {
  readonly parallel: readonly TaskId[];
  readonly serial: readonly { readonly taskId: TaskId; readonly reason: SerialReason; readonly detail: string }[];
}

/**
 * Greedily select the largest prefix-stable set of tasks that may all run
 * together, in the order given. Every admitted task is checked against every
 * already-admitted one, so admission is transitive by construction: three
 * tasks run together only if all three pairs are clear.
 */
export function selectConcurrentBatch(
  candidates: readonly Task[],
  options: ConcurrencyOptions = {},
): ConcurrentBatch {
  const parallel: TaskId[] = [];
  const admitted: Task[] = [];
  const serial: { taskId: TaskId; reason: SerialReason; detail: string }[] = [];
  for (const task of candidates) {
    const blocked = admitted
      .map((other) => canRunConcurrently(task, other, options))
      .find((verdict) => !verdict.ok);
    if (blocked !== undefined && blocked.reason !== null) {
      serial.push({ taskId: task.id, reason: blocked.reason, detail: blocked.detail });
      continue;
    }
    parallel.push(task.id);
    admitted.push(task);
  }
  return { parallel, serial };
}
