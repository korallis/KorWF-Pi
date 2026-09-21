-- 0001-initial: the eleven record tables of docs/records.md at
-- RECORDS_SCHEMA_VERSION = 1, plus the migration ledger and the append-only
-- triggers required by ADR 0006 rule 5.
--
-- Storage shape (the choice docs/records.md §11 left to #23): each table has
-- the record envelope as real columns, the fields that are joined on,
-- filtered on, or constrained by a foreign key as real columns, and the whole
-- record as a single JSON `payload` column. Nested foreign keys named `a.b`
-- in docs/records.md §9 are promoted to real columns here (for example
-- `decision.subjectTaskId`), so SQLite enforces them rather than application
-- code.
--
-- `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON` are set by the
-- runner on every connection: journal mode cannot be changed inside a
-- transaction, and `foreign_keys` is a per-connection pragma.

CREATE TABLE schema_migration (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  checksum    TEXT    NOT NULL,
  appliedAt   TEXT    NOT NULL
);

CREATE TABLE workflow (
  id             TEXT    PRIMARY KEY,
  createdAt      TEXT    NOT NULL,
  updatedAt      TEXT    NOT NULL,
  schemaVersion  INTEGER NOT NULL,
  status         TEXT    NOT NULL,
  mode           TEXT    NOT NULL,
  planRevision   INTEGER NOT NULL,
  payload        TEXT    NOT NULL
);

CREATE TABLE phase (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  "order"         INTEGER NOT NULL,
  gateStatus      TEXT    NOT NULL,
  payload         TEXT    NOT NULL
);
CREATE INDEX phase_by_workflow ON phase(workflowId, "order");

CREATE TABLE task (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  phaseId         TEXT    NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL,
  status          TEXT    NOT NULL,
  riskClass       TEXT    NOT NULL,
  payload         TEXT    NOT NULL
);
CREATE INDEX task_by_phase ON task(phaseId, status);
CREATE INDEX task_by_workflow ON task(workflowId, status);

CREATE TABLE attempt (
  id                      TEXT    PRIMARY KEY,
  createdAt               TEXT    NOT NULL,
  updatedAt               TEXT    NOT NULL,
  schemaVersion           INTEGER NOT NULL,
  taskId                  TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  taskRevision            INTEGER NOT NULL,
  workerId                TEXT    NOT NULL,
  role                    TEXT    NOT NULL,
  outcome                 TEXT,
  handedOffFromAttemptId  TEXT    REFERENCES attempt(id) ON DELETE SET NULL,
  payload                 TEXT    NOT NULL
);
CREATE INDEX attempt_by_task ON attempt(taskId, outcome);
-- Startup reconciliation (ADR 0006 rule 7) scans exactly this set.
CREATE INDEX attempt_open ON attempt(outcome) WHERE outcome IS NULL;

CREATE TABLE decision (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE RESTRICT,
  subjectTaskId   TEXT    REFERENCES task(id) ON DELETE RESTRICT,
  subjectPhaseId  TEXT    REFERENCES phase(id) ON DELETE RESTRICT,
  stateHash       TEXT    NOT NULL,
  questionId      TEXT    NOT NULL,
  questionVersion TEXT    NOT NULL,
  payload         TEXT    NOT NULL
);
CREATE INDEX decision_by_state ON decision(questionId, stateHash);
CREATE INDEX decision_by_workflow ON decision(workflowId, createdAt);

CREATE TABLE evidence (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE RESTRICT,
  taskId          TEXT    NOT NULL REFERENCES task(id) ON DELETE RESTRICT,
  taskRevision    INTEGER NOT NULL,
  attemptId       TEXT    REFERENCES attempt(id) ON DELETE RESTRICT,
  supersedesId    TEXT    REFERENCES evidence(id) ON DELETE RESTRICT,
  requirementId   TEXT    NOT NULL,
  checkId         TEXT,
  payload         TEXT    NOT NULL
);
CREATE INDEX evidence_by_task ON evidence(taskId, taskRevision);

CREATE TABLE approval (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  scopeKind       TEXT    NOT NULL,
  scopeTaskId     TEXT    REFERENCES task(id) ON DELETE CASCADE,
  scopePhaseId    TEXT    REFERENCES phase(id) ON DELETE CASCADE,
  taskRevision    INTEGER,
  planRevision    INTEGER NOT NULL,
  riskClass       TEXT    NOT NULL,
  invalidated     INTEGER NOT NULL DEFAULT 0,
  payload         TEXT    NOT NULL
);
CREATE INDEX approval_by_workflow ON approval(workflowId, scopeKind, invalidated);

CREATE TABLE memory (
  id               TEXT    PRIMARY KEY,
  createdAt        TEXT    NOT NULL,
  updatedAt        TEXT    NOT NULL,
  schemaVersion    INTEGER NOT NULL,
  workflowId       TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  sourceAttemptId  TEXT    REFERENCES attempt(id) ON DELETE SET NULL,
  sourceDecisionId TEXT    REFERENCES decision(id) ON DELETE RESTRICT,
  supersededById   TEXT    REFERENCES memory(id) ON DELETE SET NULL,
  supersedesId     TEXT    REFERENCES memory(id) ON DELETE SET NULL,
  type             TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  pinned           INTEGER NOT NULL,
  payload          TEXT    NOT NULL
);
CREATE INDEX memory_by_workflow ON memory(workflowId, status, pinned);

-- One row per route, not per model id (#125): the upsert key is routeId.
CREATE TABLE model_availability (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  routeId         TEXT    NOT NULL UNIQUE,
  providerId      TEXT    NOT NULL,
  modelId         TEXT    NOT NULL,
  capKind         TEXT    NOT NULL,
  payload         TEXT    NOT NULL
);
CREATE INDEX model_availability_by_model ON model_availability(modelId, capKind);

CREATE TABLE model_outcome (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  workflowId      TEXT    NOT NULL REFERENCES workflow(id) ON DELETE RESTRICT,
  attemptId       TEXT    NOT NULL REFERENCES attempt(id) ON DELETE RESTRICT,
  routeId         TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  result          TEXT    NOT NULL,
  payload         TEXT    NOT NULL
);
CREATE INDEX model_outcome_by_route ON model_outcome(routeId, result);

CREATE TABLE audit_entry (
  id              TEXT    PRIMARY KEY,
  createdAt       TEXT    NOT NULL,
  updatedAt       TEXT    NOT NULL,
  schemaVersion   INTEGER NOT NULL,
  workflowId      TEXT    REFERENCES workflow(id) ON DELETE RESTRICT,
  tableName       TEXT    NOT NULL,
  recordId        TEXT    NOT NULL,
  operation       TEXT    NOT NULL,
  actor           TEXT    NOT NULL,
  payload         TEXT    NOT NULL
);
CREATE INDEX audit_by_record ON audit_entry(tableName, recordId, createdAt);
CREATE INDEX audit_by_time ON audit_entry(createdAt);

-- ADR 0006 rule 5: append-only enforced a second time, in the database, so a
-- statement issued by any connection (including a future daemon or a repair
-- script) is aborted. Corrections are new rows (`supersedesId`).
CREATE TRIGGER decision_no_update BEFORE UPDATE ON decision
BEGIN SELECT RAISE(ABORT, 'decision is append-only'); END;
CREATE TRIGGER decision_no_delete BEFORE DELETE ON decision
BEGIN SELECT RAISE(ABORT, 'decision is append-only'); END;

CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;

CREATE TRIGGER model_outcome_no_update BEFORE UPDATE ON model_outcome
BEGIN SELECT RAISE(ABORT, 'model_outcome is append-only'); END;
CREATE TRIGGER model_outcome_no_delete BEFORE DELETE ON model_outcome
BEGIN SELECT RAISE(ABORT, 'model_outcome is append-only'); END;

CREATE TRIGGER audit_entry_no_update BEFORE UPDATE ON audit_entry
BEGIN SELECT RAISE(ABORT, 'audit_entry is append-only'); END;
CREATE TRIGGER audit_entry_no_delete BEFORE DELETE ON audit_entry
BEGIN SELECT RAISE(ABORT, 'audit_entry is append-only'); END;
