-- 0007-gate-receipts: the task/phase gate receipt log (issue #46; PLAN §2.4,
-- docs/gates.md §7 "Rejection, audit and non-bypassability").
--
-- A gate receipt is the *only* authority that may move `Task.status` to
-- `done`. docs/gates.md §7 guarantee 1: "`Task.status → done` ... written only
-- inside `task-done` ... The store rejects any patch to these fields that does
-- not carry a gate receipt whose `inputHash` matches
-- (`status_write_forbidden`)." That sentence is enforced in
-- `src/storage/repos/index.ts` (`TaskRepository.beforeUpdate`) against the rows
-- in this table, so a worker tool call, a `/korwf` command, a raw store patch,
-- a resumed session or a migration all hit the same wall.
--
-- Every evaluation is recorded, pass or reject, because a refusal has to be as
-- visible as a success: `/korwf why` answers "which condition failed" from
-- `reasonCode`/`detail` here rather than from a log line.
--
-- Like `transition_event` and `completed_action` this is not a PLAN §5 record:
-- a receipt has no revisioned identity. The single permitted mutation is
-- stamping `consumedAt`, which is what makes a receipt **single use**: the same
-- pass cannot certify two status writes.

CREATE TABLE gate_receipt (
  receiptId       TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  gate            TEXT    NOT NULL CHECK (gate IN ('task', 'phase')),
  subjectId       TEXT    NOT NULL,
  -- `Task.revision` for a task gate, `Workflow.planRevision` for a phase gate.
  subjectRevision INTEGER NOT NULL,
  -- Exact Git SHA the gate was evaluated at, read by src/git/ at evaluation
  -- time. Never supplied by a worker (docs/gates.md §1, §2).
  revision        TEXT    NOT NULL,
  disposition     TEXT    NOT NULL CHECK (disposition IN ('pass', 'reject')),
  -- Closed-set reason code from docs/gates.md §7; NULL exactly when passing.
  reasonCode      TEXT,
  detail          TEXT,
  -- Hash of the exact gate input. A receipt authorises a status write only
  -- while the input that produced it is still the current one.
  inputHash       TEXT    NOT NULL,
  evaluatedAt     TEXT    NOT NULL,
  -- Set once, when the receipt authorised a status write. Single use.
  consumedAt      TEXT,
  payload         TEXT    NOT NULL,
  CHECK ((disposition = 'pass') = (reasonCode IS NULL)),
  CHECK (disposition = 'pass' OR consumedAt IS NULL)
);

CREATE INDEX gate_receipt_by_subject ON gate_receipt(gate, subjectId, evaluatedAt);
CREATE INDEX gate_receipt_by_input ON gate_receipt(inputHash);

CREATE TRIGGER gate_receipt_no_delete
BEFORE DELETE ON gate_receipt
BEGIN
  SELECT RAISE(ABORT, 'gate_receipt is append-only: deleting a receipt would erase a gate decision');
END;

-- The only legal update is NULL -> non-NULL `consumedAt`. Everything else,
-- including re-consuming a receipt or editing a reason code after the fact,
-- aborts: a receipt is a fact about one evaluation.
CREATE TRIGGER gate_receipt_consume_only
BEFORE UPDATE ON gate_receipt
WHEN NOT (
  OLD.consumedAt IS NULL AND NEW.consumedAt IS NOT NULL
  AND NEW.receiptId = OLD.receiptId AND NEW.createdAt = OLD.createdAt
  AND NEW.workflowId = OLD.workflowId AND NEW.gate = OLD.gate
  AND NEW.subjectId = OLD.subjectId AND NEW.subjectRevision = OLD.subjectRevision
  AND NEW.revision = OLD.revision AND NEW.disposition = OLD.disposition
  AND NEW.inputHash = OLD.inputHash AND NEW.evaluatedAt = OLD.evaluatedAt
  AND NEW.payload = OLD.payload
)
BEGIN
  SELECT RAISE(ABORT, 'gate_receipt: the only permitted update is stamping consumedAt once');
END;
