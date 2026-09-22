/**
 * Tests for src/models/fallback.ts (issue #63; PLAN §3.D "Caps and fallback").
 *
 * AC: "All candidates capped → task paused(cap), phase paused, status shows
 *   earliest estimated reset."
 * AC: "Cap clears (fake clock) → auto-resume without user action."
 * AC: "Attempt record shows both models and the reason after a switch."
 */
import { describe, expect, it } from "vitest";
import {
  chooseFallback,
  earliestResetAmong,
  fallbackReasonFromCap,
  inDwell,
  isResumable,
  type FallbackAttemptView,
} from "../../src/models/fallback.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";
import { deriveRouteId } from "../../src/models/route.ts";
import { mergeCards } from "../../src/models/cards.ts";
import type { SelectionCandidate } from "../../src/models/select.ts";
import type { CatalogEntry } from "../../src/models/catalog.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";
import type { TaskProfile } from "../../src/storage/records.ts";
import { MockJevTransport } from "../../src/jev/mock.ts";
import type { AskContext } from "../../src/decisions/ask.ts";

const MODEL = "jev-test";
const T0 = "2026-01-01T00:00:00.000Z";

function entry(id: string, provider: string): CatalogEntry {
  return {
    id: `${provider}/${id}` as CatalogEntry["id"],
    provider,
    name: id,
    routeId: deriveRouteId(provider, id),
    reasoning: true,
    thinkingLevelMap: "unknown",
    input: ["text"],
    contextWindow: "unknown",
    maxTokens: "unknown",
    cost: "unknown",
  };
}

function candidate(id: string, provider: string): SelectionCandidate {
  const e = entry(id, provider);
  return { ref: e.id, routeId: e.routeId, card: mergeCards(e, {}), entry: e };
}

const ALLOW_ALL: ModelAllowlist = { providers: [], models: [], pins: {} };

const PROFILE: TaskProfile = {
  domain: "backend",
  modalities: ["text"],
  reasoningDepth: 0.5,
  contextSize: 0.5,
  risk: "low",
};

function attempt(overrides: Partial<FallbackAttemptView> = {}): FallbackAttemptView {
  return {
    requestedModel: "acme/primary" as ModelRef,
    usedModel: "acme/primary" as ModelRef,
    taskProfile: PROFILE,
    pin: null,
    fallbackSince: null,
    ...overrides,
  };
}

function adequateMock(): AskContext {
  return {
    transport: new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.9 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req",
        attempts: 1,
        elapsedMs: 1,
      }),
    }),
    model: MODEL,
  };
}

function inadequateMock(): AskContext {
  return {
    transport: new MockJevTransport({
      responder: (request) => ({
        kind: "ok",
        response: {
          model: MODEL,
          answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.1 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req",
        attempts: 1,
        elapsedMs: 1,
      }),
    }),
    model: MODEL,
  };
}
