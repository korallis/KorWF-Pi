/**
 * Revision-aware decision caching and invalidation (issue #29; PLAN §6
 * "Cache only with complete versioned keys; never reuse stale approvals or
 * revision-sensitive evidence").
 *
 * AC1: "Changing any key component produces a miss (one test per component)."
 * AC2: "Approval questions bypass the cache."
 */
import { describe, it, expect } from "vitest";
import {
  cacheKeyOf,
  cacheLookup,
  cacheStore,
  invalidateQuestion,
  isApprovalQuestion,
  type CacheConfig,
  type CacheKeyParts,
} from "../../../src/decisions/cache.ts";
import { DecisionCacheStore } from "../../../src/storage/decision-cache.ts";
import { DatabaseSync } from "../../../src/storage/sqlite.ts";
import { migrate } from "../../../src/storage/migrations.ts";
import { makeDecision } from "../../helpers/records.ts";
import type { Decision, DecisionId } from "../../../src/storage/records.ts";

const ENABLED: CacheConfig = { enabled: true, ttlSeconds: 0 };

function baseParts(): CacheKeyParts {
  return {
    questionId: "task.atomic",
    questionVersion: "1",
    contentHash: "hash-a",
    jevModelVersion: "jev-1.0.0",
    policyVersion: "1",
    stateHash: "state-a",
    repoRevision: "a".repeat(40),
  };
}

function memDeps() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.prepare(
    "INSERT INTO workflow (id, createdAt, updatedAt, schemaVersion, status, mode, planRevision, payload) " +
      "VALUES ('wf-1', 'x', 'x', 1, 'planning', 'supervised', 1, '{}')",
  ).run();
  const cache = new DecisionCacheStore(db);
  const decisions = new Map<string, Decision>();
  return {
    db,
    cache,
    decisions: { get: (id: string) => decisions.get(id) },
    // The `decision` table has a real foreign key from `decision_cache`
    // (0003-decision-cache.sql), so a cached-at row must also exist in the
    // `decision` table itself, not only in the in-memory lookup map.
    put: (d: Decision) => {
      decisions.set(d.id, d);
      db.prepare(
        "INSERT INTO decision (id, createdAt, updatedAt, schemaVersion, workflowId, subjectTaskId, subjectPhaseId, stateHash, questionId, questionVersion, payload) " +
          "VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, '{}')",
      ).run(d.id, d.createdAt, d.updatedAt, d.schemaVersion, d.workflowId, d.stateHash, d.questionId, d.questionVersion);
    },
  };
}

describe("cacheKeyOf: the complete versioned key", () => {
  it("is stable for identical parts", () => {
    expect(cacheKeyOf(baseParts(), true)).toBe(cacheKeyOf(baseParts(), true));
  });

  it("folds in repoRevision only when the question is revisionSensitive", () => {
    const insensitive = cacheKeyOf(baseParts(), false);
    const withOtherRevision = cacheKeyOf({ ...baseParts(), repoRevision: "b".repeat(40) }, false);
    expect(insensitive).toBe(withOtherRevision);

    const sensitiveA = cacheKeyOf(baseParts(), true);
    const sensitiveB = cacheKeyOf({ ...baseParts(), repoRevision: "b".repeat(40) }, true);
    expect(sensitiveA).not.toBe(sensitiveB);
  });
});

describe("AC1: changing any key component produces a miss (one test per component)", () => {
  function put(deps: ReturnType<typeof memDeps>, parts: CacheKeyParts, decisionId: string) {
    const decision = makeDecision({ id: decisionId as DecisionId, questionId: parts.questionId, questionVersion: parts.questionVersion });
    deps.put(decision);
    cacheStore(deps, { id: parts.questionId, revisionSensitive: true }, parts, decision, ENABLED);
    return decision;
  }

  function lookup(deps: ReturnType<typeof memDeps>, parts: CacheKeyParts) {
    return cacheLookup(deps, { id: parts.questionId, revisionSensitive: true }, parts, ENABLED);
  }

  it("hits on an exact repeat", () => {
    const deps = memDeps();
    const decision = put(deps, baseParts(), "dc-hit");
    expect(lookup(deps, baseParts())?.id).toBe(decision.id);
  });

  it("questionId change misses", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), questionId: "task.other" })).toBeNull();
  });

  it("questionVersion change misses", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), questionVersion: "2" })).toBeNull();
  });

  it("contentHash change misses (wording changed)", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), contentHash: "hash-b" })).toBeNull();
  });

  it("jevModelVersion change misses", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), jevModelVersion: "jev-2.0.0" })).toBeNull();
  });

  it("a fallback answer (jevModelVersion null) is never served as a Jev-model hit", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), jevModelVersion: null })).toBeNull();
  });

  it("policyVersion change misses", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), policyVersion: "2" })).toBeNull();
  });

  it("stateHash change misses", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), stateHash: "state-b" })).toBeNull();
  });

  it("repoRevision change misses for a revision-sensitive question (revision boundary)", () => {
    const deps = memDeps();
    put(deps, baseParts(), "dc-1");
    expect(lookup(deps, { ...baseParts(), repoRevision: "c".repeat(40) })).toBeNull();
  });
});

describe("AC2: approval questions bypass the cache", () => {
  it("isApprovalQuestion recognises the approval.* family", () => {
    expect(isApprovalQuestion("approval.grant")).toBe(true);
    expect(isApprovalQuestion("approval")).toBe(true);
    expect(isApprovalQuestion("task.atomic")).toBe(false);
  });

  it("cacheStore never writes a row for an approval question", () => {
    const deps = memDeps();
    const parts: CacheKeyParts = { ...baseParts(), questionId: "approval.grant" };
    const decision = makeDecision({ id: "dc-appr" as DecisionId, questionId: parts.questionId, questionVersion: parts.questionVersion });
    deps.put(decision);
    cacheStore(deps, { id: parts.questionId, revisionSensitive: true }, parts, decision, ENABLED);
    expect(deps.cache.count()).toBe(0);
  });

  it("cacheLookup always misses for an approval question, even if a row exists under its key", () => {
    const deps = memDeps();
    const parts: CacheKeyParts = { ...baseParts(), questionId: "approval.grant" };
    deps.put(makeDecision({ id: "dc-1" as DecisionId, questionId: parts.questionId, questionVersion: parts.questionVersion }));
    // Insert a row directly, bypassing the bypass, to prove lookup refuses it too.
    deps.cache.put({
      cacheKey: cacheKeyOf(parts, true),
      questionId: parts.questionId,
      questionVersion: parts.questionVersion,
      decisionId: "dc-1" as DecisionId,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
    expect(cacheLookup(deps, { id: parts.questionId, revisionSensitive: true }, parts, ENABLED)).toBeNull();
  });
});

describe("cache disabled", () => {
  it("cacheStore writes nothing and cacheLookup always misses", () => {
    const deps = memDeps();
    const disabled: CacheConfig = { enabled: false, ttlSeconds: 0 };
    const parts = baseParts();
    const decision = makeDecision({ id: "dc-1" as DecisionId, questionId: parts.questionId, questionVersion: parts.questionVersion });
    deps.put(decision);
    cacheStore(deps, { id: parts.questionId, revisionSensitive: true }, parts, decision, disabled);
    expect(deps.cache.count()).toBe(0);
    expect(cacheLookup(deps, { id: parts.questionId, revisionSensitive: true }, parts, disabled)).toBeNull();
  });
});

describe("TTL expiry", () => {
  it("a row past its TTL is a miss", () => {
    const deps = memDeps();
    const parts = baseParts();
    const decision = makeDecision({ id: "dc-1" as DecisionId, questionId: parts.questionId, questionVersion: parts.questionVersion });
    deps.put(decision);
    let now = "2026-01-01T00:00:00.000Z";
    const depsWithClock = { ...deps, now: () => now };
    const withTtl: CacheConfig = { enabled: true, ttlSeconds: 10 };
    cacheStore(depsWithClock, { id: parts.questionId, revisionSensitive: true }, parts, decision, withTtl);
    expect(cacheLookup(depsWithClock, { id: parts.questionId, revisionSensitive: true }, parts, withTtl)?.id).toBe(decision.id);
    now = "2026-01-01T00:00:11.000Z"; // 11s later, past the 10s TTL
    expect(cacheLookup(depsWithClock, { id: parts.questionId, revisionSensitive: true }, parts, withTtl)).toBeNull();
  });

  it("ttlSeconds 0 never expires by time", () => {
    const deps = memDeps();
    const parts = baseParts();
    const decision = makeDecision({ id: "dc-1" as DecisionId, questionId: parts.questionId, questionVersion: parts.questionVersion });
    deps.put(decision);
    cacheStore(deps, { id: parts.questionId, revisionSensitive: true }, parts, decision, ENABLED);
    const row = deps.cache.get(cacheKeyOf(parts, true));
    expect(row?.expiresAt).toBeNull();
  });
});

describe("invalidateQuestion", () => {
  it("removes every cached row for a question id, across versions", () => {
    const deps = memDeps();
    const v1 = { ...baseParts(), questionVersion: "1" };
    const v2 = { ...baseParts(), questionVersion: "2" };
    const d1 = makeDecision({ id: "dc-1" as DecisionId, questionId: v1.questionId, questionVersion: "1" });
    const d2 = makeDecision({ id: "dc-2" as DecisionId, questionId: v2.questionId, questionVersion: "2" });
    deps.put(d1);
    deps.put(d2);
    cacheStore(deps, { id: v1.questionId, revisionSensitive: true }, v1, d1, ENABLED);
    cacheStore(deps, { id: v2.questionId, revisionSensitive: true }, v2, d2, ENABLED);
    expect(deps.cache.count()).toBe(2);
    const removed = invalidateQuestion(deps, v1.questionId);
    expect(removed).toBe(2);
    expect(deps.cache.count()).toBe(0);
  });
});

describe("revision-insensitive questions ignore repoRevision entirely", () => {
  it("a hit survives a repoRevision change when revisionSensitive is false", () => {
    const deps = memDeps();
    const parts = baseParts();
    const decision = makeDecision({ id: "dc-1" as DecisionId, questionId: parts.questionId, questionVersion: parts.questionVersion });
    deps.put(decision);
    cacheStore(deps, { id: parts.questionId, revisionSensitive: false }, parts, decision, ENABLED);
    const later = { ...parts, repoRevision: "f".repeat(40) };
    expect(cacheLookup(deps, { id: parts.questionId, revisionSensitive: false }, later, ENABLED)?.id).toBe(decision.id);
  });
});
