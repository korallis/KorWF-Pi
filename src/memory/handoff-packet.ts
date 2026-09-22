/**
 * `HandoffPacket` schema and builder (issue #64; PLAN §3.D "Mid-task: hand
 * off with an explicit handoff packet and intact worktree (default)";
 * PLAN §3.H "Explicit handoff packets for workers, model fallback (D), and
 * resumed sessions").
 *
 * A handoff packet is what makes a mid-task model switch safe: the new
 * model has no memory of the previous one's reasoning, so the packet is the
 * only carrier of it. This module only *builds* the packet from records
 * that already exist elsewhere (Attempt, Evidence, worker progress notes) —
 * it invents nothing and runs no I/O. `src/workers/handoff.ts` is where the
 * packet is turned into an action (continue the worktree or restart it).
 */
import type { Attempt, Evidence, IsoTimestamp, TaskId } from "../storage/records.ts";

/** One note a worker wrote at a checkpoint, in its own words. */
export interface ProgressNote {
  readonly at: IsoTimestamp;
  readonly text: string;
}

/** Where the evidence a claim rests on can be found. */
export interface EvidencePointer {
  readonly evidenceId: string;
  readonly requirementId: string;
  readonly summary: string;
}

/**
 * The explicit handoff packet. Every field is something a model with no
 * memory of the previous attempt needs in order to continue safely.
 */
export interface HandoffPacket {
  readonly taskId: TaskId;
  readonly fromAttemptId: string;
  /** The task's own goal and acceptance criteria, verbatim. */
  readonly task: { readonly goal: string; readonly acceptanceCriteria: readonly string[] };
  /** What has been done so far, in the previous worker's own words. */
  readonly done: readonly ProgressNote[];
  /** What remains, as far as the previous worker or the checks can tell. */
  readonly remaining: readonly string[];
  /** Decisions made and why — durable reasoning that would otherwise be lost. */
  readonly decisions: readonly { readonly what: string; readonly why: string }[];
  /** Unresolved questions the next model should not silently re-decide. */
  readonly openQuestions: readonly string[];
  /** Where the evidence for any completion claim lives. */
  readonly evidence: readonly EvidencePointer[];
  /** Model this is handed off from/to, and why. */
  readonly requestedModel: string;
  readonly substituteModel: string;
  readonly fallbackReason: string | null;
  readonly builtAt: IsoTimestamp;
}

export interface BuildHandoffPacketInput {
  readonly attempt: Attempt;
  readonly progressNotes: readonly ProgressNote[];
  readonly remaining: readonly string[];
  readonly decisions: readonly { readonly what: string; readonly why: string }[];
  readonly openQuestions: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly task: { readonly goal: string; readonly acceptanceCriteria: readonly string[] };
  readonly substituteModel: string;
  readonly now: () => IsoTimestamp;
}

export function buildHandoffPacket(input: BuildHandoffPacketInput): HandoffPacket {
  throw new Error("not implemented");
}
