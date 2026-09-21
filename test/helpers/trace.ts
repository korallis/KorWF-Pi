/**
 * Trace fixtures (issue #31).
 *
 * Mirrors `test/helpers/records.ts`: one builder with sane defaults and
 * `Partial` overrides, so a test names only the field it is about.
 */
import type { DecisionTrace, TraceVersions } from "../../src/telemetry/trace-types.ts";
import { RECORDS_SCHEMA_VERSION } from "../../src/storage/records.ts";

const AT = "2025-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);

/** All five versions populated; `jevModel` overridable to `null`. */
export function makeVersions(overrides: Partial<TraceVersions> = {}): TraceVersions {
  return {
    package: "0.1.0",
    schema: String(RECORDS_SCHEMA_VERSION),
    policy: "1",
    questionSet: "b".repeat(64),
    jevModel: "jev-1",
    ...overrides,
  };
}

export function makeTrace(overrides: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    traceId: "tr-1",
    createdAt: AT,
    decisionId: "dc-1",
    attemptId: "at-1",
    workflowId: "wf-1",
    question: { id: "task_ready", version: "1.0.0", key: "task_ready@1.0.0", contentHash: HASH },
    versions: makeVersions(),
    outcome: "jev",
    detail: {
      distribution: { true: 0.8, false: 0.2 },
      confidence: 0.8,
      policyRule: "noul_above_threshold",
      action: "proceed",
      fallbackReason: null,
      stateHash: HASH,
      reused: false,
    },
    request: {
      purpose: "jev.decision",
      requestHash: "c".repeat(64),
      sentBytes: 512,
      droppedBytes: 0,
      removedCount: 0,
      truncatedCount: 0,
      redactedStrings: 0,
      deniedPaths: [],
      stateKeys: ["goal", "revision"],
      clean: true,
    },
    latencyMs: 42,
    retries: 0,
    breakerState: "closed",
    errorCode: null,
    rawPayload: null,
    ...overrides,
  };
}
