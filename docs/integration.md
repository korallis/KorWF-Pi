# Integration: one owner, a checked base, and conflicts as a workflow

Issue #78. Design authority: PLAN §3.E ("Separate Git worktrees for parallel writing
workers; **one integration owner; never concurrent uncontrolled integration into the
user's tree**"), PLAN §2.1.

Code: `src/workflow/integrate.ts`, `src/git/merge.ts`, `src/storage/integration-queue.ts`,
migration `0013-integration.sql`. Tests: `test/unit/workflow/integrate.test.ts`.

## 1. The branch layout

| Branch | Who writes it | When |
|---|---|---|
| task branch (one per task worktree, #76) | that task's worker | during the attempt |
| `korwf/<workflow>/<phase>` | the integration owner, one item at a time | as tasks complete |
| the user's branch | **nobody in this package** | only after a granted `merge_to_user_branch` approval |

`integrationBranch(workflowId, phaseId)` is the single definition of the middle row.
`isWorkflowOwnedRef` answers "is this a ref the workflow owns?" as a string check on the
`korwf/<workflow>/` prefix, which is what #15's `refOwnedByWorkflow` needs.

## 2. One owner

Two mechanisms, deliberately both:

1. **The integration lease** — `acquireIntegrationLease` uses `src/storage/lock.ts`'s
   `acquireLock` on `<storage-root>/korwf-integration.lock`. `O_EXCL` creation means two
   integrators racing produce exactly one winner; the holder's **pid** decides liveness, so
   a crashed integrator is taken over rather than wedging the phase forever, and a live one
   is never displaced by a timer. It is a *separate* file from the coordinator lock (#77):
   the coordinator owns the right to schedule, this owns the right to merge, and a takeover
   of one must not silently confer the other.
2. **The atomic claim** — `IntegrationQueueStore.claimNext` selects the FIFO head and marks
   it `integrating` inside the store's `BEGIN IMMEDIATE` transaction, with a
   `WHERE status = 'queued'` guard. A second integrator either sees the item already
   claimed or finds nothing queued.

`integrateNext` refuses outright (`NotIntegrationOwnerError`) when the caller does not hold
the lease. `runIntegrationQueue` drains item by item; its `peakConcurrentIntegrations` is
instrumentation for the test, not the mechanism.

FIFO order is `(enqueuedAt, rowid)`, so two workers finishing in the same millisecond still
have a total order.

## 3. Base-revision validation

#45 records the exact revision each check ran at. Before merging, `checkBaseRevision`
relates the item's recorded base to where the integration branch is *now*, using
`src/git/revision.ts`'s ancestry (`merge-base --is-ancestor`) — never a string compare.

| Verdict | Relation | Merge? | Re-verify? |
|---|---|---|---|
| `current` | `same`, or the branch does not exist yet | yes | no |
| `behind` | recorded base is an ancestor of the head (`advanced`) | yes | **yes** |
| `unmergeable` | `rewound`, `diverged`, `unknown_revision`, `indeterminate` | **no** | yes |

`indeterminate` is what a git failure produces, and it lands in `unmergeable`: silence never
reads as freshness.

`behind` is the issue's "if the worktree's base is behind, rebase/merge" case. The merge
happens, but the evidence taken against the old base no longer covers the merged result, so
the task goes back to `verifying` through #50's `invalidateStaleEvidence` with an `unknown`
change set (#50 defines `unknown` as invalidating everything). Merged, never *accepted*, on
trust. `unmergeable` settles the item `stale_base` and merges nothing at all.

## 4. Conflicts are a workflow

`src/git/merge.ts`'s `mergeBranch`:

- refuses a **dirty** integration worktree (`dirty_tree`) rather than merging over
  uncommitted work — #54/#70's rule, and the reason nothing here stashes;
- on conflict, collects the unmerged paths and then runs `git merge --abort`, so the tree is
  clean and recoverable when the caller sees the conflict (#82 owns recovery; this owes it a
  clean tree).

`integrateNext` then:

1. records an `integration_conflict` row with the conflicted paths (append-only: a conflict
   that happened stays recorded);
2. settles the item `conflicted`;
3. asks the caller's `resolutionTask` factory for a **bounded resolution task restricted to
   exactly those paths**;
4. if none can be created — no factory, or the factory declines, which is the deterministic
   no-Jev, no-resolver fallback — raises the `integration_conflict` phase blocker through
   `blockers.ts` (phase → `paused_approval`) and emits a `ConflictNotification` naming the
   paths. The drain stops there rather than merging later items onto a base a human is about
   to change.

`resolveConflict` accepts a resolution only when:

- `reverified` is true — supplied by the caller from a #46 gate receipt, never from the
  resolver's claim; and
- every changed path is one of the conflicted paths (`paths_outside_conflict`).

An accepted resolution enqueues a **new** item at the resolution's own revisions; the
conflicted item stays `conflicted` in the history.

## 5. The user's branch

`proposeUserBranchMerge` is the only function that mentions the user's branch, and it only
writes an `ApprovalRequest`. There is no counterpart here that performs the merge.

`merge_to_user_branch` is a **high-risk** approval class (PLAN §7 tier): `stop` in every
mode, schema-pinned by `HighRiskPolicy`'s `const`, re-checked after layered merge by V10.
Nothing in this module can make the promotion automatic. `classifyAct` routes
`{ kind: "git", gitOp: "merge", targetIsUserBranch: true }` to it; a merge into an
integration branch the workflow owns stays `local_commit`.

The proposal is refused before it is even asked while the phase gate has not passed, while
items are still queued, or while a conflict is open — asking a human to approve a merge of
work that is not finished is how an approval gets reused later for something it did not
describe.
