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

// ---------------------------------------------------------------------------
// Applying, only with an explicit approval
// ---------------------------------------------------------------------------

/** Why a proposal was refused. */
export type ScopeChangeRefusal =
  | "no_approval"
  | "approval_invalid"
  | "approval_wrong_action"
  | "approval_stale_plan_revision"
  | "approval_not_from_user"
  | "noop";

export class ScopeChangeRejected extends Error {
  override readonly name = "ScopeChangeRejected";
  readonly refusal: ScopeChangeRefusal;
  constructor(refusal: ScopeChangeRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

/**
 * Is this approval usable for this proposal, right now?
 *
 * Four independent conditions, each of which has to hold:
 *
 *  1. It is not invalidated, expired, or bound to a different plan/task
 *     revision (`approvalInvalidReason`, the shared record helper).
 *  2. Its `planRevision` is the revision the proposal was computed against —
 *     so a plan that moved after the user approved needs a fresh approval.
 *  3. Its `permittedAction` names *this* digest, so an approval for one
 *     change cannot be spent on another.
 *  4. It was granted by a **user**, not by policy: `scope_change` and
 *     `replan` are `NO_AUTO_CLASSES`, so a policy grant is not sufficient in
 *     any mode.
 */
export function approvalRefusalFor(
  approval: Approval | undefined,
  proposal: ScopeChangeProposal,
  now: IsoTimestamp,
): ScopeChangeRefusal | null {
  if (approval === undefined) return "no_approval";
  const invalid = approvalInvalidReason(approval, {
    task: null,
    planRevision: proposal.fromPlanRevision,
    now,
  });
  if (invalid !== null) return "approval_invalid";
  if (approval.planRevision !== proposal.fromPlanRevision) return "approval_stale_plan_revision";
  if (approval.permittedAction !== permittedActionFor(proposal)) return "approval_wrong_action";
  if (approval.actor.kind !== "user") return "approval_not_from_user";
  return null;
}

export interface ApplyScopeChangeOptions {
  readonly store: Store;
  readonly proposal: ScopeChangeProposal;
  /** Id of the `Approval` row the user granted for this exact proposal. */
  readonly approvalId: string;
  readonly actor: TransitionActor;
  readonly now: () => IsoTimestamp;
  readonly newId: (kind: "phase" | "task") => string;
  /** Planner-local ids blocked by the output budget (#124), passed through. */
  readonly outputBudgetBlocked?: readonly string[];
}

/**
 * Persist an approved proposal, as plan revision N+1.
 *
 * Refuses — **without writing** — when the approval is missing, invalid,
 * for a different change, stale, or not from the user. On acceptance the
 * write is `revisePlan`, which bumps the plan revision, supersedes dropped
 * tasks and invalidates every approval pinned to the old revision in one
 * transaction; the scope approval itself is consumed in that same
 * transaction, so it cannot authorise a second change.
 */
export function applyScopeChange(options: ApplyScopeChangeOptions): PersistPlanResult {
  const { store, proposal } = options;
  if (proposalIsNoop(proposal)) {
    throw new ScopeChangeRejected("noop", "proposal changes nothing; no revision is created");
  }
  return store.write(() => {
    const workflow = store.workflows.require(proposal.workflowId);
    if (workflow.planRevision !== proposal.fromPlanRevision) {
      throw new ScopeChangeRejected(
        "approval_stale_plan_revision",
        `proposal was computed against plan revision ${proposal.fromPlanRevision}, ` +
          `workflow is now at ${workflow.planRevision}; re-propose and re-approve`,
      );
    }
    const approval = store.approvals.get(options.approvalId);
    const refusal = approvalRefusalFor(approval, proposal, options.now());
    if (refusal !== null) {
      throw new ScopeChangeRejected(
        refusal,
        `${proposal.changeKind} refused (${refusal}): ${describeProposal(proposal)}`,
      );
    }

    const result = revisePlan({
      store,
      workflowId: proposal.workflowId,
      plan: proposal.candidate,
      now: options.now,
      newId: options.newId,
      ...(options.outputBudgetBlocked === undefined ? {} : { outputBudgetBlocked: options.outputBudgetBlocked }),
    });

    // Single-use: the approval authorised this change and is now spent
    // (`consumed` in APPROVAL_INVALIDATION_EVENTS). `revisePlan` may already
    // have invalidated it as `plan_revision_changed`, which is equally final.
    const after = store.approvals.get(options.approvalId);
    if (after?.invalidation === null) {
      store.approvals.invalidate(options.approvalId, {
        reason: "consumed",
        at: options.now(),
        detail: permittedActionFor(proposal),
      });
    }
    return result;
  });
}

/** Human-readable summary of a proposal, for the approval prompt and `/korwf`. */
export function describeProposal(proposal: ScopeChangeProposal): string {
  const lines = [
    `${proposal.changeKind} for plan revision ${proposal.fromPlanRevision} → ${proposal.toPlanRevision} ` +
      `(approval class "${proposal.approvalClass}", never automatic)`,
  ];
  for (const entry of proposal.tasks) {
    if (entry.kind === "unchanged") continue;
    const paths = [
      ...entry.addedPaths.map((path) => `+${path}`),
      ...entry.removedPaths.map((path) => `-${path}`),
    ];
    lines.push(`  ${entry.kind} task ${entry.id}: ${entry.goal}${paths.length > 0 ? ` [${paths.join(" ")}]` : ""}`);
  }
  for (const entry of proposal.phases) {
    if (entry.kind === "unchanged") continue;
    lines.push(`  ${entry.kind} phase ${entry.id}: ${entry.goal}`);
  }
  if (proposal.expandsScope) {
    lines.push(`  EXPANDS SCOPE: ${proposal.expansionReasons.join("; ")}`);
  } else {
    lines.push("  within existing scope (replan)");
  }
  lines.push(`  digest ${proposal.digest}`);
  return lines.join("\n");
}
