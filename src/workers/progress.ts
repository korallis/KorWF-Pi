/**
 * Worker progress capture (issue #71; ADR 0004 "Resource and progress
 * capture"; PLAN §3.I "task/phase status, workers, ... running cost").
 *
 * ADR 0004 already decided where progress comes from — the RPC event stream
 * the worker emits on stdout:
 *
 * > Progress: the RPC event stream is forwarded to `workflow/` as-is;
 * > `tool_execution_*` and `bash_execution_update` drive the board;
 * > `message_update.usage` and `get_session_stats` feed accounting and
 * > token/spend limits.
 *
 * So this module is a *classifier*, not a channel. It takes the already-
 * decoded `RpcMessage`s that `WorkerHandle` delivers and turns them into a
 * bounded, append-only {@link ProgressEvent} timeline plus a rolling
 * {@link ProgressSnapshot}. It performs no I/O, spawns nothing, and never
 * asks the worker for anything.
 *
 * Bounded by construction: the timeline keeps at most `maxEvents` entries and
 * drops the oldest, counting the drops. An unbounded in-memory timeline is a
 * memory leak on a long worker run, and silently forgetting is worse than
 * saying how much was forgotten.
 */
import type { IsoTimestamp, Usage } from "../storage/records.ts";
import type { RpcMessage } from "./spawn.ts";
import { classifyCost, unknownUsage, type PriceMetadata } from "../telemetry/ledger.ts";

/** What a progress event says happened. */
export type ProgressKind =
  | "started"
  | "tool_started"
  | "tool_finished"
  | "bash_output"
  | "message"
  | "usage"
  | "paused"
  | "resumed"
  | "cancelled"
  | "limit_breached"
  | "exited";

/** One entry in the attempt's progress timeline. */
export interface ProgressEvent {
  readonly at: IsoTimestamp;
  readonly kind: ProgressKind;
  /** Short human-readable line for the board. Never contains payload content. */
  readonly detail: string;
  /** Tool name for `tool_*` events; `null` otherwise. */
  readonly tool: string | null;
  /** Raw RPC message type the event was derived from; `null` for synthetic events. */
  readonly source: string | null;
}

/** Rolling view of a worker's progress, cheap to render on a board. */
export interface ProgressSnapshot {
  readonly events: readonly ProgressEvent[];
  /** Events dropped because the timeline is bounded. */
  readonly dropped: number;
  /** Tool executions started, and of those, finished. */
  readonly toolsStarted: number;
  readonly toolsFinished: number;
  /** Tool calls currently outstanding, by name. */
  readonly activeTools: readonly string[];
  readonly bashUpdates: number;
  readonly messages: number;
  /** Timestamp of the most recent event, or `null` before anything happened. */
  readonly lastActivityAt: IsoTimestamp | null;
}

/** Token/cost fields as a Pi `message_update.usage` or `get_session_stats` payload carries them. */
interface RawUsageFields {
  readonly inputTokens?: unknown;
  readonly input_tokens?: unknown;
  readonly outputTokens?: unknown;
  readonly output_tokens?: unknown;
  readonly costUsd?: unknown;
  readonly cost?: unknown;
  readonly totalCostUsd?: unknown;
}

const MAX_EVENTS_DEFAULT = 500;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Read a Pi usage payload into an honest {@link Usage}.
 *
 * The rule from #56/#30 applies here and is the reason this is not a
 * one-liner: a cost the registry (or proxy) does not state is **unknown**,
 * never `0`. Pi's own `message_update.usage` reports `costUsd: 0` for a
 * subscription-backed route that has no per-token price, so treating the
 * field as authoritative would report every such run as free. A zero or
 * absent charge with no usable price metadata therefore yields
 * `costBasis: "unknown"` and `spendUsd: null`.
 */
export function usageFromRpc(
  payload: unknown,
  price?: PriceMetadata | null,
): Usage {
  if (payload === null || typeof payload !== "object") return unknownUsage(1);
  const raw = payload as RawUsageFields;
  const inputTokens = num(raw.inputTokens) ?? num(raw.input_tokens);
  const outputTokens = num(raw.outputTokens) ?? num(raw.output_tokens);
  const reported = num(raw.costUsd) ?? num(raw.cost) ?? num(raw.totalCostUsd);
  // A reported charge of exactly 0 is the "no figure" sentinel Pi emits for
  // routes it cannot price; only a positive charge is evidence of a cost.
  const reportedSpendUsd = reported !== null && reported > 0 ? reported : null;
  return classifyCost({
    tokens: { inputTokens, outputTokens, requests: 1 },
    price: price ?? null,
    reportedSpendUsd,
    basis: "known",
  });
}

/** `usage` object carried by an RPC message, if any. */
export function usagePayloadOf(message: RpcMessage): unknown {
  const data = message.data as { usage?: unknown } | undefined;
  if (data !== undefined && data !== null && typeof data === "object" && "usage" in data) {
    return (data as { usage?: unknown }).usage;
  }
  if ("usage" in message) return (message as { usage?: unknown }).usage;
  return undefined;
}

/** Tool name carried by a `tool_execution_*` message, when it has one. */
function toolNameOf(message: RpcMessage): string | null {
  const data = message.data as { toolName?: unknown; tool?: unknown; name?: unknown } | undefined;
  const candidate = data?.toolName ?? data?.tool ?? data?.name ?? (message as { toolName?: unknown }).toolName;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/**
 * Accumulates the progress timeline for one worker.
 *
 * Deliberately synchronous and pure-in-effect: `observe` is called from the
 * `WorkerHandle` message callback, which must never block the RPC reader.
 */
export class ProgressTimeline {
  readonly #events: ProgressEvent[] = [];
  readonly #now: () => IsoTimestamp;
  readonly #maxEvents: number;
  readonly #active = new Map<string, number>();
  #dropped = 0;
  #toolsStarted = 0;
  #toolsFinished = 0;
  #bashUpdates = 0;
  #messages = 0;

  constructor(options: { readonly now?: () => IsoTimestamp; readonly maxEvents?: number } = {}) {
    this.#now = options.now ?? ((): IsoTimestamp => new Date().toISOString());
    this.#maxEvents = options.maxEvents ?? MAX_EVENTS_DEFAULT;
  }

  /** Append a synthetic event (started, paused, cancelled, limit breached…). */
  record(kind: ProgressKind, detail: string, tool: string | null = null, source: string | null = null): ProgressEvent {
    const event: ProgressEvent = { at: this.#now(), kind, detail, tool, source };
    this.#events.push(event);
    while (this.#events.length > this.#maxEvents) {
      this.#events.shift();
      this.#dropped += 1;
    }
    return event;
  }

  /**
   * Classify one RPC message. Returns the event appended, or `null` for a
   * message that carries no progress meaning (a correlated command response,
   * for instance) — those are still the handle's business, not the board's.
   */
  observe(message: RpcMessage): ProgressEvent | null {
    const type = typeof message.type === "string" ? message.type : "";
    if (type.startsWith("tool_execution_")) return this.#observeTool(type, message);
    if (type === "bash_execution_update") {
      this.#bashUpdates += 1;
      return this.record("bash_output", "bash output", null, type);
    }
    if (type === "message_update" || type === "message_end") {
      this.#messages += 1;
      const usage = usagePayloadOf(message);
      if (usage !== undefined) return this.record("usage", "usage reported", null, type);
      return this.record("message", "assistant message", null, type);
    }
    if (type === "worker_exit") {
      return this.record("exited", "worker exited", null, type);
    }
    return null;
  }

  #observeTool(type: string, message: RpcMessage): ProgressEvent {
    const tool = toolNameOf(message);
    const name = tool ?? "tool";
    if (type === "tool_execution_start") {
      this.#toolsStarted += 1;
      this.#active.set(name, (this.#active.get(name) ?? 0) + 1);
      return this.record("tool_started", `${name} started`, tool, type);
    }
    if (type === "tool_execution_end") {
      this.#toolsFinished += 1;
      const outstanding = (this.#active.get(name) ?? 0) - 1;
      if (outstanding > 0) this.#active.set(name, outstanding);
      else this.#active.delete(name);
      return this.record("tool_finished", `${name} finished`, tool, type);
    }
    // tool_execution_update and any future variant: progress, not a boundary.
    return this.record("tool_started", `${name} progress`, tool, type);
  }

  /** Current snapshot. The returned arrays are copies; the timeline is not aliased. */
  snapshot(): ProgressSnapshot {
    const last = this.#events.at(-1);
    return {
      events: [...this.#events],
      dropped: this.#dropped,
      toolsStarted: this.#toolsStarted,
      toolsFinished: this.#toolsFinished,
      activeTools: [...this.#active.keys()],
      bashUpdates: this.#bashUpdates,
      messages: this.#messages,
      lastActivityAt: last?.at ?? null,
    };
  }
}
