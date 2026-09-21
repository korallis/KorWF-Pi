-- 0002-ledger: usage accounting and atomic budget reservations (issue #30).
--
-- One append-only table. Every Jev call and model call appends a
-- `reservation` row before it runs and exactly one terminal row afterwards
-- (`settlement`, `release`, or `abandonment`). Nothing is ever updated, so
-- the ledger is a replayable history rather than a mutable counter that a
-- crash could leave wrong.
--
-- The amounts are real columns (not only JSON `payload`) because budget
-- enforcement sums them inside the same `BEGIN IMMEDIATE` transaction that
-- inserts the new reservation — the check and the insert are one atomic step,
-- so two concurrent workers can never both pass the same remaining budget.
--
-- `spendUsd` is NULL exactly when `costBasis = 'unknown'`: a model with zero
-- or absent cost metadata is unknown, never silently zero (PLAN §3.I
-- "actual/estimated/unknown cost tracked explicitly"). The CHECK constraints
-- below make that unrepresentable rather than merely discouraged.

CREATE TABLE ledger_entry (
  id             TEXT    PRIMARY KEY,
  createdAt      TEXT    NOT NULL,
  updatedAt      TEXT    NOT NULL,
  schemaVersion  INTEGER NOT NULL,
  workflowId     TEXT    NOT NULL REFERENCES workflow(id) ON DELETE RESTRICT,
  phaseId        TEXT    REFERENCES phase(id) ON DELETE RESTRICT,
  taskId         TEXT    REFERENCES task(id) ON DELETE RESTRICT,
  attemptId      TEXT    REFERENCES attempt(id) ON DELETE RESTRICT,
  channel        TEXT    NOT NULL CHECK (channel IN ('model', 'jev')),
  entryKind      TEXT    NOT NULL CHECK (entryKind IN ('reservation', 'settlement', 'release', 'abandonment')),
  -- Every row points at the reservation it belongs to; a reservation points
  -- at itself, so one reservation's life is `WHERE reservationId = ?`.
  reservationId  TEXT    NOT NULL,
  sessionId      TEXT    NOT NULL,
  requests       INTEGER NOT NULL CHECK (requests >= 0),
  inputTokens    INTEGER CHECK (inputTokens IS NULL OR inputTokens >= 0),
  outputTokens   INTEGER CHECK (outputTokens IS NULL OR outputTokens >= 0),
  spendUsd       REAL    CHECK (spendUsd IS NULL OR spendUsd >= 0),
  costBasis      TEXT    NOT NULL CHECK (costBasis IN ('known', 'estimated', 'unknown')),
  elapsedMs      INTEGER NOT NULL CHECK (elapsedMs >= 0),
  payload        TEXT    NOT NULL,
  -- Honest cost: unknown carries no dollar figure, and a dollar figure is
  -- never labelled unknown.
  CHECK ((costBasis = 'unknown' AND spendUsd IS NULL) OR (costBasis <> 'unknown' AND spendUsd IS NOT NULL))
);

-- Budget enforcement scans by scope; reconciliation scans open reservations.
CREATE INDEX ledger_by_workflow ON ledger_entry(workflowId, channel, entryKind);
CREATE INDEX ledger_by_phase ON ledger_entry(phaseId, entryKind);
CREATE INDEX ledger_by_task ON ledger_entry(taskId, entryKind);
CREATE INDEX ledger_by_attempt ON ledger_entry(attemptId, entryKind);
CREATE INDEX ledger_by_reservation ON ledger_entry(reservationId, entryKind);

-- ADR 0006 rule 5: append-only in the database too, so no connection can
-- rewrite history to make a budget look unspent.
CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'ledger_entry is append-only'); END;
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'ledger_entry is append-only'); END;

-- A reservation is terminated exactly once: a second terminal row for the
-- same reservation is rejected by the database, not only by application code.
CREATE UNIQUE INDEX ledger_one_terminal_per_reservation
  ON ledger_entry(reservationId) WHERE entryKind <> 'reservation';
