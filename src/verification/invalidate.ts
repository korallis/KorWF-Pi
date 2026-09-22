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
import type { CheckDefinition, GitSha, IsoTimestamp, Ownership, Task, TaskId } from "../storage/records.ts";
import type { Store } from "../storage/db.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import { isProjectCheck } from "./checks.ts";
import { isFreshEvidence, type FreshnessInput } from "./flaky.ts";
import { transitionTask, type TransitionResult } from "../workflow/state.ts";

// ---------------------------------------------------------------------------
// Changed paths: the input this module reasons about
// ---------------------------------------------------------------------------

/**
 * What moved between the revision evidence was captured at and the current
 * one. `kind: "paths"` is the ordinary case (a diff was computable);
 * `kind: "unknown"` is the conservative fallback for anything the caller
 * could not determine (git failure, dirty tree with unreadable status,
 * rename/rewrite detection that gave up) — it invalidates everything rather
 * than guessing.
 */
export type WorktreeChangeSet =
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };

/** Normalise a repository-relative path the way `ownership.paths` are compared. */
export function normaliseChangedPath(path: string): string {
  let out = path.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Is `path` inside one of the declared ownership paths? Prefix match on path
 * segments (mirrors `task-gate.ts`'s `pathIsOwned`, not re-derived — kept as
 * a small local copy because `task-gate.ts` does not export it as reusable
 * outside the gate and this module must not import gate internals).
 */
export function pathIsRelevant(path: string, ownership: Pick<Ownership, "paths">): boolean {
  if (ownership.paths.length === 0) return true;
  const target = normaliseChangedPath(path);
  return ownership.paths.some((raw) => {
    const base = normaliseChangedPath(raw);
    if (base === "" || base === ".") return true;
    return target === base || target.startsWith(`${base}/`);
  });
}

// ---------------------------------------------------------------------------
// Relevance: does a change invalidate this particular check?
// ---------------------------------------------------------------------------

/**
 * Is `changes` relevant to `check`, for `task`?
 *
 * Conservative by construction:
 *  - `unknown` change sets are always relevant — a git failure must never be
 *    read as "nothing changed".
 *  - Project-wide checks (`project:` prefix, `checks.ts`) declare no
 *    ownership of their own; they are relevant to *every* change, because a
 *    project check (`npm test`, `npm run lint`) exercises the whole tree.
 *  - A task check is relevant exactly when at least one changed path falls
 *    inside the task's declared `ownership.paths` — the only per-task
 *    "declared inputs" this record shape carries. An empty `paths` list on
 *    ownership means "owns everything" (see `pathIsRelevant`), so a task with
 *    unscoped ownership is invalidated by any change, which is the safe
 *    reading of "unknown -> invalidate".
 */
export function isRelevantChange(
  check: Pick<CheckDefinition, "id">,
  ownership: Pick<Ownership, "paths">,
  changes: WorktreeChangeSet,
): boolean {
  if (changes.kind === "unknown") return true;
  if (isProjectCheck(check)) return changes.paths.length > 0;
  return changes.paths.some((path) => pathIsRelevant(path, ownership));
}

// ---------------------------------------------------------------------------
// Which fresh evidence a relevant change knocks out
// ---------------------------------------------------------------------------

/** One check's evidence, relevant-invalidation outcome. */
export interface CheckInvalidation {
  readonly checkId: string;
  readonly relevant: boolean;
  /** Fresh evidence rows (at the *old* revision) this change excludes, if relevant. */
  readonly excludedEvidenceIds: readonly string[];
}

/**
 * For every registered check, decide whether `changes` invalidates it and
 * which fresh evidence rows (evaluated at `oldRevision`) that excludes.
 *
 * This does not touch freshness at the *new* revision — `flaky.ts`'s
 * `isFreshEvidence`/`latestFreshEvidence` already make evidence at a
 * different `Evidence.revision` non-fresh automatically once `SHA(T)` moves.
 * What this adds is the *reason* ("relevant change", not just "revision
 * moved") and the specific check ids/evidence ids to report on the
 * `task-stale-evidence` audit entry (scenario 2 A4: "detail references old
 * SHA1, new SHA2, and evidence ids E1, E2").
 */
export function checkInvalidations(
  task: Pick<Task, "checks" | "ownership" | "revision">,
  evidence: readonly FreshnessInput[],
  oldRevision: GitSha,
  changes: WorktreeChangeSet,
): readonly CheckInvalidation[] {
  return task.checks.map((check) => {
    const relevant = isRelevantChange(check, task.ownership, changes);
    if (!relevant) return { checkId: check.id, relevant: false, excludedEvidenceIds: [] };
    const fresh = evidence.filter(
      (e) => e.checkId === check.id && isFreshEvidence(e, task.revision, oldRevision),
    );
    return { checkId: check.id, relevant: true, excludedEvidenceIds: fresh.map((e) => e.id) };
  });
}

// ---------------------------------------------------------------------------
// Task-level decision: does this change send the task back to `verifying`?
// ---------------------------------------------------------------------------

/** Whether a change set warrants firing `task-stale-evidence`, and why. */
export interface StalenessAssessment {
  readonly stale: boolean;
  /** Checks the change invalidated (empty when `stale` is `false`). */
  readonly invalidated: readonly CheckInvalidation[];
  readonly excludedEvidenceIds: readonly string[];
}

/**
 * Assess whether `changes` (moving the worktree from `oldRevision` towards a
 * new one) invalidates any of `task`'s checks.
 *
 * Only `review`/`verifying` are the states `task-stale-evidence` fires from
 * (`transitions.ts`); a task not in one of those is simply not re-evaluated
 * here — nothing to invalidate yet, since it has no completion candidate.
 */
export function assessStaleness(
  task: Pick<Task, "checks" | "ownership" | "revision" | "status">,
  evidence: readonly FreshnessInput[],
  oldRevision: GitSha,
  changes: WorktreeChangeSet,
): StalenessAssessment {
  if (task.status !== "review" && task.status !== "verifying") {
    return { stale: false, invalidated: [], excludedEvidenceIds: [] };
  }
  const invalidated = checkInvalidations(task, evidence, oldRevision, changes).filter((c) => c.relevant);
  const excludedEvidenceIds = invalidated.flatMap((c) => c.excludedEvidenceIds);
  return { stale: invalidated.length > 0, invalidated, excludedEvidenceIds };
}

// ---------------------------------------------------------------------------
// Runtime glue: fire `task-stale-evidence` when relevant
// ---------------------------------------------------------------------------

export interface InvalidateStaleEvidenceOptions {
  readonly store: Store;
  readonly taskId: TaskId;
  readonly oldRevision: GitSha;
  readonly newRevision: GitSha;
  readonly changes: WorktreeChangeSet;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

/** What `invalidateStaleEvidence` did. `null` transition means nothing was stale. */
export interface InvalidateStaleEvidenceResult {
  readonly assessment: StalenessAssessment;
  readonly transition: TransitionResult<Task> | null;
}

/**
 * The single entry point a watcher/scheduler calls when the worktree has
 * moved while a task sits in `verifying` or `review`.
 *
 * Consistent with #41's `INVALIDATION_STATE_EFFECTS.task.affectedNonterminal
 * = "task-invalidate"` for *approval* invalidation: this is the sibling for
 * *evidence* invalidation, using the dedicated `task-stale-evidence` edge
 * (`verifying|review -> verifying`, trigger `git_revision_changed`) rather
 * than `task-invalidate`, because a relevant edit is not an approval event
 * and must not block the task — it returns it to verification instead
 * (scenario 2 A4: `Task[T].status == 'verifying'`, not `blocked`).
 *
 * Evidence rows are never deleted or mutated here: `assessStaleness` only
 * *names* the excluded ids for the audit entry—`invalidation.ts`'s rule
 * ("retained, not deleted") applies identically to evidence excluded by a
 * relevant change as to evidence excluded by an approval-triggering revision
 * bump. The rows simply stop being fresh once `SHA(T)` no longer matches
 * them (`flaky.ts`'s `isFreshEvidence`), and re-running the checks produces
 * new rows whose `supersedesId` links back to them.
 */
export function invalidateStaleEvidence(
  options: InvalidateStaleEvidenceOptions,
): InvalidateStaleEvidenceResult {
  const { store } = options;
  const task = store.tasks.require(options.taskId);
  const evidence = store.evidence.findBy("taskId", task.id);
  const assessment = assessStaleness(task, evidence, options.oldRevision, options.changes);
  if (!assessment.stale) return { assessment, transition: null };

  const checkIds = assessment.invalidated.map((c) => c.checkId).join(",");

  const transition = transitionTask({
    store,
    taskId: task.id,
    to: "verifying",
    trigger: "git_revision_changed",
    actor: options.actor,
    now: options.now,
    newId: options.newId,
    gitRevision: options.newRevision,
    evidenceRefs: [
      `invalidation:revision_changed:${options.oldRevision}->${options.newRevision}:checks=${checkIds}`,
      ...assessment.excludedEvidenceIds.map((id) => `evidence:${id}`),
    ],
    guards: { revision_changed: () => true },
  });
  return { assessment, transition };
}
