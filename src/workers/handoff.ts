/**
 * Mid-task cap response: what happens to the work in flight (issue #64;
 * PLAN §3.D "Mid-task: hand off with an explicit handoff packet and intact
 * worktree (default), or restart the task, per task-kind policy").
 *
 * `chooseFallback` (#63) has already decided WHICH substitute model to use;
 * this module decides what happens to the *attempt* and its *worktree* when
 * that substitute takes over:
 *
 *  - `handoff` (the default): the worktree stays exactly as it is —
 *    `takeCheckpoint`/`applyRollback` (#54) already guarantee uncommitted
 *    work survives, and nothing here undoes that — a new Attempt is opened,
 *    linked to the old one via `handedOffFromAttemptId`, carrying an
 *    explicit `HandoffPacket` (`src/memory/handoff-packet.ts`) built from
 *    the old attempt's evidence and progress notes.
 *  - `restart`: the worktree is rolled back to the task's last checkpoint
 *    (going through `src/workflow/checkpoint.ts`'s approved-rollback path —
 *    a restart is a destructive act like any other) and a fresh Attempt is
 *    opened with no packet; the discard is written to the audit log.
 *
 * Which policy applies is read from `models.fallback.midTaskPolicy` (config,
 * `TaskKind` keyed, `default` always present) — never hardcoded here.
 */
import type { Store } from "../storage/db.ts";
import type { Attempt, AttemptId, IsoTimestamp } from "../storage/records.ts";
import type { MidTaskPolicy, TaskKind } from "../config/types.ts";
import type { HandoffPacket } from "../memory/handoff-packet.ts";
import { OutboundPolicy } from "../security/outbound.ts";

/** Resolve the policy for one task kind, falling back to `default`. */
export function midTaskPolicyFor(
  midTaskPolicy: { readonly default: MidTaskPolicy } & Readonly<Partial<Record<TaskKind, MidTaskPolicy>>>,
  taskKind: TaskKind,
): MidTaskPolicy {
  throw new Error("not implemented");
}

export interface HandoffDeps {
  readonly store: Store;
  readonly now: () => IsoTimestamp;
  readonly newId: () => string;
}

/** Result of applying a mid-task cap response. */
export type MidTaskOutcome =
  | { readonly kind: "handed_off"; readonly newAttempt: Attempt; readonly packet: HandoffPacket }
  | { readonly kind: "restarted"; readonly newAttempt: Attempt; readonly discardedFrom: AttemptId };

export function assertPacketIsOutbound(policy: OutboundPolicy, packet: HandoffPacket): void {
  throw new Error("not implemented");
}
