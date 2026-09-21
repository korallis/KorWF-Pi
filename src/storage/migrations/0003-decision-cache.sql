-- 0003-decision-cache: revision-aware Jev decision cache (issue #29; PLAN §6
-- "cache only with complete versioned keys; never reuse stale approvals or
-- revision-sensitive evidence").
--
-- This is a *cache*, not a record: it holds no independent truth. Every row
-- points at the `decision` row that is the answer, so a cache hit is exactly
-- "replay this previously recorded Decision" (docs/records.md §10 rule 4).
-- Unlike the append-only tables, a cache row may be overwritten or deleted —
-- there is no provenance obligation for a cache, only for the Decision it
-- points at, which remains untouched.
--
-- `cacheKey` is the complete versioned key computed by
-- `src/decisions/cache.ts#cacheKeyOf`: sha256 over
-- { questionId, questionVersion, contentHash, jevModelVersion, policyVersion,
--   stateHash, repoRevision }. Any change to any of those fields is a
-- different key, so a stale value can never be looked up by a fresh one.

CREATE TABLE decision_cache (
  cacheKey        TEXT    PRIMARY KEY,
  questionId      TEXT    NOT NULL,
  questionVersion TEXT    NOT NULL,
  decisionId      TEXT    NOT NULL REFERENCES decision(id) ON DELETE RESTRICT,
  createdAt       TEXT    NOT NULL,
  -- NULL = never expires by time (still invalidated by any key change).
  expiresAt       TEXT
);

CREATE INDEX decision_cache_by_decision ON decision_cache(decisionId);
CREATE INDEX decision_cache_by_question ON decision_cache(questionId, questionVersion);
