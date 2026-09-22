-- 0006-actions: the completed-action log and its replay refusals (issue #42;
-- PLAN §5 "Pi conversation branching does not undo Git changes or external
-- effects. Fork/resume reconciles live repository state and never resurrects
-- obsolete approvals or replays completed actions.").
--
-- Two tables, both append-only:
--
--  * `completed_action` is the receipt for an action that actually happened:
--    a commit, a merge, a push, a file write, a published artifact. Its
--    `actionId` is chosen by the caller *before* the action runs and is the
--    idempotency key. A conversation rewind (fork, `/tree`, resume of an
--    older session) restores the transcript but not the repository, so the
--    same turn can ask for the same action again; the row here is what makes
--    the second request a refusal instead of a second effect.
--
--  * `action_replay_attempt` records each refused re-execution, with the
--    session that asked and the reason. Refusals must be as visible as
--    successes (docs/state-machine.md §6), and an unexplained no-op is
--    indistinguishable from a bug.
--
-- Neither table is a PLAN §5 record: an action receipt has no revisioned
-- identity and is never updated, so it lives here rather than in a
-- repository, exactly like `transition_event`.

CREATE TABLE completed_action (
  actionId       TEXT    PRIMARY KEY,
  recordedAt     TEXT    NOT NULL,
  workflowId     TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  -- Caller-defined family, e.g. 'git_commit', 'git_push', 'publish'.
  kind           TEXT    NOT NULL,
  subjectKind    TEXT    CHECK (subjectKind IS NULL OR subjectKind IN ('task', 'phase', 'workflow')),
  subjectId      TEXT,
  -- Pi session that performed it. A fork runs under a different session id;
  -- that difference is information, never permission.
  sessionId      TEXT    NOT NULL,
  -- Exact Git SHA the effect was produced at, when the action had one.
  gitRevision    TEXT,
  -- Approval that authorised it, when one was required.
  approvalId     TEXT,
  -- 1 when the effect left this machine or this repository's history
  -- (push, publish, deploy): those can never be re-run on a hunch.
  externalEffect INTEGER NOT NULL CHECK (externalEffect IN (0, 1)),
  summary        TEXT    NOT NULL,
  payload        TEXT    NOT NULL
);

CREATE INDEX completed_action_by_workflow ON completed_action(workflowId, recordedAt);
CREATE INDEX completed_action_by_subject ON completed_action(subjectKind, subjectId);

CREATE TRIGGER completed_action_no_update
BEFORE UPDATE ON completed_action
BEGIN
  SELECT RAISE(ABORT, 'completed_action is append-only: a receipt is never rewritten');
END;

CREATE TRIGGER completed_action_no_delete
BEFORE DELETE ON completed_action
BEGIN
  SELECT RAISE(ABORT, 'completed_action is append-only: deleting a receipt would permit a replay');
END;

CREATE TABLE action_replay_attempt (
  attemptRowId   TEXT    PRIMARY KEY,
  createdAt      TEXT    NOT NULL,
  actionId       TEXT    NOT NULL REFERENCES completed_action(actionId) ON DELETE RESTRICT,
  workflowId     TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  -- Session that asked for the repeat; typically a fork or a resumed session.
  sessionId      TEXT    NOT NULL,
  -- Stable reason code from src/workflow/reconcile.ts.
  reasonCode     TEXT    NOT NULL,
  detail         TEXT    NOT NULL,
  payload        TEXT    NOT NULL
);

CREATE INDEX action_replay_attempt_by_action ON action_replay_attempt(actionId, createdAt);
CREATE INDEX action_replay_attempt_by_workflow ON action_replay_attempt(workflowId, createdAt);

CREATE TRIGGER action_replay_attempt_no_update
BEFORE UPDATE ON action_replay_attempt
BEGIN
  SELECT RAISE(ABORT, 'action_replay_attempt is append-only');
END;

CREATE TRIGGER action_replay_attempt_no_delete
BEFORE DELETE ON action_replay_attempt
BEGIN
  SELECT RAISE(ABORT, 'action_replay_attempt is append-only: a refusal is history');
END;
