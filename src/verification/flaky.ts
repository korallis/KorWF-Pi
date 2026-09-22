/**
 * Flaky, missing, and unavailable check states, represented explicitly
 * (issue #51; PLAN §3.F: "Flaky, missing, or unavailable checks are
 * represented explicitly, never as success").
 *
 * `checks.ts` (#45) already distinguishes pass/fail/timeout/unavailable for
 * one run. This module adds the two states that are properties of *several*
 * runs or of the store rather than of a single run:
 *
 *  - `flaky`: the same check, at the same revision, passed on one run and
 *    failed (or timed out) on another. Both runs stay on disk as Evidence;
 *    this module never deletes or overwrites either.
 *  - `missing`: no fresh evidence exists for a registered check, or — a
 *    distinct condition — an acceptance criterion has no check registered
 *    against it at all (`uncoveredCriteria`), which is reported per
 *    criterion id and raised as a `missing_check` blocker.
 *
 * None of these states satisfies `docs/gates.md` §3 C1: only `pass` does,
 * and this module does not add a code path that could make it otherwise —
 * `DEFAULT_RERUN_POLICY.allowFlakyToPass` exists for symmetry with the
 * option PLAN leaves configurable but defaults to `false`.
 */
import type { AcceptanceCriterion, CheckDefinition, Evidence, GitSha, Revision } from "../storage/records.ts";
import type { CheckRunStatus, EvidenceDraft } from "./evidence.ts";
import { runCheck, type CheckRunResult, type RunCheckOptions } from "./checks.ts";
import { raiseTaskBlocker, type BlockerContext } from "../workflow/blockers.ts";
import type { RaiseBlockerResult } from "../workflow/blockers.ts";
import type { Task, TaskId } from "../storage/records.ts";

/** Blocker kind for an acceptance criterion with no covering check. */
export const MISSING_CHECK_BLOCKER = "missing_check" as const;

/** Configurable rerun policy for flakiness detection (PLAN §3.F Scope). */
export interface RerunPolicy {
  /** Rerun once (or more) when the first run fails, to see if it recovers. */
  readonly rerunOnFail: boolean;
  /** Maximum additional runs after the first. */
  readonly maxReruns: number;
  /**
   * Whether a `flaky` result may satisfy the gate for this risk class.
   * PLAN §3.F: "flaky ≠ pass for the gate unless policy explicitly allows
   * for that risk class (default: not allowed)".
   */
  readonly allowFlakyToPass: boolean;
}

/** The shipped default: rerun once on failure; flaky never satisfies the gate. */
export const DEFAULT_RERUN_POLICY: RerunPolicy = {
  rerunOnFail: true,
  maxReruns: 1,
  allowFlakyToPass: false,
};

// ---------------------------------------------------------------------------
// Rerun and reconciliation: turning several runs into one state
// ---------------------------------------------------------------------------

/** Outcome of running one check under a rerun policy. */
export interface FlakyAwareResult {
  readonly checkId: string;
  /** Every attempt made, in order. Always at least one. */
  readonly runs: readonly CheckRunResult[];
  /**
   * The reconciled state: `flaky` only when runs at the *same* revision
   * disagree on pass vs. not-pass. Never `pass` unless every run passed.
   */
  readonly status: CheckRunStatus;
  readonly revision: GitSha | null;
  /**
   * Every non-null evidence draft produced, one per executed run, plus — in
   * the flaky case — a reconciled `{kind:"flaky"}` draft **appended last**.
   * The caller inserts all of them in order, so a reader sees the
   * disagreeing runs linked by identical `(checkId, revision, taskRevision)`
   * *and* the gate's latest-row rule lands on `flaky`.
   */
  readonly evidence: readonly EvidenceDraft[];
}

/**
 * Run a check, and if it fails, rerun it (per policy) to see whether the
 * failure reproduces at the same revision.
 *
 * A rerun only happens when the first run is a genuine `fail` or `timeout` —
 * rerunning an `unavailable` result (missing tool, weak check, no revision)
 * would not distinguish anything: the tool is still absent on the second
 * try. A passing first run is never rerun by this policy (rerunning to
 * *find* flakiness on a pass is a distinct, more expensive policy this
 * function does not implement).
 */
export async function runCheckWithRerunPolicy(
  check: CheckDefinition,
  options: RunCheckOptions,
  policy: RerunPolicy = DEFAULT_RERUN_POLICY,
): Promise<FlakyAwareResult> {
  const first = await runCheck(check, options);
  const runs: CheckRunResult[] = [first];

  const rerunnable = (status: CheckRunStatus): boolean => status === "fail" || status === "timeout";

  if (policy.rerunOnFail && rerunnable(first.status)) {
    for (let i = 0; i < policy.maxReruns; i += 1) {
      const rerun = await runCheck(check, options);
      runs.push(rerun);
      // Stop early once a pass has been seen at the same revision: that is
      // already enough to call it flaky, and running a fixed rerun budget
      // beyond that only pins the revision cost higher for no new signal.
      if (rerun.status === "pass" && rerun.revision === first.revision) break;
    }
  }

  return reconcileRuns(check.id, runs);
}

/**
 * Reconcile several run results for the same check into one state.
 *
 * Only runs sharing the *first* run's revision are considered together —
 * `docs/gates.md` §2 defines freshness per revision, so a run at a different
 * revision (the worktree moved between attempts) is not evidence about the
 * same question and is excluded from the flaky determination, though its
 * evidence draft is still returned for the caller to store.
 */
export function reconcileRuns(checkId: string, runs: readonly CheckRunResult[]): FlakyAwareResult {
  if (runs.length === 0) {
    throw new Error(`reconcileRuns("${checkId}") called with no runs`);
  }
  const first = runs[0] as CheckRunResult;
  const evidence = runs.flatMap((r) => (r.evidence === null ? [] : [r.evidence]));

  const sameRevision = runs.filter((r) => r.revision === first.revision && r.revision !== null);
  const statuses = new Set(sameRevision.map((r) => r.status));
  const sawPass = statuses.has("pass");
  const sawNonPass = [...statuses].some((s) => s !== "pass");

  if (sameRevision.length > 1 && sawPass && sawNonPass) {
    return {
      checkId,
      runs,
      status: "flaky",
      revision: first.revision,
      // The reconciled row is appended **last**, so the gate's "latest result
      // wins" rule (docs/gates.md §2) lands on `flaky` rather than on
      // whichever individual run happened to be newest. Without it a
      // fail-then-pass sequence stores two honest rows that together say
      // "flaky" and are read as "pass" — issue #55 found exactly that.
      evidence: [...evidence, ...flakyDraft(sameRevision)],
    };
  }

  // No disagreement: the reconciled state is whatever the *last* run at the
  // shared revision produced — matching "latest result wins" (docs/gates.md
  // §2), since a rerun that confirms the original result should not be
  // shadowed by a stale first attempt.
  const last = sameRevision.length > 0 ? (sameRevision[sameRevision.length - 1] as CheckRunResult) : first;
  return {
    checkId,
    runs,
    status: last.status,
    revision: last.revision,
    evidence,
  };
}

/**
 * The reconciled `flaky` evidence draft for a set of disagreeing runs at one
 * revision, or nothing when no run produced a draft to base it on.
 *
 * It is derived from the last run's draft so the command identity, revision
 * and subject are the ones actually observed; only the exit status and the
 * caveat are this function's own. `supersedesId` stays `null`: the individual
 * runs remain readable facts, and the reconciliation is an additional one.
 */
function flakyDraft(sameRevision: readonly CheckRunResult[]): readonly EvidenceDraft[] {
  const drafts = sameRevision.flatMap((r) => (r.evidence === null ? [] : [r.evidence]));
  const base = drafts[drafts.length - 1];
  if (base === undefined) return [];
  const codes = sameRevision.map((r) =>
    r.exitStatus.kind === "exited" ? r.exitStatus.code : NON_EXIT_RUN_CODE,
  );
  return [
    {
      ...base,
      exitStatus: { kind: "flaky", runs: codes },
      caveats: [
        ...base.caveats,
        `runs at revision ${base.revision} disagreed (${sameRevision
          .map((r) => r.status)
          .join(", ")}); flaky never satisfies the gate (PLAN §3.F)`,
      ],
      supersedesId: null,
    },
  ];
}

/**
 * Code recorded in `exitStatus.runs` for a run that produced no exit code at
 * all (a timeout, a signal, an unavailable tool). `-1` is not a possible
 * process exit status, so it cannot be confused with one.
 */
const NON_EXIT_RUN_CODE = -1;

// ---------------------------------------------------------------------------
// Reading state from the store: fresh evidence, flaky pairs, missing checks
// ---------------------------------------------------------------------------

/** The subset of `Evidence` fields the freshness/state computation needs. */
export type FreshnessInput = Pick<
  Evidence,
  "id" | "checkId" | "taskRevision" | "revision" | "exitStatus" | "createdAt" | "supersedesId"
>;

/**
 * Is this evidence row fresh for the given task revision and current SHA?
 * `docs/gates.md` §2: `e.taskRevision = T.rev ∧ e.revision = SHA(T) ∧
 * ¬superseded(e)`. Supersession is checked by the caller passing only
 * non-superseded rows (the store enumerates `supersedesId` chains); this
 * function checks the two revision equalities, which is the part that must
 * not be gotten wrong by inlining it at each call site.
 */
export function isFreshEvidence(
  evidence: FreshnessInput,
  taskRevision: Revision,
  currentSha: GitSha,
  supersededIds: ReadonlySet<string> = new Set(),
): boolean {
  return (
    evidence.taskRevision === taskRevision && evidence.revision === currentSha && !supersededIds.has(evidence.id)
  );
}

/**
 * The latest fresh evidence row for one check, per docs/gates.md §2's tie
 * break: greatest `createdAt`, then greatest `id`.
 */
export function latestFreshEvidence<E extends FreshnessInput>(
  evidenceForCheck: readonly E[],
  taskRevision: Revision,
  currentSha: GitSha,
  supersededIds: ReadonlySet<string> = new Set(),
): E | null {
  const fresh = evidenceForCheck.filter((e) => isFreshEvidence(e, taskRevision, currentSha, supersededIds));
  if (fresh.length === 0) return null;
  return fresh.reduce((best, e) => {
    if (e.createdAt > best.createdAt) return e;
    if (e.createdAt < best.createdAt) return best;
    return e.id > best.id ? e : best;
  });
}

/**
 * Map an `EvidenceExitStatus` to the `docs/gates.md` §4 state table. Mirrors
 * `runStatusOf` but takes the exit status stored on a row rather than a
 * freshly-classified outcome, since a reader has only the row.
 */
export function stateFromExitStatus(exitStatus: Evidence["exitStatus"], expectedExitCode: number): CheckRunStatus {
  switch (exitStatus.kind) {
    case "exited":
      return exitStatus.code === expectedExitCode ? "pass" : "fail";
    case "timed_out":
      return "timeout";
    case "unavailable":
      return "unavailable";
    case "flaky":
      return "flaky";
    case "signalled":
      return "fail";
    case "missing":
      return "missing";
  }
}

/**
 * State of one registered check for a task at its current revision, reading
 * only fresh evidence. No fresh row at all → `missing`: absence is a state,
 * never an inferred pass (PLAN §3.F).
 */
export function checkState<E extends FreshnessInput>(
  check: Pick<CheckDefinition, "id" | "expectedExitCode">,
  evidenceForCheck: readonly E[],
  taskRevision: Revision,
  currentSha: GitSha,
  supersededIds: ReadonlySet<string> = new Set(),
): CheckRunStatus {
  const latest = latestFreshEvidence(evidenceForCheck, taskRevision, currentSha, supersededIds);
  if (latest === null) return "missing";
  return stateFromExitStatus(latest.exitStatus, check.expectedExitCode);
}

/**
 * Acceptance criteria with no check covering them.
 *
 * Distinct from `missing` (a registered check with no fresh evidence): this
 * is a criterion that was never given a check at all, which `docs/gates.md`
 * §3 C1 treats as its own conjunct (`∀ a ∈ T.ac: ∃ c ∈ T.checks: a.id ∈
 * c.coversCriteria`) rather than folding into any check's state.
 */
export function uncoveredCriteria(
  acceptanceCriteria: readonly AcceptanceCriterion[],
  checks: readonly Pick<CheckDefinition, "coversCriteria">[],
): readonly string[] {
  const covered = new Set(checks.flatMap((c) => c.coversCriteria));
  return acceptanceCriteria.filter((ac) => !covered.has(ac.id)).map((ac) => ac.id);
}

/** Detail text for a `missing_check` blocker naming the uncovered criterion. */
export function missingCheckBlockerDetail(criterionId: string): string {
  return `acceptance criterion "${criterionId}" has no registered check covering it`;
}

/** One check's reported state, for a board row. */
export interface TaskCheckStateRow {
  readonly checkId: string;
  readonly status: CheckRunStatus;
}

/** Everything a board needs to render distinct check markers for one task. */
export interface TaskCheckSummary {
  readonly checks: readonly TaskCheckStateRow[];
  /** Acceptance-criterion ids with no covering check at all. */
  readonly uncoveredCriteria: readonly string[];
}

/**
 * Compute the per-check state summary for a task, at its current revision.
 *
 * Pure: takes the task's own checks and the evidence already read from the
 * store, so it composes with `src/workflow/boards.ts`'s read-only guarantee
 * without this module ever touching a `Store` for reads.
 */
export function taskCheckSummary<E extends FreshnessInput>(
  task: Pick<Task, "checks" | "acceptanceCriteria" | "revision">,
  evidence: readonly E[],
  currentSha: GitSha | null,
  supersededIds: ReadonlySet<string> = new Set(),
): TaskCheckSummary {
  const byCheck = new Map<string, E[]>();
  for (const e of evidence) {
    const list = byCheck.get(e.checkId ?? "") ?? [];
    list.push(e);
    byCheck.set(e.checkId ?? "", list);
  }
  const checks: TaskCheckStateRow[] = task.checks.map((check) => ({
    checkId: check.id,
    status:
      currentSha === null
        ? "missing"
        : checkState(check, byCheck.get(check.id) ?? [], task.revision, currentSha, supersededIds),
  }));
  return {
    checks,
    uncoveredCriteria: uncoveredCriteria(task.acceptanceCriteria, task.checks),
  };
}

/**
 * Raise a `missing_check` blocker on `task` for every uncovered acceptance
 * criterion, one blocker per criterion so `/korwf why` and the board can
 * name each one (Scope: "reported by criterion id").
 *
 * Idempotent by construction only insofar as `raiseTaskBlocker` already is:
 * calling this repeatedly on an already-blocked task accumulates reasons
 * rather than duplicating a transition (`docs/state-machine.md` §5).
 */
export function raiseMissingCheckBlockers(
  context: BlockerContext & { readonly task: Pick<Task, "id" | "acceptanceCriteria" | "checks">; readonly taskId?: TaskId },
): readonly RaiseBlockerResult<Task>[] {
  const missing = uncoveredCriteria(context.task.acceptanceCriteria, context.task.checks);
  return missing.map((criterionId) =>
    raiseTaskBlocker({
      store: context.store,
      actor: context.actor,
      now: context.now,
      newId: context.newId,
      taskId: (context.taskId ?? context.task.id) as TaskId,
      kind: MISSING_CHECK_BLOCKER,
      detail: missingCheckBlockerDetail(criterionId),
    }),
  );
}
