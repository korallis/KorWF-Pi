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
import { createHash } from "node:crypto";
import type { Store } from "../storage/db.ts";
import type { Attempt, AttemptId, IsoTimestamp } from "../storage/records.ts";
import type { MidTaskPolicy, TaskKind } from "../config/types.ts";
import type { HandoffPacket } from "../memory/handoff-packet.ts";
import { OutboundPolicy, type FilteredPayload } from "../security/outbound.ts";
import { canonicalJson } from "../storage/repos/base.ts";
import { recordCompletedAction } from "../workflow/reconcile.ts";
import { actionIdFor } from "../storage/action-log.ts";
import {
  restoreCheckpointTree,
  worktreeIdentity,
  CheckpointError,
  type GitEnvRunner,
  type WorktreeIdentity,
} from "../git/checkpoint.ts";
import { isMainTree } from "../workflow/checkpoint.ts";

/** Resolve the policy for one task kind, falling back to `default`. */
export function midTaskPolicyFor(
  midTaskPolicy: { readonly default: MidTaskPolicy } & Readonly<Partial<Record<TaskKind, MidTaskPolicy>>>,
  taskKind: TaskKind,
): MidTaskPolicy {
  return midTaskPolicy[taskKind] ?? midTaskPolicy.default;
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

/**
 * Run the packet through the one outbound policy (#28) before it can reach
 * a worker prompt or a log. Never throws on the packet's own content —
 * `OutboundPolicy.filter` doesn't — so a packet with a denied path or a
 * secret-shaped string is filtered, not fatal; callers that need to know
 * whether anything was removed read `.report`.
 */
export function filterHandoffPacket(policy: OutboundPolicy, packet: HandoffPacket): FilteredPayload {
  return policy.filter({ state: packet }, { purpose: "model.prompt" });
}

function bundleHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Inputs for {@link applyHandoff}. */
export interface ApplyHandoffOptions extends HandoffDeps {
  readonly workflowId: string;
  readonly oldAttempt: Attempt;
  readonly packet: HandoffPacket;
  readonly outboundPolicy: OutboundPolicy;
  readonly role: Attempt["role"];
  readonly workerId: string;
}

/**
 * Apply `handoff`: the worktree is untouched (issue #54 already guarantees
 * uncommitted work survives a settle; nothing here calls `applyRollback` or
 * touches git at all), and a new Attempt is opened linked to the old one via
 * `handedOffFromAttemptId`. The packet is run through the outbound filter
 * (AC1) before it is attached, so a leak-shaped field cannot reach the
 * substitute's prompt just because it reached this function.
 */
export function applyHandoff(options: ApplyHandoffOptions): { readonly newAttempt: Attempt; readonly packet: HandoffPacket; readonly filtered: FilteredPayload } {
  const { store, oldAttempt } = options;
  const filtered = filterHandoffPacket(options.outboundPolicy, options.packet);
  const attemptId = options.newId() as AttemptId;
  const at = options.now();
  const newAttempt: Attempt = {
    ...oldAttempt,
    id: attemptId,
    createdAt: at,
    updatedAt: at,
    workerId: options.workerId,
    role: options.role,
    requestedModel: oldAttempt.usedModel,
    usedModel: options.packet.substituteModel as Attempt["usedModel"],
    fallbackReason: oldAttempt.fallbackReason,
    inputs: {
      ...oldAttempt.inputs,
      bundleHash: bundleHash(filtered.state),
    },
    timestamps: { startedAt: at, endedAt: null, lastActivityAt: at },
    termination: null,
    outcome: null,
    artifacts: [],
    handedOffFromAttemptId: oldAttempt.id,
  };
  store.write(() => store.attempts.insert(newAttempt));
  return { newAttempt, packet: options.packet, filtered };
}

/** Inputs for {@link applyRestart}. */
export interface ApplyRestartOptions extends HandoffDeps {
  readonly workflowId: string;
  readonly oldAttempt: Attempt;
  readonly sessionId: string;
  readonly role: Attempt["role"];
  readonly workerId: string;
  readonly substituteModel: Attempt["usedModel"];
  /** Last checkpoint for the task; discard is to here. `null` = nothing to discard to. */
  readonly lastCheckpointCommit: string | null;
  /** Worktree to discard uncommitted work in. Never the user's main tree (refused if it is). */
  readonly worktreeCwd: string;
  readonly mainTree?: WorktreeIdentity | null;
  readonly runner?: GitEnvRunner;
}

/** What `applyRestart` did to the worktree. */
export type RestartDiscard =
  | { readonly kind: "discarded"; readonly changedPaths: readonly string[] }
  | { readonly kind: "skipped"; readonly reason: "no_checkpoint" | "target_is_main_tree" | "not_a_repository" }; 

/**
 * Apply `restart`: uncommitted work in flight is discarded down to the
 * task's last checkpoint and a fresh Attempt is opened with no packet. The
 * discard itself is not this function's job to perform on disk — that is
 * `src/workflow/checkpoint.ts`'s approved-rollback path, since a restart is
 * a `destructive_git` act like any other and needs the same approval and
 * replay guard. This records the *fact* of the discard on the audit log
 * (`recordCompletedAction`) so the choice is visible even before any
 * approval completes, and opens the new attempt clean.
 */
export function applyRestart(options: ApplyRestartOptions): { readonly newAttempt: Attempt; readonly discardedFrom: AttemptId; readonly discard: RestartDiscard } {
  const { store, oldAttempt } = options;
  const at = options.now();
  const attemptId = options.newId() as AttemptId;

  const discard = discardToLastCheckpoint(options);

  const actionId = actionIdFor({
    workflowId: options.workflowId,
    kind: "mid_task_restart",
    subjectId: oldAttempt.taskId,
    discriminator: { fromAttemptId: oldAttempt.id, toAttemptId: attemptId },
  });
  store.write(() =>
    recordCompletedAction({
      store,
      workflowId: options.workflowId as never,
      actionId,
      kind: "mid_task_restart",
      sessionId: options.sessionId,
      summary:
        `restarted task ${oldAttempt.taskId} on cap; discarded uncommitted work from attempt ${oldAttempt.id} ` +
        `to checkpoint ${options.lastCheckpointCommit ?? "none (no prior checkpoint)"} per midTaskPolicy=restart ` +
        `(${discard.kind}${discard.kind === "skipped" ? `: ${discard.reason}` : `: ${discard.changedPaths.length} path(s) discarded`})`,
      now: options.now,
      subjectId: oldAttempt.taskId,
      gitRevision: options.lastCheckpointCommit,
      externalEffect: false,
    }),
  );

  const newAttempt: Attempt = {
    ...oldAttempt,
    id: attemptId,
    createdAt: at,
    updatedAt: at,
    workerId: options.workerId,
    role: options.role,
    requestedModel: oldAttempt.usedModel,
    usedModel: options.substituteModel,
    fallbackReason: oldAttempt.fallbackReason,
    timestamps: { startedAt: at, endedAt: null, lastActivityAt: at },
    termination: null,
    outcome: null,
    artifacts: [],
    handedOffFromAttemptId: null,
  };
  store.write(() => store.attempts.insert(newAttempt));
  return { newAttempt, discardedFrom: oldAttempt.id, discard };
}

/**
 * Actually discard uncommitted work in `options.worktreeCwd` down to
 * `options.lastCheckpointCommit`. Refuses (returns `skipped`, never throws)
 * when there is nothing to discard to, the path is not a repository, or the
 * path resolves to the user's main tree — the same main-tree guard
 * `src/workflow/checkpoint.ts` uses, applied here too because a restart is
 * exactly the kind of destructive act that guard exists for.
 */
function discardToLastCheckpoint(options: ApplyRestartOptions): RestartDiscard {
  if (options.lastCheckpointCommit === null) return { kind: "skipped", reason: "no_checkpoint" };
  const identity = worktreeIdentity(options.worktreeCwd, options.runner);
  if (identity === null) return { kind: "skipped", reason: "not_a_repository" };
  if (isMainTree(identity, options.mainTree ?? null)) return { kind: "skipped", reason: "target_is_main_tree" };
  try {
    const restored = restoreCheckpointTree({
      cwd: identity.toplevel,
      commit: options.lastCheckpointCommit,
      preservationId: options.newId(),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    return { kind: "discarded", changedPaths: restored.changedPaths };
  } catch (error) {
    if (error instanceof CheckpointError) return { kind: "skipped", reason: "not_a_repository" };
    throw error;
  }
}
