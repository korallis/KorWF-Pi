-- 0007-recovery: the bounded-recovery audit log (issue #53; PLAN §3.G
-- "Bounded responses: gather evidence, retry, fallback model (D), replan,
-- change worker/profile, request review, ask user, stop. No blind retry of
-- side effects; reconcile uncertain outcomes first.").
--
-- One append-only table. Every recovery decision — including the ones that
-- refused to retry and the ones that stopped — writes a row naming the rule
-- that produced it, the failure category it was chosen from (`src/workflow/
-- failure.ts`, #52), how much of the bound was already spent, and, when the
-- step had side effects, what reconciliation concluded before the response
-- was allowed to be `retry`.
--
-- Why a row per decision rather than a field on the task: a recovery ladder
-- is a sequence, and "this task burnt six attempts" is only answerable if
-- each rung is recorded. The unbounded retry loop this issue exists to
-- prevent is invisible in a single mutable counter and obvious in a log.
--
-- Not a PLAN §5 record: a recovery decision has no revisioned identity and is
-- never updated, so it lives here rather than in a repository, exactly like
-- `transition_event` and `completed_action`.

CREATE TABLE recovery_decision (
  decisionRowId    TEXT    PRIMARY KEY,
  createdAt        TEXT    NOT NULL,
  workflowId       TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  subjectKind      TEXT    NOT NULL CHECK (subjectKind IN ('task', 'phase', 'workflow')),
  subjectId        TEXT    NOT NULL,
  -- Attempts already spent on this subject when the decision was taken.
  attemptsUsed     INTEGER NOT NULL,
  -- Hard ceiling in force at that moment (config `recovery.maxAttemptsPerTask`).
  maxAttempts      INTEGER NOT NULL,
  -- Failure category from src/workflow/failure.ts; never re-derived here.
  failureCategory  TEXT    NOT NULL,
  failureRule      TEXT    NOT NULL,
  -- Chosen response, one of the PLAN §3.G menu.
  response         TEXT    NOT NULL,
  -- Stable id of the policy rule that chose it, e.g. 'ladder:service:1'.
  policyRule       TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  -- 1 when the response ends the task's recovery (`ask_user` or `stop`).
  terminal         INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  -- Side-effect reconciliation verdict, or NULL when the step had none.
  sideEffectStatus TEXT,
  -- Idempotency key of the guarded action, when one was consulted (#42).
  actionId         TEXT,
  payload          TEXT    NOT NULL
);

CREATE INDEX recovery_decision_by_subject ON recovery_decision(subjectKind, subjectId, createdAt);
CREATE INDEX recovery_decision_by_workflow ON recovery_decision(workflowId, createdAt);

CREATE TRIGGER recovery_decision_no_update
BEFORE UPDATE ON recovery_decision
BEGIN
  SELECT RAISE(ABORT, 'recovery_decision is append-only: a recovery decision is history');
END;

CREATE TRIGGER recovery_decision_no_delete
BEFORE DELETE ON recovery_decision
BEGIN
  SELECT RAISE(ABORT, 'recovery_decision is append-only: deleting a rung would unbound the ladder');
END;
