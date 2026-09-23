-- 0012-runs: durable identity for one `/korwf run` invocation (issue #74;
-- PLAN §2.1 "Start scheduler (next issue) and print the run id.").
--
-- `run` is append-only: a run is started once and its identity never
-- changes. It exists so a stop/resume cycle, a crash (#72's reconciliation)
-- and this issue's own `stopRun` can all name the same run afterwards,
-- rather than the coordinator having to guess which phases belonged
-- together from timing alone.
--
-- `phase.runId`/`attempt.runId` are nullable additive columns: a phase or
-- attempt created before this migration, or one never started through
-- `/korwf run` at all, has no run to carry.

CREATE TABLE run (
  runId       TEXT    PRIMARY KEY,
  createdAt   TEXT    NOT NULL,
  workflowId  TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  -- JSON array of the PhaseIds this run targeted, in request order.
  phaseIds    TEXT    NOT NULL,
  payload     TEXT    NOT NULL
);
CREATE INDEX run_by_workflow ON run(workflowId, createdAt);

CREATE TRIGGER run_no_update
BEFORE UPDATE ON run
BEGIN
  SELECT RAISE(ABORT, 'run is append-only: a run''s identity and target never change');
END;

CREATE TRIGGER run_no_delete
BEFORE DELETE ON run
BEGIN
  SELECT RAISE(ABORT, 'run is append-only: deleting it would strand its phases/attempts run id');
END;

ALTER TABLE phase ADD COLUMN runId TEXT REFERENCES run(runId) ON DELETE SET NULL;
ALTER TABLE attempt ADD COLUMN runId TEXT REFERENCES run(runId) ON DELETE SET NULL;
