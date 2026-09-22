/**
 * `/korwf why <decision>` and `/korwf purge` (issue #31; PLAN §3.I, §7).
 *
 * `why` is the user-facing half of decision traces: it reads the recorded
 * `Decision` row and its trace out of the store and renders
 * `explainDecision`'s output. It computes nothing and infers nothing — if a
 * field was not recorded, the output says so. Stage 8 replaces the rendering
 * with a richer UI; the reconstruction logic stays here.
 *
 * `purge` is the deletion control PLAN §7 requires alongside opt-in raw
 * payload logging: it expires what is due, or deletes every stored raw
 * payload outright with `--all`.
 *
 * Pure string builders plus a store handle, so both are tested without a Pi
 * session.
 */
import type { KorwfConfig } from "../../config/types.ts";
import type { Store } from "../../storage/db.ts";
import { explainDecision } from "../../telemetry/trace.ts";
import {
  purgeExpiredRawPayloads,
  purgeRawPayloadsNow,
  retentionSummary,
  runRetentionSweep,
} from "../../telemetry/retention.ts";

/** The store surfaces these commands need. `Store` satisfies it. */
export type TraceReadStore = Pick<Store, "decisions" | "decisionTraces" | "artifacts"> &
  Partial<Pick<Store, "gateReceipts">>;

/**
 * Explain the last task-gate evaluation for a task, from recorded fields only
 * (issue #46; docs/gates.md §7).
 *
 * The task gate is where "why is this not done?" is most often asked, and the
 * answer must come from the receipt rather than from a reconstruction: a
 * refusal names its condition (`C0`…`C3`) and its closed-set reason code, and
 * this renders exactly those fields. `null` when the subject is not a task
 * with a receipt, so `whyMessage` can go on to try a decision id.
 */
export function gateReceiptMessage(store: TraceReadStore, id: string): string | null {
  const receipt = store.gateReceipts?.latestForSubject("task", id);
  if (receipt === undefined) return null;
  const head =
    receipt.disposition === "pass"
      ? `Task gate PASSED for ${id} at revision ${receipt.revision.slice(0, 12)} (task revision ${receipt.subjectRevision}).`
      : `Task gate REFUSED for ${id} at revision ${receipt.revision.slice(0, 12)} (task revision ${receipt.subjectRevision}).`;
  const lines = receipt.conditions.map((condition) =>
    condition.satisfied
      ? `  ${condition.id}: satisfied`
      : `  ${condition.id}: ${condition.reasonCode ?? "unsatisfied"} — ${condition.detail ?? "no detail recorded"}`,
  );
  const used =
    receipt.disposition === "pass"
      ? receipt.consumedAt === null
        ? "This receipt has not been used yet."
        : `This receipt authorised the completion at ${receipt.consumedAt}.`
      : "No status change was made; the task stays where it was.";
  return [head, `Evaluated at ${receipt.evaluatedAt}.`, ...lines, used].join("\n");
}

/**
 * Render `/korwf why <id>`. `id` may be a Decision id or a trace id; both
 * resolve to the same event, and neither is guessed at when absent.
 */
export function whyMessage(store: TraceReadStore, id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") {
    return "Usage: /korwf why <decision-id|trace-id>";
  }

  // A task id is the most common thing a user types after "why": answer from
  // the gate receipt before falling back to decision traces.
  const gate = gateReceiptMessage(store, trimmed);
  if (gate !== null) return gate;

  const decision = store.decisions.get(trimmed) ?? null;
  if (decision !== null) {
    const traces = store.decisionTraces.forDecision(decision.id);
    return explainDecision(decision, traces[traces.length - 1] ?? null).text;
  }

  const trace = store.decisionTraces.get(trimmed) ?? null;
  if (trace !== null) {
    const linked = trace.decisionId === null ? null : (store.decisions.get(trace.decisionId) ?? null);
    return explainDecision(linked, trace).text;
  }

  return `No Decision row and no trace exist for "${trimmed}"; nothing is known about it.`;
}

/** Render `/korwf purge [--all]`. `--all` deletes every stored raw payload. */
export function purgeMessage(
  store: TraceReadStore,
  config: KorwfConfig,
  options: { readonly all?: boolean; readonly now?: () => string } = {},
): string {
  const deps = {
    traces: store.decisionTraces,
    artifacts: store.artifacts,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  if (options.all === true) {
    return retentionSummary(purgeRawPayloadsNow(deps));
  }
  if (config.privacy.rawLogging.enabled) {
    return retentionSummary(runRetentionSweep({ ...deps, config }));
  }
  // Raw logging is off. Anything on disk predates that; expire what is due
  // and say so, rather than silently doing nothing.
  const report = purgeExpiredRawPayloads(deps);
  return [
    "privacy.rawLogging.enabled is off: no new raw payloads are being written.",
    retentionSummary(report),
    report.rawPayloadsPurged.length === 0 && store.decisionTraces.withRawPayload().length > 0
      ? "Raw payloads from an earlier opt-in period remain; run `/korwf purge --all` to delete them now."
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** One line describing the current raw-logging posture, for `/korwf config`. */
export function rawLoggingStatusLine(config: KorwfConfig): string {
  const raw = config.privacy.rawLogging;
  return raw.enabled
    ? `raw payload logging: ON, redacted before write, kept ${raw.retentionDays} day(s), purge with \`/korwf purge\``
    : "raw payload logging: off (default) — traces are sanitised summaries only";
}
