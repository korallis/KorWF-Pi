/**
 * Worker runtime control (issue #71; PLAN §3.E, §3.I; ADR 0004 "Resource and
 * progress capture").
 *
 * This module is the *supervisor* around the #68 `WorkerHandle`. It does four
 * things and delegates everything else:
 *
 * 1. **Progress.** ADR 0004 already decides where progress comes from: the
 *    RPC event stream. `tool_execution_*` and `bash_execution_update` drive
 *    the board; `message_update.usage` and `get_session_stats` feed
 *    accounting. This module classifies those events into a
 *    {@link ProgressEvent} timeline; it opens no second channel.
 * 2. **Artifacts.** Declared `termination.artifacts` are captured into the
 *    #23 `ArtifactStore` under the attempt id, producing `ArtifactRef`s for
 *    the Attempt row (docs/records.md "Attempt (usage, artifacts)").
 * 3. **Usage and limits.** Usage is attributed **per route** (#125), never
 *    per model id, and cost the registry does not state is `unknown`, never
 *    0 (#56/#30). Global and per-worker limits are enforced by #30's atomic
 *    `BEGIN IMMEDIATE` reservation — this module reserves before the process
 *    exists and settles after it ends. There is no second accounting path.
 * 4. **Pause / resume / cancel.** Cancellation reuses #68's three-tier ladder
 *    with its pre-snapshotted descendant sweep; pause/resume use SIGSTOP /
 *    SIGCONT with a cooperative fallback where signals do not apply.
 */
import type { ArtifactRef, AttemptId, AttemptOutcome, IsoTimestamp, Usage } from "../storage/records.ts";
import type { Route } from "../models/route.ts";
import type { Ledger, ChargeScope, Reservation } from "../telemetry/ledger.ts";
import type { CancelResult, RpcMessage, WorkerHandle } from "./spawn.ts";
import type { WorkerContract } from "./contract.ts";

export {};
