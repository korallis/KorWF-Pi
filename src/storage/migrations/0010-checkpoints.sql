-- 0010-checkpoints: checkpoints and rollback proposals (issue #54; PLAN §3.G
-- "Checkpoints and approval policy for rollback; preserve uncommitted user
-- work"; PLAN §10 "dirty user changes preserved").
--
-- Two append-only tables.
--
-- `checkpoint` is the durable half of ADR 0001 row 5's criticism of the Pi
-- example: that example kept stash refs in an in-memory Map cleared after
-- every agent run and lost on reload, so a checkpoint could not survive the
-- session that took it. A checkpoint here is a row keyed by attempt and task,
-- naming a commit and a ref under `refs/korwf/checkpoints/`, with the
-- working-tree state it captured recorded alongside it.
--
-- `rollback_proposal` is the reason this issue is risk:high. A rollback is a
-- *proposal*: a row that says what would change and what would be lost, which
-- can only become an act when a `destructive_git` approval record exists for
-- it. The `approvalId` column is NULL until then, and the trigger below
-- refuses to mark a proposal `applied` while it is NULL. So "rollback without
-- approval" is not merely refused by a code path that a future caller might
-- forget to call; it is refused by the database.
--
-- Neither table is a PLAN §5 record: neither has a revisioned identity and
-- neither is rewritten except for the one-shot resolution of a proposal.

CREATE TABLE checkpoint (
  checkpointId   TEXT    PRIMARY KEY,
  createdAt      TEXT    NOT NULL,
  workflowId     TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  -- Attempt this checkpoint was tagged with (issue #54 Scope: "tagged with
  -- attempt id"). NULL only for a workflow-level manual checkpoint.
  attemptId      TEXT,
  taskId         TEXT,
  -- pre_attempt | post_step | pre_rollback_preservation | manual
  kind           TEXT    NOT NULL,
  -- Absolute path of the worktree captured, as git reported its toplevel.
  worktreePath   TEXT    NOT NULL,
  -- `--git-common-dir`: identical for the main tree and its linked worktrees.
  repoCommonDir  TEXT    NOT NULL,
  -- 1 when this checkpoint captured the user's main tree rather than a task
  -- worktree. A checkpoint of the main tree may be taken; it may never be
  -- restored (src/workflow/checkpoint.ts refuses).
  isMainTree     INTEGER NOT NULL CHECK (isMainTree IN (0, 1)),
  ref            TEXT    NOT NULL,
  commitSha      TEXT    NOT NULL,
  treeSha        TEXT    NOT NULL,
  parentCommit   TEXT,
  branch         TEXT,
  -- 1 when the tree had uncommitted changes at capture time.
  dirty          INTEGER NOT NULL CHECK (dirty IN (0, 1)),
  changedPaths   INTEGER NOT NULL,
  summary        TEXT    NOT NULL,
  payload        TEXT    NOT NULL
);

CREATE INDEX checkpoint_by_workflow ON checkpoint(workflowId, createdAt);
CREATE INDEX checkpoint_by_attempt ON checkpoint(attemptId, createdAt);
CREATE INDEX checkpoint_by_task ON checkpoint(taskId, createdAt);

CREATE TRIGGER checkpoint_no_update
BEFORE UPDATE ON checkpoint
BEGIN
  SELECT RAISE(ABORT, 'checkpoint is append-only: a checkpoint describes a moment that already happened');
END;

CREATE TRIGGER checkpoint_no_delete
BEFORE DELETE ON checkpoint
BEGIN
  SELECT RAISE(ABORT, 'checkpoint is append-only: deleting the record would orphan recoverable user work');
END;

CREATE TABLE rollback_proposal (
  proposalId      TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  checkpointId    TEXT    NOT NULL REFERENCES checkpoint(checkpointId),
  taskId          TEXT,
  attemptId       TEXT,
  -- Worktree the restore would act on, and the proof it is not the main tree.
  worktreePath    TEXT    NOT NULL,
  targetIsMainTree INTEGER NOT NULL CHECK (targetIsMainTree IN (0, 1)),
  -- Human-readable diff summary and the inventory of what would be lost.
  diffSummary     TEXT    NOT NULL,
  wouldLoseCount  INTEGER NOT NULL,
  -- 1 when the target tree has uncommitted work the restore would discard.
  wouldLoseUncommitted INTEGER NOT NULL CHECK (wouldLoseUncommitted IN (0, 1)),
  -- Idempotency key (#42 `actionIdFor`) for the restore this proposal would
  -- perform. Its receipt in `completed_action` is what refuses a replay.
  actionId        TEXT    NOT NULL,
  -- Approval class; pinned to the high-risk class in code.
  classId         TEXT    NOT NULL,
  -- The queued question (approval_request) and, once answered, the Approval.
  requestId       TEXT,
  approvalId      TEXT,
  -- proposed | approved | applied | refused | superseded
  status          TEXT    NOT NULL CHECK (status IN ('proposed','approved','applied','refused','superseded')),
  resolvedAt      TEXT,
  -- Stable reason code when refused, e.g. 'no_approval', 'target_is_main_tree'.
  reasonCode      TEXT,
  detail          TEXT,
  payload         TEXT    NOT NULL
);

CREATE INDEX rollback_proposal_by_workflow ON rollback_proposal(workflowId, createdAt);
CREATE INDEX rollback_proposal_by_checkpoint ON rollback_proposal(checkpointId, createdAt);
CREATE UNIQUE INDEX rollback_proposal_action_applied
  ON rollback_proposal(actionId) WHERE status = 'applied';

-- A proposal may never be applied to the user's main tree, and may never be
-- applied without an approval record. Both are enforced here as well as in
-- src/workflow/checkpoint.ts, because "no Jev score or worker claim may
-- authorise data loss" must survive somebody calling the store directly.
CREATE TRIGGER rollback_proposal_requires_approval
BEFORE UPDATE OF status ON rollback_proposal
WHEN NEW.status = 'applied' AND (NEW.approvalId IS NULL OR NEW.approvalId = '')
BEGIN
  SELECT RAISE(ABORT, 'rollback_proposal cannot be applied without an approval record (PLAN §7 destructive_git)');
END;

CREATE TRIGGER rollback_proposal_never_main_tree
BEFORE UPDATE OF status ON rollback_proposal
WHEN NEW.status = 'applied' AND NEW.targetIsMainTree = 1
BEGIN
  SELECT RAISE(ABORT, 'rollback_proposal cannot be applied to the user main tree (PLAN §3.G preserve uncommitted user work)');
END;

CREATE TRIGGER rollback_proposal_resolve_once
BEFORE UPDATE OF status ON rollback_proposal
WHEN OLD.status NOT IN ('proposed', 'approved')
BEGIN
  SELECT RAISE(ABORT, 'rollback_proposal is single-use: it has already been resolved');
END;

CREATE TRIGGER rollback_proposal_no_delete
BEFORE DELETE ON rollback_proposal
BEGIN
  SELECT RAISE(ABORT, 'rollback_proposal is append-only: a proposed rollback is history');
END;
