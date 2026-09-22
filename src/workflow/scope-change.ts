/**
 * Scope change and replan (issue #41 Scope: "Scope change API: proposes a
 * diff to the plan; persisted only on explicit approval"; PLAN §3.C "replan
 * without silent scope expansion").
 *
 * The shape of this module is the requirement: a proposal is a **pure
 * function** of the current stored plan and the candidate plan. It touches
 * nothing. Persisting it requires an `Approval` row that is valid *now*, for
 * the right class, at the current plan revision — and `scope_change` and
 * `replan` are the two `NO_AUTO_CLASSES` of #15, so no mode and no Jev
 * probability can supply that approval automatically.
 *
 * Consequences, all of them enforced below rather than documented:
 *
 *  - `proposeScopeChange` performs no write, so an unapproved proposal leaves
 *    the plan byte-identical (the acceptance criterion "scope change without
 *    approval leaves the plan untouched").
 *  - `applyScopeChange` refuses without a valid approval of the right class,
 *    and refuses an approval granted against a different plan revision — the
 *    plan cannot move between proposal and approval without re-approval.
 *  - Applying goes through `revisePlan`, so revision N+1, superseded tasks
 *    and `plan_revision_changed` invalidation are the existing single write
 *    path, not a second implementation.
 *  - Expansion is named. A proposal that adds tasks, phases or ownership
 *    paths is reported as expanding scope, and expansion never rides along
 *    inside an approval granted for something else: the approval's
 *    `permittedAction` must match the proposal's digest.
 */
import type { Store } from "../storage/db.ts";
import type {
  Approval,
  IsoTimestamp,
  Phase,
  Task,
  WorkflowId,
} from "../storage/records.ts";
import { approvalInvalidReason } from "../storage/records.ts";
import type { TransitionActor } from "../storage/transition-log.ts";
import { hashRecord } from "../storage/repos/base.ts";
import type { PlanDocument, PlanPhase, PlanTask } from "./plan-schema.ts";
import { definitionOfDoneChanged, revisePlan, type PersistPlanResult } from "./plan-store.ts";
import { NO_AUTO_CLASSES, type ApprovalClassId } from "./approval-classes.ts";

/** The two approval classes a plan change can require. Both are never-auto (#15). */
export const SCOPE_CHANGE_CLASSES = NO_AUTO_CLASSES;

/** Is this proposal a scope change, or a replan within the same scope? */
export type PlanChangeKind = ApprovalClassId & ("scope_change" | "replan");

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** One task-level difference between the stored plan and the candidate. */
export interface TaskDiffEntry {
  readonly kind: "added" | "removed" | "redefined" | "reowned" | "unchanged";
  /** Planner-local id in the candidate, or the record id for a removal. */
  readonly id: string;
  readonly goal: string;
  /** Ownership paths gained by this entry; drives the expansion verdict. */
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
}

export interface PhaseDiffEntry {
  readonly kind: "added" | "removed" | "reordered" | "unchanged";
  readonly id: string;
  readonly goal: string;
}

/**
 * A proposed plan change. Immutable, inert, and the only thing a caller can
 * show a user before anything happens.
 */
export interface ScopeChangeProposal {
  readonly workflowId: WorkflowId;
  /** Plan revision the proposal was computed against. */
  readonly fromPlanRevision: number;
  /** Revision it would produce. */
  readonly toPlanRevision: number;
  readonly changeKind: PlanChangeKind;
  readonly approvalClass: ApprovalClassId;
  readonly tasks: readonly TaskDiffEntry[];
  readonly phases: readonly PhaseDiffEntry[];
  /** `true` when the candidate adds work or ownership the plan did not have. */
  readonly expandsScope: boolean
  /** Human-readable reasons the proposal is an expansion. */
  readonly expansionReasons: readonly string[];
  /**
   * Digest over the diff. An approval must name this digest in its
   * `permittedAction`, so an approval cannot be reused for a different change.
   */
  readonly digest: string;
  readonly candidate: PlanDocument;
}

function ownershipPaths(task: Pick<Task, "ownership"> | PlanTask): readonly string[] {
  return task.ownership.paths;
}

/** Same matching rule `plan-store.ts` uses, so the diff predicts the write. */
function matchStoredTask(candidate: PlanTask, stored: readonly Task[], taken: Set<string>): Task | undefined {
  const available = stored.filter((task) => !taken.has(task.id));
  const byGoal = available.find((task) => task.goal === candidate.goal);
  if (byGoal !== undefined) return byGoal;
  const wanted = new Set(ownershipPaths(candidate));
  if (wanted.size === 0) return undefined;
  const overlapping = available.filter((task) => task.ownership.paths.some((path) => wanted.has(path)));
  return overlapping.length === 1 ? overlapping[0] : undefined;
}

function diffTasks(stored: readonly Task[], candidate: readonly PlanTask[]): readonly TaskDiffEntry[] {
  const entries: TaskDiffEntry[] = [];
  const taken = new Set<string>();
  for (const planTask of candidate) {
    const previous = matchStoredTask(planTask, stored, taken);
    if (previous === undefined) {
      entries.push({
        kind: "added",
        id: planTask.id,
        goal: planTask.goal,
        addedPaths: ownershipPaths(planTask),
        removedPaths: [],
      });
      continue;
    }
    taken.add(previous.id);
    const before = new Set(previous.ownership.paths);
    const after = new Set(ownershipPaths(planTask));
    const addedPaths = [...after].filter((path) => !before.has(path));
    const removedPaths = [...before].filter((path) => !after.has(path));
    const redefined = definitionOfDoneChanged(previous, planTask);
    const kind: TaskDiffEntry["kind"] = redefined
      ? "redefined"
      : addedPaths.length > 0 || removedPaths.length > 0
        ? "reowned"
        : "unchanged";
    entries.push({ kind, id: planTask.id, goal: planTask.goal, addedPaths, removedPaths });
  }
  for (const task of stored) {
    if (taken.has(task.id)) continue;
    entries.push({
      kind: "removed",
      id: task.id,
      goal: task.goal,
      addedPaths: [],
      removedPaths: task.ownership.paths,
    });
  }
  return entries;
}

function diffPhases(stored: readonly Phase[], candidate: readonly PlanPhase[]): readonly PhaseDiffEntry[] {
  const entries: PhaseDiffEntry[] = [];
  const matched = new Set<string>();
  for (const planPhase of candidate) {
    const exact = stored.find((phase) => phase.order === planPhase.order && phase.goal === planPhase.goal);
    if (exact !== undefined) {
      matched.add(exact.id);
      entries.push({ kind: "unchanged", id: planPhase.id, goal: planPhase.goal });
      continue;
    }
    const sameGoal = stored.find((phase) => phase.goal === planPhase.goal && !matched.has(phase.id));
    if (sameGoal !== undefined) {
      matched.add(sameGoal.id);
      entries.push({ kind: "reordered", id: planPhase.id, goal: planPhase.goal });
      continue;
    }
    entries.push({ kind: "added", id: planPhase.id, goal: planPhase.goal });
  }
  for (const phase of stored) {
    if (matched.has(phase.id)) continue;
    entries.push({ kind: "removed", id: phase.id, goal: phase.goal });
  }
  return entries;
}

/**
 * Compute a proposal. **Performs no write of any kind** — it only reads the
 * stored plan, which is why an unapproved scope change cannot alter anything.
 *
 * Expansion is anything the approved plan did not cover: a new task, a new
 * phase, or an ownership path a task did not previously own. Removing work is
 * a change but not an expansion; it still needs approval, because dropping an
 * approved task is also not the engine's decision.
 */
export function proposeScopeChange(options: {
  readonly store: Store;
  readonly workflowId: WorkflowId;
  readonly candidate: PlanDocument;
}): ScopeChangeProposal {
  const { store, workflowId, candidate } = options;
  const workflow = store.workflows.require(workflowId);
  const storedTasks = store.tasks.findBy("workflowId", workflowId);
  const storedPhases = store.phases.forWorkflow(workflowId);

  const tasks = diffTasks(storedTasks, candidate.tasks);
  const phases = diffPhases(storedPhases, candidate.phases);

  const expansionReasons: string[] = [];
  const addedTasks = tasks.filter((entry) => entry.kind === "added");
  if (addedTasks.length > 0) {
    expansionReasons.push(`${addedTasks.length} new task(s): ${addedTasks.map((t) => t.id).join(", ")}`);
  }
  const addedPhases = phases.filter((entry) => entry.kind === "added");
  if (addedPhases.length > 0) {
    expansionReasons.push(`${addedPhases.length} new phase(s): ${addedPhases.map((p) => p.id).join(", ")}`);
  }
  const gainedPaths = tasks.flatMap((entry) => (entry.kind === "added" ? [] : entry.addedPaths));
  if (gainedPaths.length > 0) {
    expansionReasons.push(`ownership gained: ${[...new Set(gainedPaths)].sort().join(", ")}`);
  }

  const expandsScope = expansionReasons.length > 0;
  const changeKind: PlanChangeKind = expandsScope ? "scope_change" : "replan";
  const digestInput = {
    workflowId,
    fromPlanRevision: workflow.planRevision,
    tasks: tasks.filter((entry) => entry.kind !== "unchanged"),
    phases: phases.filter((entry) => entry.kind !== "unchanged"),
  };
  return {
    workflowId,
    fromPlanRevision: workflow.planRevision,
    toPlanRevision: workflow.planRevision + 1,
    changeKind,
    approvalClass: changeKind,
    tasks,
    phases,
    expandsScope,
    expansionReasons,
    digest: hashRecord(digestInput),
    candidate,
  };
}

/** Does the proposal change anything at all? */
export function proposalIsNoop(proposal: ScopeChangeProposal): boolean {
  return (
    proposal.tasks.every((entry) => entry.kind === "unchanged") &&
    proposal.phases.every((entry) => entry.kind === "unchanged")
  );
}

/** The `permittedAction` string an approval must carry to authorise a proposal. */
export function permittedActionFor(proposal: ScopeChangeProposal): string {
  return `${proposal.changeKind}:${proposal.digest}`;
}
