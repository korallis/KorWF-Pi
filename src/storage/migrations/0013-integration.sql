-- 0013-integration: the single-owner integration queue (issue #78; PLAN §3.E
-- "one integration owner; never concurrent uncontrolled integration into the
-- user's tree").
--
-- The queue is durable rather than in-process for the same reason the
-- coordinator lock is a file: two tasks can finish in two different worker
-- processes, and an in-memory list is invisible to the other one. A row here
-- is a task's *request* to be integrated; it is never an authorisation to
-- merge, and never a statement that the work is still valid — `baseRevision`
-- and `verifiedRevision` are recorded precisely so a later integrator can
-- discover that the base moved and refuse.
--
-- `status` is the one mutable column (plus its resolution detail), and the
-- trigger below pins the rest: an item's identity, task, branch and recorded
-- revisions never change after enqueue. Re-verifying a task produces a NEW
-- item at the new revision rather than a rewrite of the old one, so the
-- history says that an integration was refused as stale and then retried.
--
-- Not a PLAN §5 record: no revisioned identity, no repository class.

CREATE TABLE integration_item (
  itemId            TEXT    PRIMARY KEY,
  enqueuedAt        TEXT    NOT NULL,
  workflowId        TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  phaseId           TEXT    NOT NULL,
  taskId            TEXT    NOT NULL,
  taskRevision      INTEGER NOT NULL,
  branch            TEXT    NOT NULL,
  -- Revision the task worktree was created from (its integration base).
  baseRevision      TEXT    NOT NULL,
  -- Exact revision the task's evidence was captured at (#45).
  verifiedRevision  TEXT    NOT NULL,
  -- queued | integrating | integrated | conflicted | stale_base | failed | cancelled
  status            TEXT    NOT NULL,
  detail            TEXT,
  payload           TEXT    NOT NULL
);

-- FIFO order is (enqueuedAt, rowid): two items enqueued in the same
-- millisecond still have a total order, so "first come, first integrated" is
-- well defined even when two workers finish simultaneously.
CREATE INDEX integration_item_queue ON integration_item(phaseId, status, enqueuedAt);
CREATE INDEX integration_item_by_task ON integration_item(taskId, enqueuedAt);

-- One task may not have two live claims on the integrator at once.
CREATE UNIQUE INDEX integration_item_one_active_per_task
  ON integration_item(taskId)
  WHERE status IN ('queued', 'integrating');

CREATE TRIGGER integration_item_immutable_identity
BEFORE UPDATE ON integration_item
WHEN OLD.itemId <> NEW.itemId
  OR OLD.workflowId <> NEW.workflowId
  OR OLD.phaseId <> NEW.phaseId
  OR OLD.taskId <> NEW.taskId
  OR OLD.taskRevision <> NEW.taskRevision
  OR OLD.branch <> NEW.branch
  OR OLD.baseRevision <> NEW.baseRevision
  OR OLD.verifiedRevision <> NEW.verifiedRevision
  OR OLD.enqueuedAt <> NEW.enqueuedAt
BEGIN
  SELECT RAISE(ABORT, 'integration_item identity and recorded revisions are immutable: re-verification enqueues a new item');
END;

CREATE TRIGGER integration_item_no_delete
BEFORE DELETE ON integration_item
BEGIN
  SELECT RAISE(ABORT, 'integration_item is append-only: a refused or conflicted integration stays visible');
END;

-- A conflict resolution task created for a conflicted item. Its ownership is
-- restricted to the conflicted paths, and it carries the re-verification
-- requirement: an item may only be integrated after a resolution that was
-- itself verified, never on the resolver's say-so.
CREATE TABLE integration_conflict (
  conflictId     TEXT    PRIMARY KEY,
  createdAt      TEXT    NOT NULL,
  workflowId     TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  itemId         TEXT    NOT NULL REFERENCES integration_item(itemId),
  taskId         TEXT    NOT NULL,
  -- JSON array of repository-relative paths git reported as unmerged.
  paths          TEXT    NOT NULL,
  -- Task created to resolve it, when one was created; NULL when the phase
  -- was blocked without one (no resolver available).
  resolutionTaskId TEXT,
  -- open | resolved | unresolved
  status         TEXT    NOT NULL,
  resolvedAt     TEXT,
  detail         TEXT,
  payload        TEXT    NOT NULL
);

CREATE INDEX integration_conflict_by_item ON integration_conflict(itemId, createdAt);

CREATE TRIGGER integration_conflict_no_delete
BEFORE DELETE ON integration_conflict
BEGIN
  SELECT RAISE(ABORT, 'integration_conflict is append-only: a conflict that happened stays recorded');
END;
