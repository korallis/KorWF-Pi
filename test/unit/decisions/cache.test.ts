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
