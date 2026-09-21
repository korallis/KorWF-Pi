-- 0004-decision-trace: decision traces (issue #31; PLAN §3.I, §7).
--
-- A trace is *observability about* a recorded Decision, not a second copy of
-- it. The Decision row (#23, append-only) remains the authority for what was
-- asked, what came back and what was done; a trace adds the five versions,
-- the latency, the retry count, the breaker state and a sanitised summary of
-- what actually went outbound, so `/korwf why <decision>` can reconstruct the
-- event from recorded fields alone (PLAN §3.I: "never fabricated rationales").
--
-- Like `decision_cache` (#29) this is not a PLAN §5 record: it holds no
-- independent truth about the workflow, so it is not in docs/records.md's
-- append-only/mutable taxonomy and is not audited. Two consequences:
--
--   * It is never UPDATEd. A trace describes one event that already
--     happened; correcting it would be fabrication. The trigger below
--     enforces that from any connection.
--   * It MAY be DELETEd, and only by retention (`src/telemetry/retention.ts`).
--     PLAN §7 requires deletion controls for logging; a table that could not
--     be pruned could not honour them. Deleting a trace never deletes the
--     Decision it points at.
--
-- `rawPayloadPath` is NULL unless `privacy.rawLogging.enabled` was true when
-- the trace was written; it is an artifact-root-relative path, never
-- absolute, and the bytes it names are purged on the configured retention.

CREATE TABLE decision_trace (
  traceId         TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  -- NULL only when a decision was traced without being recorded (dry runs).
  decisionId      TEXT             REFERENCES decision(id) ON DELETE RESTRICT,
  attemptId       TEXT,
  workflowId      TEXT    NOT NULL,
  questionId      TEXT    NOT NULL,
  questionVersion TEXT    NOT NULL,
  outcome         TEXT    NOT NULL,
  latencyMs       INTEGER,
  retries         INTEGER NOT NULL DEFAULT 0,
  breakerState    TEXT    NOT NULL,
  rawPayloadPath  TEXT,
  payload         TEXT    NOT NULL
);

CREATE INDEX decision_trace_by_decision ON decision_trace(decisionId);
CREATE INDEX decision_trace_by_attempt ON decision_trace(attemptId);
CREATE INDEX decision_trace_by_question ON decision_trace(questionId, questionVersion);
CREATE INDEX decision_trace_by_created ON decision_trace(createdAt);

CREATE TRIGGER decision_trace_no_update
BEFORE UPDATE ON decision_trace
BEGIN
  SELECT RAISE(ABORT, 'decision_trace is write-once: record a new trace instead');
END;
