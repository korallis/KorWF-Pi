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
 *  - `restart`: the worktree is rolled back to the task's last checkpoint,
 *    but ONLY through `src/workflow/checkpoint.ts`'s approved-rollback path
 *    (`proposeRollback`/`applyRollback`, #54). `destructive_git` is a PLAN
 *    §7 high-risk class — `stop` in every mode, grantable only by a `user`
 *    actor (#49) — and a task-kind policy of `restart` is a *reason to ask*,
 *    never a substitute for the approval itself. `proposeRestart` only ever
 *    queues the request; `applyRestart` re-reads the approval at call time
 *    and refuses (discarding nothing) when it is missing, reused, or
 *    superseded. Only once `applyRollback` has actually restored the tree is
 *    the fresh Attempt opened, with no packet.
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
import type { GitEnvRunner, WorktreeIdentity } from "../git/checkpoint.ts";
import {
  proposeRollback,
  applyRollback,
  type RollbackRefusal,
  type ProposedRollback,
} from "../workflow/checkpoint.ts";

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

/** Inputs for {@link proposeRestart}. */
export interface ProposeRestartOptions extends HandoffDeps {
  readonly workflowId: string;
  readonly oldAttempt: Attempt;
  readonly checkpointId: string;
  readonly worktreeCwd?: string;
  readonly mainTree?: WorktreeIdentity | null;
  readonly runner?: GitEnvRunner;
  readonly ttlMs?: number | null;
}

/**
 * Propose `restart`: queue the `destructive_git` approval request that
 * discarding uncommitted work down to `checkpointId` requires. **This never
 * discards anything.** It is a thin, named wrapper over #54's
 * `proposeRollback` so that a mid-task restart is visibly the same kind of
 * act as any other rollback, carrying the same "what would be lost" impact
 * and going through the same high-risk approval class — a task-kind policy
 * of `restart` is a reason to *ask*, not an authorisation.
 */
export function proposeRestart(options: ProposeRestartOptions): ProposedRollback {
  return proposeRollback({
    store: options.store,
    workflowId: options.workflowId as never,
    checkpointId: options.checkpointId,
    taskId: options.oldAttempt.taskId,
    attemptId: options.oldAttempt.id,
    now: options.now,
    newId: options.newId,
    ...(options.worktreeCwd === undefined ? {} : { cwd: options.worktreeCwd }),
    ...(options.mainTree === undefined ? {} : { mainTree: options.mainTree }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ttlMs: options.ttlMs ?? null,
  });
}

/** Inputs for {@link applyRestart}. */
export interface ApplyRestartOptions extends HandoffDeps {
  readonly workflowId: string;
  readonly oldAttempt: Attempt;
  readonly proposalId: string;
  readonly sessionId: string;
  readonly role: Attempt["role"];
  readonly workerId: string;
  readonly substituteModel: Attempt["usedModel"];
  readonly mainTree?: WorktreeIdentity | null;
  readonly runner?: GitEnvRunner;
}

/** Result of {@link applyRestart}. */
export type ApplyRestartResult =
  | { readonly kind: "restarted"; readonly newAttempt: Attempt; readonly discardedFrom: AttemptId; readonly changedPaths: readonly string[] }
  | { readonly kind: "pending_approval"; readonly reason: RollbackRefusal; readonly detail: string };

/**
 * Apply `restart`, only through the approved-rollback path (#54).
 *
 * `applyRollback` re-reads the `Approval` rows at call time — not a boolean
 * this function is handed — and independently re-checks the main-tree guard
 * and the #42 replay receipt. **No branch of this function discards
 * anything without `applyRollback` reporting `applied: true` first.** With
 * no approval (missing, reused, or superseded), nothing is touched and this
 * returns `pending_approval`: the restart is proposed, not performed. Only
 * once the tree has actually been restored is a fresh Attempt opened, with
 * no packet, and `handedOffFromAttemptId: null`.
 */
export function applyRestart(options: ApplyRestartOptions): ApplyRestartResult {
  const { store, oldAttempt } = options;
  const outcome = applyRollback({
    store,
    workflowId: options.workflowId as never,
    proposalId: options.proposalId,
    sessionId: options.sessionId,
    now: options.now,
    newId: options.newId,
    ...(options.mainTree === undefined ? {} : { mainTree: options.mainTree }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });

  if (!outcome.applied) {
    return { kind: "pending_approval", reason: outcome.reason, detail: outcome.detail };
  }

  const at = options.now();
  const attemptId = options.newId() as AttemptId;
  const actionId = actionIdFor({
    workflowId: options.workflowId,
    kind: "mid_task_restart",
    subjectId: oldAttempt.taskId,
    discriminator: { fromAttemptId: oldAttempt.id, toAttemptId: attemptId, proposalId: options.proposalId },
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
        `via approved rollback proposal ${options.proposalId} per midTaskPolicy=restart ` +
        `(${outcome.changedPaths.length} path(s) discarded)`,
      now: options.now,
      subjectKind: "task",
      subjectId: oldAttempt.taskId,
      gitRevision: outcome.preservation.row.commitSha,
      approvalId: outcome.proposal.approvalId,
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
  return { kind: "restarted", newAttempt, discardedFrom: oldAttempt.id, changedPaths: outcome.changedPaths };
}
