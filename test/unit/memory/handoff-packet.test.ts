/**
 * Tests for src/memory/handoff-packet.ts (issue #64; PLAN §3.D, §3.H).
 *
 * AC: "Packet contains every field listed above and passes the outbound filter."
 */
import { describe, it, expect } from "vitest";
import { buildHandoffPacket } from "../../../src/memory/handoff-packet.ts";
import { filterHandoffPacket } from "../../../src/workers/handoff.ts";
import { defaultConfig } from "../../../src/config/load.ts";
import { OutboundPolicy } from "../../../src/security/outbound.ts";
import { makeAttempt, makeEvidence } from "../../helpers/records.ts";
import type { IsoTimestamp } from "../../../src/storage/records.ts";

const AT = "2026-01-01T00:00:00.000Z" as IsoTimestamp;

describe("AC: handoff packet contains every required field", () => {
  it("carries task, done, remaining, decisions, open questions, evidence and model info", () => {
    const attempt = makeAttempt({ usedModel: "acme/primary", fallbackReason: "quota_exhausted" });
    const evidence = makeEvidence();

    const packet = buildHandoffPacket({
      attempt,
      progressNotes: [{ at: AT, text: "implemented the parser" }],
      remaining: ["write tests for the edge case"],
      decisions: [{ what: "used a streaming parser", why: "the file can be arbitrarily large" }],
      openQuestions: ["should empty input be an error or a no-op?"],
      evidence: [evidence],
      task: { goal: "parse the file", acceptanceCriteria: ["handles empty input"] },
      substituteModel: "acme/substitute",
      now: () => AT,
    });

    expect(packet.taskId).toBe(attempt.taskId);
    expect(packet.fromAttemptId).toBe(attempt.id);
    expect(packet.task.goal).toBe("parse the file");
    expect(packet.done).toHaveLength(1);
    expect(packet.remaining).toEqual(["write tests for the edge case"]);
    expect(packet.decisions[0]?.why).toContain("arbitrarily large");
    expect(packet.openQuestions).toHaveLength(1);
    expect(packet.evidence[0]?.evidenceId).toBe(evidence.id);
    expect(packet.requestedModel).toBe(attempt.requestedModel);
    expect(packet.substituteModel).toBe("acme/substitute");
    expect(packet.fallbackReason).toBe("quota_exhausted");
    expect(packet.builtAt).toBe(AT);
  });

  it("passes the outbound filter (#28) with nothing removed for ordinary content", () => {
    const attempt = makeAttempt();
    const packet = buildHandoffPacket({
      attempt,
      progressNotes: [],
      remaining: [],
      decisions: [],
      openQuestions: [],
      evidence: [],
      task: { goal: "goal", acceptanceCriteria: [] },
      substituteModel: "acme/substitute",
      now: () => AT,
    });
    const policy = new OutboundPolicy(defaultConfig());
    const filtered = filterHandoffPacket(policy, packet);
    expect(filtered.report.clean).toBe(true);
  });

  it("a denied-path-shaped field is removed by the outbound filter, not sent verbatim", () => {
    const attempt = makeAttempt();
    const packet = buildHandoffPacket({
      attempt,
      progressNotes: [{ at: AT, text: "sk-live-abcdefghijklmnopqrstuvwx1234567890" }],
      remaining: [],
      decisions: [],
      openQuestions: [],
      evidence: [],
      task: { goal: "goal", acceptanceCriteria: [] },
      substituteModel: "acme/substitute",
      now: () => AT,
    });
    const policy = new OutboundPolicy(defaultConfig());
    const filtered = filterHandoffPacket(policy, packet);
    expect(filtered.report.redactedStrings).toBeGreaterThan(0);
  });
});
