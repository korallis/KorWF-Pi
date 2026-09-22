-- 0005-transitions: the runtime transition log and first-class blockers
-- (issue #41; docs/state-machine.md §1 "every accepted transition atomically
-- records …", §6 "append an immutable rejection event"; PLAN §5, §3.C).
--
-- Two tables, both deliberately *not* reusing `audit_entry`:
--
--  * `transition_event` records an attempted transition, accepted or
--    rejected. docs/state-machine.md §6 is explicit that "#12's ordinary
--    row-update audit must not be abused to pretend a rejected row was
--    updated": a rejected transition changes no row, so it has no
--    before/after row hash to report and cannot be expressed as an
--    `audit_entry` update without lying about what happened. An accepted
--    transition still writes its ordinary `audit_entry` row through the
--    repository; this table adds the transition-specific facts (edge id,
--    trigger, actor, guards, revisions, mode/policy, evidence refs).
--
--  * `blocker` makes a blocker first-class (#41 Scope). `Task.blocker` is a
--    single string; a task can be held by several independent reasons at
--    once (an unmet dependency *and* a withdrawn approval), and
--    docs/state-machine.md §5 requires that an already blocked subject
--    "stay so and accumulate the new reason". `Task.status = "blocked"` is
--    therefore derived from the unresolved rows here rather than set by a
--    caller.
--
-- Both tables are append-only with respect to history: transition events
-- cannot be updated or deleted at all, and a blocker row may only be
-- resolved once (resolution fields go from NULL to non-NULL, never back).

CREATE TABLE transition_event (
  eventId        TEXT    PRIMARY KEY,
  createdAt      TEXT    NOT NULL,
  workflowId     TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  subjectKind    TEXT    NOT NULL CHECK (subjectKind IN ('task', 'phase')),
  subjectId      TEXT    NOT NULL,
  -- State the subject was in when the request was evaluated.
  fromState      TEXT    NOT NULL,
  -- State the request asked for. Unchanged rows keep fromState = toState only
  -- for the two documented self-edges (task-stale-evidence, phase-stale-evidence).
  toState        TEXT    NOT NULL,
  -- `Transition.id` from src/workflow/transitions.ts, or NULL when no listed
  -- edge matched (an unlisted edge is itself the rejection reason).
  transitionId   TEXT,
  trigger        TEXT    NOT NULL,
  actorKind      TEXT    NOT NULL,
  actorIdentity  TEXT    NOT NULL,
  disposition    TEXT    NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
  -- Stable reason code; NULL exactly when accepted.
  reasonCode     TEXT,
  taskRevision   INTEGER,
  planRevision   INTEGER NOT NULL,
  gitRevision    TEXT,
  mode           TEXT    NOT NULL,
  policyVersion  TEXT    NOT NULL,
  -- JSON arrays: guard ids that were not satisfied, and sanitised evidence refs.
  failedGuards   TEXT    NOT NULL,
  evidenceRefs   TEXT    NOT NULL,
  -- Row hashes. Equal for a rejection: nothing changed, and that is the point.
  beforeHash     TEXT    NOT NULL,
  afterHash      TEXT    NOT NULL,
  payload        TEXT    NOT NULL
);

CREATE INDEX transition_event_by_subject ON transition_event(subjectKind, subjectId);
CREATE INDEX transition_event_by_workflow ON transition_event(workflowId, createdAt);
CREATE INDEX transition_event_by_disposition ON transition_event(disposition, createdAt);

CREATE TRIGGER transition_event_no_update
BEFORE UPDATE ON transition_event
BEGIN
  SELECT RAISE(ABORT, 'transition_event is append-only: record a new event instead');
END;

CREATE TRIGGER transition_event_no_delete
BEFORE DELETE ON transition_event
BEGIN
  SELECT RAISE(ABORT, 'transition_event is append-only: history is never deleted');
END;

CREATE TABLE blocker (
  blockerId        TEXT    PRIMARY KEY,
  createdAt        TEXT    NOT NULL,
  workflowId       TEXT    NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  subjectKind      TEXT    NOT NULL CHECK (subjectKind IN ('task', 'phase')),
  subjectId        TEXT    NOT NULL,
  kind             TEXT    NOT NULL,
  detail           TEXT    NOT NULL,
  raisedBy         TEXT    NOT NULL,
  resolvedAt       TEXT,
  resolvedBy       TEXT,
  resolutionDetail TEXT
);

CREATE INDEX blocker_by_subject ON blocker(subjectKind, subjectId, resolvedAt);
CREATE INDEX blocker_by_workflow ON blocker(workflowId, resolvedAt);

CREATE TRIGGER blocker_no_delete
BEFORE DELETE ON blocker
BEGIN
  SELECT RAISE(ABORT, 'blocker rows are resolved, never deleted: the reason is history');
END;

CREATE TRIGGER blocker_resolution_is_final
BEFORE UPDATE ON blocker
WHEN OLD.resolvedAt IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blocker is already resolved: raise a new blocker instead of reopening one');
END;
