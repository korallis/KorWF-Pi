/**
 * Evidence invalidation after relevant changes (issue #50; PLAN §3.F
 * "Evidence invalidated after relevant changes"; scenario 2 A4/A5,
 * `test/scenarios/02-existing-repo.md`).
 *
 * `flaky.ts` (#51) already computes freshness from `(taskRevision, revision,
 * supersession)` — the *definition* of "current". This module answers a
 * different question: **when the worktree moves out from under a task that
 * is already `review`/verifying-candidate, which checks stop being fresh,
 * and does the task need to go back to `verifying`?**
 *
 * It does not duplicate freshness: `isFreshEvidence`/`latestFreshEvidence`
 * remain the one place that reads `Evidence.revision` against `SHA(T)`. This
 * module supplies the *relevance* half — deciding which changed paths matter
 * for which check — and the state-machine glue that fires
 * `task-stale-evidence` (`transitions.ts`) consistently with #41's
 * `INVALIDATION_STATE_EFFECTS` and `invalidation.ts`'s "retained, not
 * deleted, excluded from current gates" rule.
 *
 * Relevance, conservatively (Scope):
 *
 *  - **Project-wide checks are always invalidated** by any change: they have
 *    no declared ownership, so "unknown -> invalidate" applies unconditionally.
 *  - **A task check is invalidated** when a changed path falls inside the
 *    task's declared `ownership.paths` — the only place a check's "inputs"
 *    are declared today (`CheckDefinition` carries no separate input list).
 *    A path outside ownership never invalidates a task check; a path *inside*
 *    ownership always does, whether or not the check's own command mentions
 *    it, because "the check's declared inputs" is read as the ownership the
 *    planner attached to the whole verification surface, and being
 *    conservative means treating any owned-path change as relevant.
 *  - Unknown/unparseable changes (a git failure, an empty change list with a
 *    signalled "something changed") invalidate everything: silence must never
 *    read as freshness.
 */
export {};
