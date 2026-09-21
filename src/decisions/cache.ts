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
