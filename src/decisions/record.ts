/**
 * Recording decisions (issue #27; PLAN §5, docs/records.md §Decision).
 *
 * Decisions are persisted through the store (#23) — append-only, raw
 * distribution preserved. This module does not re-implement persistence: it
 * assembles a `Decision` record and hands it to the repository's `insert`.
 * The dependency is expressed structurally (`DecisionSink`) so `ask()` can be
 * unit-tested with an in-memory sink and so `src/decisions/` never needs a
 * live SQLite handle to be exercised.
 */
import type {
  Decision,
  DecisionId,
  Distribution,
  GitSha,
  IsoTimestamp,
  Usage,
  WorkflowId,
} from "../storage/records.ts";
import { RECORDS_SCHEMA_VERSION } from "../storage/records.ts";

/** The subject a decision is about; `null` for workflow-level decisions. */
export type DecisionSubject = Decision["subject"];

/** The part of the store this module needs: append one Decision row. */
export interface DecisionSink {
  insert(record: Decision): Decision;
}

/** Everything `ask()` knows about one decision, before the envelope. */
export interface DecisionDraft {
  readonly stateHash: string;
  readonly questionId: string;
  readonly questionVersion: string;
  readonly jevModelVersion: string | null;
  readonly rawDistribution: Distribution;
  readonly confidence: number | null;
  readonly policyRule: string;
  readonly action: string;
  readonly latencyMs: number | null;
  readonly usage: Usage;
  readonly subject?: DecisionSubject;
}

/** Zero-cost usage for a decision answered without calling Jev at all. */
export const FALLBACK_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  spendUsd: 0,
  costBasis: "known",
});

/** Usage for a Jev call whose cost the adapter could not price (#30). */
export const UNPRICED_JEV_USAGE: Usage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  requests: 1,
  spendUsd: null,
  costBasis: "unknown",
});

export interface DecisionRecorderOptions {
  readonly sink: DecisionSink;
  readonly workflowId: WorkflowId;
  /** Revision the state was computed at (`Decision.freshness.revision`). */
  readonly revision: GitSha;
  /** Default subject when an `AskItem` does not carry one. */
  readonly subject?: DecisionSubject;
  readonly now?: () => IsoTimestamp;
  readonly newId?: () => string;
}

let counter = 0;
function defaultNewId(): string {
  counter += 1;
  return `dc-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Turns a `DecisionDraft` into a persisted `Decision`. One recorder per
 * workflow; `ask()` holds it and calls `record()` on every path, including
 * the disabled one — "every `ask` writes a Decision record even in disabled
 * mode" is this class's single responsibility.
 */
export class DecisionRecorder {
  readonly #sink: DecisionSink;
  readonly #workflowId: WorkflowId;
  readonly #revision: GitSha;
  readonly #subject: DecisionSubject;
  readonly #now: () => IsoTimestamp;
  readonly #newId: () => string;

  constructor(options: DecisionRecorderOptions) {
    this.#sink = options.sink;
    this.#workflowId = options.workflowId;
    this.#revision = options.revision;
    this.#subject = options.subject ?? null;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? defaultNewId;
  }

  /** Append one Decision row. Returns it exactly as persisted. */
  record(draft: DecisionDraft): Decision {
    const at = this.#now();
    const decision: Decision = {
      id: this.#newId() as DecisionId,
      createdAt: at,
      updatedAt: at,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      kind: "append_only",
      workflowId: this.#workflowId,
      subject: draft.subject === undefined ? this.#subject : draft.subject,
      stateHash: draft.stateHash,
      questionId: draft.questionId,
      questionVersion: draft.questionVersion,
      jevModelVersion: draft.jevModelVersion,
      rawDistribution: draft.rawDistribution,
      confidence: draft.confidence,
      policyRule: draft.policyRule,
      action: draft.action,
      override: null,
      freshness: { revision: this.#revision, decidedAt: at, expiresAt: null },
      usage: draft.usage,
      latencyMs: draft.latencyMs,
    };
    return this.#sink.insert(decision);
  }

  /**
   * Most recent recorded decision for this exact question *and* state hash,
   * or `undefined`. Used only when a caller opts into reuse; the store's
   * `byStateHash` is the index behind it (docs/records.md §10 rule 4).
   */
  findReusable(questionId: string, questionVersion: string, stateHash: string): Decision | undefined {
    const lookup = this.#sink as Partial<DecisionLookup>;
    if (typeof lookup.byStateHash !== "function") return undefined;
    const rows = lookup.byStateHash(questionId, stateHash);
    const matching = rows.filter((row) => row.questionVersion === questionVersion && row.override === null);
    return matching.length === 0 ? undefined : matching[matching.length - 1];
  }
}

/** Optional read side of the sink; `DecisionRepository` satisfies it. */
export interface DecisionLookup {
  byStateHash(questionId: string, stateHash: string): readonly Decision[];
}

/** In-memory sink for tests and for dry-run modes. Append-only, like the store. */
export class MemoryDecisionSink implements DecisionSink, DecisionLookup {
  readonly rows: Decision[] = [];

  insert(record: Decision): Decision {
    this.rows.push(record);
    return record;
  }

  byStateHash(questionId: string, stateHash: string): readonly Decision[] {
    return this.rows.filter((row) => row.questionId === questionId && row.stateHash === stateHash);
  }
}
