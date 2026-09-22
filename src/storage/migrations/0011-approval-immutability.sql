-- 0011 — an `approval` is a record, at the database level too (issue #55).
--
-- `src/storage/repos/index.ts` already refuses every patch but `invalidation`,
-- and `approvalInvalidReason` already refuses an approval pinned to a
-- superseded revision. Both of those are in *this process*. The Stage 4
-- adversarial suite found that nothing below them held: a raw
-- `UPDATE approval SET payload = ...` could re-pin a granted approval to the
-- task's new revision, and `DELETE FROM approval` could erase the record that
-- a permission was ever given.
--
-- `approval_request` (0009) already had exactly these triggers. `approval` —
-- the row that actually authorises the act — did not. This migration closes
-- that gap, with the same shape and for the same reason: an approval must
-- mean "this person agreed to *this* act at *these* revisions", and a row
-- that can be edited afterwards means nothing at all.
--
-- The scalar columns and the payload are both guarded, because the payload is
-- what the repositories read back; guarding only the columns would leave the
-- authoritative copy editable.

-- Identity and scope never change. Only `invalidated` (and the matching
-- `invalidation` inside the payload, plus `updatedAt`) may move.
CREATE TRIGGER approval_identity_immutable
BEFORE UPDATE ON approval
WHEN NEW.id <> OLD.id
  OR NEW.createdAt <> OLD.createdAt
  OR NEW.schemaVersion <> OLD.schemaVersion
  OR NEW.workflowId <> OLD.workflowId
  OR NEW.scopeKind <> OLD.scopeKind
  OR IFNULL(NEW.scopeTaskId, '') <> IFNULL(OLD.scopeTaskId, '')
  OR IFNULL(NEW.scopePhaseId, '') <> IFNULL(OLD.scopePhaseId, '')
  OR IFNULL(NEW.taskRevision, -1) <> IFNULL(OLD.taskRevision, -1)
  OR NEW.planRevision <> OLD.planRevision
  OR NEW.riskClass <> OLD.riskClass
BEGIN
  SELECT RAISE(ABORT, 'approval: scope, revisions and risk class are immutable; an approval is a record of what was agreed (PLAN §2.4, docs/records.md §4)');
END;

-- The payload carries the same facts and is what the repositories read, so it
-- is pinned field by field. `invalidation` is deliberately absent: moving it
-- from null to a reason is the one supported mutation.
CREATE TRIGGER approval_payload_immutable
BEFORE UPDATE ON approval
WHEN json_extract(NEW.payload, '$.id') <> json_extract(OLD.payload, '$.id')
  OR json_extract(NEW.payload, '$.createdAt') <> json_extract(OLD.payload, '$.createdAt')
  OR json_extract(NEW.payload, '$.workflowId') <> json_extract(OLD.payload, '$.workflowId')
  OR json_extract(NEW.payload, '$.permittedAction') <> json_extract(OLD.payload, '$.permittedAction')
  OR json_extract(NEW.payload, '$.riskClass') <> json_extract(OLD.payload, '$.riskClass')
  OR json_extract(NEW.payload, '$.planRevision') <> json_extract(OLD.payload, '$.planRevision')
  OR IFNULL(json_extract(NEW.payload, '$.taskRevision'), -1) <> IFNULL(json_extract(OLD.payload, '$.taskRevision'), -1)
  OR IFNULL(json_extract(NEW.payload, '$.expiresAt'), '') <> IFNULL(json_extract(OLD.payload, '$.expiresAt'), '')
  OR json_extract(NEW.payload, '$.actor.kind') <> json_extract(OLD.payload, '$.actor.kind')
  OR json_extract(NEW.payload, '$.actor.identity') <> json_extract(OLD.payload, '$.actor.identity')
  OR json_extract(NEW.payload, '$.scope.kind') <> json_extract(OLD.payload, '$.scope.kind')
BEGIN
  SELECT RAISE(ABORT, 'approval: the granted permission is immutable; only its invalidation may be written');
END;

-- An invalidation is final: a revoked or consumed approval never comes back.
CREATE TRIGGER approval_invalidation_is_final
BEFORE UPDATE ON approval
WHEN OLD.invalidated = 1 AND NEW.invalidated = 0
BEGIN
  SELECT RAISE(ABORT, 'approval: an invalidated approval is never revived; a repeat act needs a new approval');
END;

-- Deleting an approval would erase the evidence that permission was given (or
-- withdrawn). Approvals are history.
CREATE TRIGGER approval_no_delete
BEFORE DELETE ON approval
BEGIN
  SELECT RAISE(ABORT, 'approval is history: an approval is invalidated, never deleted');
END;
