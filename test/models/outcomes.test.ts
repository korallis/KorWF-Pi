/**
 * Tests for src/models/outcomes.ts (issue #125).
 *
 * AC: "ModelOutcome history is attributed per route, so one account's poor
 * results do not bias the other."
 */
import { describe, it, expect } from "vitest";
import { makeRoute } from "../../src/models/route.ts";
import { attributeOutcome, summariseOutcomesByRoute } from "../../src/models/outcomes.ts";
import type { TaskProfile, Usage, WorkflowId, AttemptId } from "../../src/storage/records.ts";

const MODEL = "example-model-5";
const work = makeRoute("vendor-work", MODEL);
const personal = makeRoute("vendor-personal", MODEL);

const profile: TaskProfile = { domain: "code", modalities: ["text"], reasoningDepth: 0.5, contextSize: 0.2, risk: "low" };
const usage: Usage = { inputTokens: 10, outputTokens: 5, requests: 1, spendUsd: null, costBasis: "unknown" };

function outcome(route: typeof work, result: "succeeded" | "failed") {
  return attributeOutcome(route, {
    workflowId: "wf" as WorkflowId,
    attemptId: "at" as AttemptId,
    taskProfile: profile,
    result,
    cost: usage,
    latencyMs: 100,
    wasFallback: false,
  });
}

describe("attributeOutcome (AC: ModelOutcome history is attributed per route)", () => {
  it("stamps routeId and provider/model ref from the route", () => {
    const o = outcome(work, "succeeded");
    expect(o.routeId).toBe(work.routeId);
    expect(o.model).toBe(`vendor-work/${MODEL}`);
  });
});

describe("summariseOutcomesByRoute (AC: one account's poor results do not bias the other)", () => {
  it("keeps a failing account's history separate from a healthy one for the same model id", () => {
    const rows = [outcome(work, "failed"), outcome(work, "failed"), outcome(work, "failed"), outcome(personal, "succeeded")];
    const s = summariseOutcomesByRoute(rows);
    expect(s.get(work.routeId)).toMatchObject({ total: 3, successRate: 0 });
    expect(s.get(personal.routeId)).toMatchObject({ total: 1, successRate: 1 });
    expect(rows.every((r) => r.model.endsWith(`/${MODEL}`))).toBe(true);
  });

  it("returns an empty map for no outcomes", () => {
    expect(summariseOutcomesByRoute([]).size).toBe(0);
  });
});
