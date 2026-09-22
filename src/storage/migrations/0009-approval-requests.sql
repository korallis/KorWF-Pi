-- 0009-approval-requests: the human-approval request queue (issue #49; PLAN
-- §2.4 condition 3, §2.6 "queue and continue", §7 "high-risk actions require
-- explicit policy/approval regardless of mode").
--
-- An `Approval` (0001-initial) is the *record* that authorises an act. This
-- table holds the step before it: a request that a human has not answered yet.
-- The two are deliberately separate rows in separate tables, because a pending
-- request must never be readable as an authorisation. Nothing in the gate
-- (docs/gates.md §2 "valid approval") looks at this table at all.
--
-- Why persist the queue rather than keep it in memory:
--   * PLAN §2.6 requires an unattended run to queue an approval, continue
--     other ready tasks and notify. A queue that lives in one process is lost
--     on resume, and the task would silently re-ask or, worse, proceed.
--   * A request is pinned to (taskRevision, planRevision, mode, policyVersion).
--     Persisting those is what lets a later session detect that the world moved
--     and mark the request `invalidated` instead of answering a stale question.
--   * "Who was asked, when, and what came back" is audit, not state.
--
-- A request is single-use: it leaves `pending` exactly once. The triggers below
-- make that a database property rather than a convention, so a second grant for
-- the same question cannot be produced by a retry, a resumed session or a
-- concurrent writer.

CREATE TABLE approval_request (
  requestId        TEXT    PRIMARY KEY,
  createdAt        TEXT    NOT NULL,
  workflowId       TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  -- Approval class id from src/workflow/approval-classes.ts (#15).
  classId          TEXT    NOT NULL,
  tier             TEXT    NOT NULL CHECK (tier IN ('configurable', 'no_auto', 'high_risk')),
  -- Disposition that caused the request: 'queue' or 'stop'. 'auto' never gets
  -- a row: a pre-approved class is not a question anyone is asked.
  decision         TEXT    NOT NULL CHECK (decision IN ('queue', 'stop')),
  mode             TEXT    NOT NULL,
  policyVersion    TEXT    NOT NULL,
  scopeKind        TEXT    NOT NULL CHECK (scopeKind IN ('task', 'phase', 'plan', 'workflow')),
  scopeTaskId      TEXT    REFERENCES task(id) ON DELETE CASCADE,
  scopePhaseId     TEXT    REFERENCES phase(id) ON DELETE CASCADE,
  -- Revisions the question was asked at. A change to either invalidates it.
  taskRevision     INTEGER,
  planRevision     INTEGER NOT NULL,
  permittedAction  TEXT    NOT NULL,
  riskClass        TEXT    NOT NULL,
  -- Stable identity of the question: same act, same revisions, same row.
  requestKey       TEXT    NOT NULL,
  summary          TEXT    NOT NULL,
  expiresAt        TEXT,
  status           TEXT    NOT NULL CHECK (status IN ('pending', 'granted', 'denied', 'invalidated')),
  resolvedAt       TEXT,
  -- '<actorKind>:<identity>' of whoever answered; NULL while pending.
  resolvedBy       TEXT,
  -- The Approval row this request produced, when granted.
  approvalId       TEXT    REFERENCES approval(id) ON DELETE SET NULL,
  -- Why it stopped being answerable (records.ts ApprovalInvalidation reasons).
  invalidationReason TEXT,
  detail           TEXT,
  payload          TEXT    NOT NULL
);

-- One *pending* question per (workflow, act, revisions). Answered rows keep
-- their history, so the index is partial rather than a plain UNIQUE.
CREATE UNIQUE INDEX approval_request_pending_key
  ON approval_request(workflowId, requestKey) WHERE status = 'pending';
CREATE INDEX approval_request_by_workflow ON approval_request(workflowId, status, createdAt);
CREATE INDEX approval_request_by_task ON approval_request(scopeTaskId, status, createdAt);

-- Single use: a request leaves `pending` once and never returns.
CREATE TRIGGER approval_request_resolve_once
BEFORE UPDATE ON approval_request
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'approval_request is single-use: an answered request is never re-answered');
END;

-- The question itself is immutable. Editing what was asked after the fact
-- would let a granted approval authorise an act nobody agreed to.
CREATE TRIGGER approval_request_question_immutable
BEFORE UPDATE ON approval_request
WHEN NEW.requestId <> OLD.requestId
  OR NEW.workflowId <> OLD.workflowId
  OR NEW.classId <> OLD.classId
  OR NEW.tier <> OLD.tier
  OR NEW.decision <> OLD.decision
  OR NEW.mode <> OLD.mode
  OR NEW.policyVersion <> OLD.policyVersion
  OR NEW.scopeKind <> OLD.scopeKind
  OR NEW.planRevision <> OLD.planRevision
  OR NEW.permittedAction <> OLD.permittedAction
  OR NEW.riskClass <> OLD.riskClass
  OR NEW.requestKey <> OLD.requestKey
  OR IFNULL(NEW.taskRevision, -1) <> IFNULL(OLD.taskRevision, -1)
BEGIN
  SELECT RAISE(ABORT, 'approval_request: the question is immutable; only its resolution may be written');
END;

CREATE TRIGGER approval_request_no_delete
BEFORE DELETE ON approval_request
BEGIN
  SELECT RAISE(ABORT, 'approval_request is history: a request is resolved or invalidated, never deleted');
END;
