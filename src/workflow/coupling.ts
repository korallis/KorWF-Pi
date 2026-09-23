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
