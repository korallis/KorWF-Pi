/**
 * Revision-aware decision caching and invalidation (issue #29; PLAN §6
 * "Cache only with complete versioned keys; never reuse stale approvals or
 * revision-sensitive evidence").
 *
 * This module extends `src/decisions/` (#27) and `src/storage/` (#23); it
 * does not redefine either. A cache hit is nothing more than "replay a
 * previously recorded `Decision` row" — the same mechanism `DecisionRecorder
 * .findReusable` already uses for opt-in `reuse`, generalised behind a
 * complete versioned key and an explicit revision-sensitivity rule.
 *
 * The key (`CacheKeyParts`, `cacheKeyOf`) is the sha256 over every component
 * that can change the correct answer:
 *
 *   - `questionId` + `questionVersion` — which question, which wording.
 *   - `contentHash` — the exact prompt/options/levels/abstention policy, so
 *     an unversioned text edit (which the registry rejects anyway) cannot
 *     silently serve an old cached answer for new wording.
 *   - `jevModelVersion` — the Jev model that answered; `null` is itself a
 *     distinct key (a fallback answer is never served as a Jev answer).
 *   - `policyVersion` — `Workflow.policyVersion` (docs/records.md §5); a
 *     policy change can change what an answer *means* even when the answer
 *     itself did not change.
 *   - `stateHash` — the minimal relevant state, already revision-aware for
 *     any input that embeds a revision (docs/records.md §5 "the state hash
 *     covers both [taskRevision and freshness.revision]").
 *   - `repoRevision` — folded in **only** when the question declares
 *     `revisionSensitive: true`. This is the PLAN §6 guarantee made
 *     concrete: a revision-sensitive question's key changes on every commit,
 *     so a decision computed at one revision can never be served at another.
 *
 * Approval-family questions are never cached at all (issue #29 acceptance
 * criterion): `isApprovalQuestion` recognises the `approval.` id prefix and
 * `cacheLookup`/`cacheStore` refuse to touch the table for them.
 */
import { createHash } from "node:crypto";
import type { Decision, DecisionId, GitSha, IsoTimestamp } from "../storage/records.ts";
import type { DecisionCacheRow, DecisionCacheStore } from "../storage/decision-cache.ts";
import { canonicalJson } from "../storage/repos/base.ts";
import type { QuestionDefinition } from "./question.ts";

// ---------------------------------------------------------------------------
// approval bypass
// ---------------------------------------------------------------------------

/**
 * Approval-related questions are never cached, whatever their
 * `revisionSensitive` flag says (issue #29 acceptance criterion: "Approval
 * questions bypass the cache"). Recognised by the `approval.` family prefix
 * from the naming policy (docs/questions.md §1, `id` is `family.question`).
 */
export function isApprovalQuestion(questionId: string): boolean {
  return questionId === "approval" || questionId.startsWith("approval.");
}

// ---------------------------------------------------------------------------
// the complete versioned key
// ---------------------------------------------------------------------------

/** Every component PLAN §6 requires a cache key to be "complete" over. */
export interface CacheKeyParts {
  readonly questionId: string;
  readonly questionVersion: string;
  readonly contentHash: string;
  /** `null` for a deterministic-fallback answer; never conflated with a Jev one. */
  readonly jevModelVersion: string | null;
  readonly policyVersion: string;
  readonly stateHash: string;
  /**
   * Repository revision the answer is only valid at. Required (not made
   * optional) so a caller cannot silently omit it for a revision-sensitive
   * question — pass `null` explicitly for a revision-insensitive one, and
   * `cacheKeyOf` folds it in only when the question actually declares
   * `revisionSensitive: true`.
   */
  readonly repoRevision: GitSha | null;
}

/**
 * sha256 over the complete versioned key. `repoRevision` is included only
 * when `revisionSensitive` is true — folding it in unconditionally would
 * needlessly fragment the cache for questions the repo state cannot affect,
 * and *not* folding it in when it matters is exactly the correctness bug
 * PLAN §6 forbids.
 */
export function cacheKeyOf(parts: CacheKeyParts, revisionSensitive: boolean): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        questionId: parts.questionId,
        questionVersion: parts.questionVersion,
        contentHash: parts.contentHash,
        jevModelVersion: parts.jevModelVersion,
        policyVersion: parts.policyVersion,
        stateHash: parts.stateHash,
        repoRevision: revisionSensitive ? parts.repoRevision : null,
      }),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// lookup / store
// ---------------------------------------------------------------------------

/** TTL policy; shape matches `JevConfig.cache` (`src/config/types.ts`). */
export interface CacheConfig {
  readonly enabled: boolean;
  /** `0` = no TTL cap beyond key freshness (row never expires by time). */
  readonly ttlSeconds: number;
}

/** The store surfaces this module needs: the cache table and decision reads. */
export interface DecisionCacheDeps {
  readonly cache: DecisionCacheStore;
  /** Reads a recorded Decision by id; `Store.decisions.get` satisfies this. */
  readonly decisions: { get(id: string): Decision | undefined };
  readonly now?: () => IsoTimestamp;
}

function addSeconds(iso: IsoTimestamp, seconds: number): IsoTimestamp {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function isExpired(row: DecisionCacheRow, now: IsoTimestamp): boolean {
  return row.expiresAt !== null && row.expiresAt <= now;
}

/**
 * Look up a cached `Decision` for the complete versioned key, or `null` on
 * any miss: cache disabled, approval question, no row, expired row, or a
 * row whose `decisionId` no longer resolves (the append-only `decision` row
 * always outlives its cache entry, but a caller may point this module at a
 * cache that predates a store it is now paired with in tests). Every miss
 * path returns `null` rather than throwing — a cache is an optimisation,
 * never a dependency (docs/questions.md \u00a72 "replay").
 */
export function cacheLookup(
  deps: DecisionCacheDeps,
  question: Pick<QuestionDefinition<unknown, unknown>, "id" | "revisionSensitive">,
  parts: CacheKeyParts,
  config: CacheConfig,
): Decision | null {
  if (!config.enabled) return null;
  if (isApprovalQuestion(question.id)) return null;
  const key = cacheKeyOf(parts, question.revisionSensitive);
  const row = deps.cache.get(key);
  if (row === undefined) return null;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  if (isExpired(row, now)) return null;
  return deps.decisions.get(row.decisionId) ?? null;
}

/**
 * Record a cache entry pointing at an already-persisted `Decision`. A no-op
 * for a disabled cache or an approval question, so a caller can call this
 * unconditionally after every `ask()` without checking either itself.
 */
export function cacheStore(
  deps: DecisionCacheDeps,
  question: Pick<QuestionDefinition<unknown, unknown>, "id" | "revisionSensitive">,
  parts: CacheKeyParts,
  decision: Decision,
  config: CacheConfig,
): void {
  if (!config.enabled) return;
  if (isApprovalQuestion(question.id)) return;
  const key = cacheKeyOf(parts, question.revisionSensitive);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  deps.cache.put({
    cacheKey: key,
    questionId: question.id,
    questionVersion: parts.questionVersion,
    decisionId: decision.id as DecisionId,
    createdAt: now,
    expiresAt: config.ttlSeconds > 0 ? addSeconds(now, config.ttlSeconds) : null,
  });
}

/**
 * Drop every cached row for one question id (all versions). Used when a
 * question's manifest hash drifts (`QuestionRegistry.diffManifest`) so a
 * stale cache entry can never survive an unversioned wording change even if
 * something bypassed `registry.register`'s pin check.
 */
export function invalidateQuestion(deps: Pick<DecisionCacheDeps, "cache">, questionId: string): number {
  return deps.cache.deleteByQuestion(questionId);
}
