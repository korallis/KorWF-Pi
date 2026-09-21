/**
 * Storage-side tests for route-keyed records (issue #125).
 *
 * AC: "Two providers exposing the same model id are tracked as two distinct
 * routes" at the record level: two `ModelAvailability` rows for the same
 * model id have different upsert keys, and `ModelOutcome` carries the route.
 */
import { describe, it, expect } from "vitest";
import { makeRoute } from "../../src/models/route.ts";
import { RouteAvailabilityTable } from "../../src/models/availability.ts";
import { RECORDS_SCHEMA_VERSION, type ModelAvailability, type ModelOutcome, type RouteId } from "../../src/storage/records.ts";

const MODEL = "example-model-5";
const work = makeRoute("vendor-work", MODEL);
const personal = makeRoute("vendor-personal", MODEL);
const T0 = "2026-09-21T10:00:00.000Z";

describe("ModelAvailability rows (AC: two providers exposing the same model id are two distinct routes)", () => {
  it("in-memory rows map field-for-field onto ModelAvailability and differ by routeId", () => {
    const table = new RouteAvailabilityTable()
      .markCapped(work, { capKind: "rate_limited", at: T0, estimatedReset: null })
      .markAvailable(personal, T0);
    const rows: ModelAvailability[] = table.snapshot().map((r, i) => ({
      kind: "mutable",
      id: `ma${i}` as ModelAvailability["id"],
      createdAt: T0,
      updatedAt: T0,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      ...r,
    }));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.modelId).toBe(rows[1]!.modelId);
    expect(rows[0]!.routeId).not.toBe(rows[1]!.routeId);
    expect(rows.map((r) => r.capKind)).toEqual(["rate_limited", "none"]);
  });

  it("RouteId is a distinct brand from other record ids (compile-time)", () => {
    const id: RouteId = work.routeId;
    // @ts-expect-error a plain string is not a RouteId
    const bad: RouteId = "r1_deadbeef";
    expect(typeof id).toBe("string");
    expect(bad).toBeDefined();
  });
});

describe("ModelOutcome rows (AC: ModelOutcome history is attributed per route)", () => {
  it("requires routeId alongside the provider/model ref", () => {
    const row: ModelOutcome = {
      kind: "append_only",
      id: "mo1" as ModelOutcome["id"],
      createdAt: T0,
      updatedAt: T0,
      schemaVersion: RECORDS_SCHEMA_VERSION,
      workflowId: "wf" as ModelOutcome["workflowId"],
      attemptId: "at" as ModelOutcome["attemptId"],
      routeId: personal.routeId,
      model: personal.ref,
      taskProfile: { domain: "code", modalities: ["text"], reasoningDepth: 0.5, contextSize: 0.2, risk: "low" },
      result: "succeeded",
      cost: { inputTokens: null, outputTokens: null, requests: 1, spendUsd: null, costBasis: "unknown" },
      latencyMs: 1,
      wasFallback: false,
    };
    expect(row.routeId).toBe(personal.routeId);
    expect(row.routeId).not.toBe(work.routeId);
  });
});
