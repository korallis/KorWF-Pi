/**
 * Independent review contexts (issue #48; PLAN §2.4 (3), §3.F, §6).
 *
 * Acceptance criteria exercised here, by name:
 *  - **AC1** "Reviewer prompt contains no worker summary text (test asserts
 *    on the built prompt)" — `describe("AC1 …")`.
 *  - **AC2** "A `blocker` finding prevents the gate until a recheck at a
 *    newer revision passes" — `describe("AC2 …")`.
 *  - **AC3** "Review requirement is derived from policy, not from the
 *    worker's self-assessment" — `describe("AC3 …")`.
 *
 * Plus the two invariants the issue states outside the checklist: a review is
 * evidence feeding condition 3 and never sets `done`, and findings carry
 * severity and disposition.
 *
 * No network, no key, no live model: the reviewer is an injected function and
 * Jev is the mock/disabled transport.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_POLICY,
  DispositionError,
  FINDING_DISPOSITIONS,
  MIN_CLAIM_FRAGMENT,
  REVIEWER_INSTRUCTIONS,
  ReviewContaminationError,
  applyGradedSeverity,
  assertClaimFree,
  blockingFindings,
  buildReviewerPrompt,
  disposeFinding,
  ingestFinding,
  isBlockingSeverity,
  isDifferentFamily,
  isUnresolvedBlocking,
  jevSeverityGrader,
  recheckOutcome,
  reviewCaveats,
  reviewGateVerdict,
  reviewPolicyFrom,
  reviewPromptHash,
  reviewRequirement,
  reviewToEvidence,
  runReview,
  suggestedSeverityGrader,
  type RawFinding,
  type ReviewContext,
  type ReviewRecord,
  type ReviewerIdentity,
} from "../../../src/verification/review.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import type { JevEvaluateResult, SystemOneRequest } from "../../../src/jev/transport.ts";
import type { GitSha, Revision } from "../../../src/storage/records.ts";

const SHA_A = "a".repeat(40) as GitSha;
const SHA_B = "b".repeat(40) as GitSha;

/** The worker's own account. It must never reach the reviewer. */
const WORKER_CLAIM =
  "I implemented the empty-order rejection and all of the tests pass, so this task is complete.";

const CONTEXT: ReviewContext = {
  taskId: "tk-1",
  taskRevision: 3 as Revision,
  revision: SHA_A,
  goal: "Reject an order with no items",
  criteria: [{ id: "ac1", text: "empty items => 400 empty_order" }],
  diff: [
    {
      path: "src/orders.ts",
      startLine: 10,
      endLine: 14,
      patch: "+  if (items.length === 0) return ok();",
    },
  ],
  evidence: [{ checkId: "chk1", command: "npm test", state: "pass", criterionIds: ["ac1"] }],
  changeClass: "behaviour",
};

const REVIEWER: ReviewerIdentity = { model: "provider/model-x", family: "x", attemptId: "at-review" };

const BLOCKER_RAW: RawFinding = {
  id: "f1",
  path: "src/orders.ts",
  startLine: 10,
  endLine: 14,
  description: "the empty-items branch returns 200 instead of 400, so ac1 is not met",
  suggestedSeverity: "blocker",
  criterionId: "ac1",
};
const NIT_RAW: RawFinding = { ...BLOCKER_RAW, id: "f2", suggestedSeverity: "nit", description: "prefer const" };

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: "rv-1",
    taskId: "tk-1",
    taskRevision: 3 as Revision,
    revision: SHA_A,
    reviewer: REVIEWER,
    promptHash: "h",
    findings: [],
    rechecksReviewId: null,
    ...overrides,
  };
}

/** `b` is newer than `a`; nothing else is newer than anything. */
const isNewer = (candidate: GitSha, base: GitSha): boolean => candidate === SHA_B && base === SHA_A;

// ---------------------------------------------------------------------------
// AC1
// ---------------------------------------------------------------------------

describe("AC1: the reviewer prompt contains no worker summary text", () => {
  it("renders goal, criteria, diff and check states and nothing else", () => {
    const prompt = buildReviewerPrompt(CONTEXT);
    expect(prompt).toContain(REVIEWER_INSTRUCTIONS);
    expect(prompt).toContain("Reject an order with no items");
    expect(prompt).toContain("[ac1] empty items => 400 empty_order");
    expect(prompt).toContain("src/orders.ts:10-14");
    expect(prompt).toContain("npm test => pass");
    expect(prompt).not.toMatch(/claim|summary|the worker|reports that|success/i);
  });

  it("cannot render a claim even when the caller passes one to runReview", async () => {
    let seen = "";
    const review = await runReview({
      id: "rv-1",
      context: CONTEXT,
      reviewer: REVIEWER,
      claims: [WORKER_CLAIM],
      run: async (prompt) => {
        seen = prompt;
        return [];
      },
    });
    expect(seen).not.toContain("I implemented");
    expect(seen).not.toContain("all of the tests pass");
    expect(review.promptHash).toBe(reviewPromptHash(seen));
  });

  it("refuses a prompt that was contaminated with claim text", () => {
    const contaminated = `${buildReviewerPrompt(CONTEXT)}\n\n${WORKER_CLAIM}`;
    expect(() => assertClaimFree(contaminated, [WORKER_CLAIM])).toThrow(ReviewContaminationError);
    expect(() => assertClaimFree(contaminated, [WORKER_CLAIM])).toThrow(/PLAN §3.F/);
  });

  it("matches claim text that was reflowed and recased", () => {
    const reflowed = `${buildReviewerPrompt(CONTEXT)}\nI   IMPLEMENTED the empty-order rejection and all of the tests pass, so this task is complete.`;
    expect(() => assertClaimFree(reflowed, [WORKER_CLAIM])).toThrow(ReviewContaminationError);
  });

  it("does not cry wolf on a short fragment that legitimately appears in a diff", () => {
    expect(MIN_CLAIM_FRAGMENT).toBeGreaterThan(8);
    expect(() => assertClaimFree(buildReviewerPrompt(CONTEXT), ["Done.", "ok();"])).not.toThrow();
  });

  it("is deterministic: same context, same bytes and same hash", () => {
    expect(buildReviewerPrompt(CONTEXT)).toBe(buildReviewerPrompt({ ...CONTEXT }));
    expect(reviewPromptHash(buildReviewerPrompt(CONTEXT))).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// AC3
// ---------------------------------------------------------------------------

describe("AC3: the review requirement is derived from policy, not self-assessment", () => {
  const subject = { changeClass: "behaviour", riskClass: "low" as const, touchedPaths: ["src/orders.ts"] };

  it("requires review for a behaviour change at low risk", () => {
    const got = reviewRequirement(DEFAULT_REVIEW_POLICY, subject);
    expect(got.required).toBe(true);
    expect(got.matchedRules).toContain("behaviour_change");
    expect(got.reason).toBe("rule_matched");
  });

  it("does not require review for a low-risk docs-only change", () => {
    const got = reviewRequirement(DEFAULT_REVIEW_POLICY, {
      changeClass: "docs",
      riskClass: "low",
      touchedPaths: ["docs/x.md"],
    });
    expect(got).toEqual({ required: false, matchedRules: [], reason: "no_rule_matched" });
  });

  it("always requires review for a high-risk task, whatever the rules say", () => {
    const got = reviewRequirement(
      { reviewEverything: false, rules: [] },
      { changeClass: "docs", riskClass: "high", touchedPaths: ["docs/x.md"] },
    );
    expect(got.required).toBe(true);
    expect(got.matchedRules).toContain("high_risk_always");
  });

  it("fires on ownership path prefixes regardless of change class", () => {
    const got = reviewRequirement(DEFAULT_REVIEW_POLICY, {
      changeClass: "docs",
      riskClass: "low",
      touchedPaths: ["src/security/policy.ts"],
    });
    expect(got.matchedRules).toContain("security_surface");
  });

  it("takes no worker input: the same subject always yields the same requirement", () => {
    const keys = Object.keys(subject).sort();
    expect(keys).toEqual(["changeClass", "riskClass", "touchedPaths"]);
    expect(reviewRequirement(DEFAULT_REVIEW_POLICY, subject)).toEqual(
      reviewRequirement(DEFAULT_REVIEW_POLICY, { ...subject }),
    );
  });

  it("lets configuration tighten the policy but never remove a shipped rule", () => {
    const policy = reviewPolicyFrom({
      reviewEverything: false,
      preferDifferentModelFamily: true,
      rules: [
        { id: "behaviour_change", changeClasses: [], paths: ["never/matches"], minRiskClass: "high" },
        { id: "extra_docs", changeClasses: ["docs"], paths: [], minRiskClass: "low" },
      ],
    });
    // The shipped rule survives verbatim; the attempted laxer redefinition is dropped.
    expect(policy.rules.filter((r) => r.id === "behaviour_change")).toEqual(
      DEFAULT_REVIEW_POLICY.rules.filter((r) => r.id === "behaviour_change"),
    );
    expect(policy.rules.map((r) => r.id)).toContain("extra_docs");
    expect(reviewRequirement(policy, { changeClass: "docs", riskClass: "low", touchedPaths: ["docs/x.md"] }).required)
      .toBe(true);
  });

  it("falls back to the shipped policy with no configuration", () => {
    expect(reviewPolicyFrom(undefined)).toBe(DEFAULT_REVIEW_POLICY);
  });
});

// ---------------------------------------------------------------------------
// Findings: severity and disposition
// ---------------------------------------------------------------------------

describe("findings carry severity and disposition", () => {
  it("ingests a finding as open with the reviewer's normalised severity", () => {
    const f = ingestFinding(BLOCKER_RAW);
    expect(f.severity).toBe("blocker");
    expect(f.severitySource).toBe("reviewer");
    expect(f.disposition).toBe("open");
    expect(FINDING_DISPOSITIONS).toContain(f.disposition);
  });

  it("treats an invented severity as unknown, and unknown as blocking", () => {
    const f = ingestFinding({ ...NIT_RAW, suggestedSeverity: "catastrophic" });
    expect(f.severity).toBe("unknown");
    expect(isBlockingSeverity("unknown")).toBe(true);
    expect(isUnresolvedBlocking(f)).toBe(true);
  });

  it("lets Jev raise a severity", () => {
    const raised = applyGradedSeverity(ingestFinding(NIT_RAW), {
      severity: "major",
      source: "jev",
      decisionId: "dc-1",
    });
    expect(raised.severity).toBe("major");
    expect(raised.severitySource).toBe("jev");
    expect(raised.severityDecisionId).toBe("dc-1");
  });

  it("never lets Jev soften a reviewer's blocker (PLAN §2.4: Jev cannot waive C3)", () => {
    const softened = applyGradedSeverity(ingestFinding(BLOCKER_RAW), {
      severity: "nit",
      source: "jev",
      decisionId: "dc-2",
    });
    expect(softened.severity).toBe("blocker");
    expect(softened.severitySource).toBe("reviewer");
    expect(softened.suggestedSeverity).toBe("blocker");
  });

  it("requires a reason for accept_with_reason and reject", () => {
    const f = ingestFinding(NIT_RAW);
    const by = { kind: "policy" as const, identity: "policy:auto" };
    expect(() => disposeFinding(f, "accept_with_reason", by, "")).toThrow(DispositionError);
    expect(disposeFinding(f, "accept_with_reason", by, "cosmetic").dispositionReason).toBe("cosmetic");
    expect(() => disposeFinding(f, "open", by)).toThrow(DispositionError);
  });

  it("lets only a user accept or reject a blocking finding", () => {
    const f = ingestFinding(BLOCKER_RAW);
    expect(() => disposeFinding(f, "accept_with_reason", { kind: "policy", identity: "auto" }, "meh")).toThrow(
      /only a user may/,
    );
    const accepted = disposeFinding(f, "accept_with_reason", { kind: "user", identity: "lee" }, "tracked in #99");
    expect(isUnresolvedBlocking(accepted)).toBe(false);
  });

  it("does not treat a claimed fix as a resolution", () => {
    const fixed = disposeFinding(ingestFinding(BLOCKER_RAW), "fix", { kind: "user", identity: "lee" });
    expect(isUnresolvedBlocking(fixed)).toBe(true);
    expect(blockingFindings([fixed]).map((f) => f.id)).toEqual(["f1"]);
  });

  it("orders blocking findings most severe first", () => {
    const unknown = ingestFinding({ ...NIT_RAW, id: "f3", suggestedSeverity: "weird" });
    expect(blockingFindings([unknown, ingestFinding(BLOCKER_RAW)]).map((f) => f.id)).toEqual(["f1", "f3"]);
  });
});

// ---------------------------------------------------------------------------
// AC2
// ---------------------------------------------------------------------------

describe("AC2: a blocker prevents the gate until a recheck at a newer revision passes", () => {
  const original = record({ findings: [ingestFinding(BLOCKER_RAW)] });

  it("refuses the gate while the blocker is open", () => {
    const verdict = reviewGateVerdict({
      required: true,
      revision: SHA_A,
      taskRevision: 3 as Revision,
      reviews: [original],
      authorAttemptId: "at-author",
      isNewer,
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons).toEqual(["blocking_finding_unresolved"]);
    expect(verdict.blocking).toEqual(["f1"]);
  });

  it("still refuses when the recheck is at the same revision", () => {
    const recheck = record({ id: "rv-2", rechecksReviewId: "rv-1", revision: SHA_A, findings: [] });
    expect(recheckOutcome(original, recheck, isNewer)).toEqual({
      cleared: false,
      reason: "same_revision",
      stillBlocking: ["f1"],
    });
  });

  it("still refuses when the recheck is at an older/unrelated revision", () => {
    // The original was taken at SHA_B; the "recheck" is at SHA_A, which the
    // ancestry oracle does not consider newer.
    const later = record({ id: "rv-9", revision: SHA_B, findings: [ingestFinding(BLOCKER_RAW)] });
    const backwards = record({ id: "rv-10", rechecksReviewId: "rv-9", revision: SHA_A, findings: [] });
    expect(recheckOutcome(later, backwards, isNewer)).toEqual({
      cleared: false,
      reason: "older_revision",
      stillBlocking: ["f1"],
    });
  });

  it("still refuses when the review is not linked as a recheck", () => {
    const unlinked = record({ id: "rv-2", revision: SHA_B, findings: [] });
    expect(recheckOutcome(original, unlinked, isNewer).reason).toBe("not_a_recheck");
  });

  it("still refuses when the recheck itself raises a blocker", () => {
    const recheck = record({
      id: "rv-2",
      rechecksReviewId: "rv-1",
      revision: SHA_B,
      findings: [ingestFinding({ ...BLOCKER_RAW, id: "f9" })],
    });
    expect(recheckOutcome(original, recheck, isNewer)).toEqual({
      cleared: false,
      reason: "still_blocking",
      stillBlocking: ["f9"],
    });
  });

  it("clears once a recheck at a newer revision is clean, and then the gate is satisfied", () => {
    const recheck = record({ id: "rv-2", rechecksReviewId: "rv-1", revision: SHA_B, findings: [] });
    expect(recheckOutcome(original, recheck, isNewer)).toEqual({
      cleared: true,
      reason: "cleared",
      stillBlocking: [],
    });
    const verdict = reviewGateVerdict({
      required: true,
      revision: SHA_B,
      taskRevision: 3 as Revision,
      reviews: [original, recheck],
      authorAttemptId: "at-author",
      isNewer,
    });
    expect(verdict.satisfied).toBe(true);
    expect(verdict.blocking).toEqual([]);
  });
});

describe("the gate verdict is evidence for condition 3, never authority", () => {
  it("returns a verdict, not a task or a done flag", () => {
    const verdict = reviewGateVerdict({
      required: true,
      revision: SHA_A,
      taskRevision: 3 as Revision,
      reviews: [record()],
      authorAttemptId: "at-author",
      isNewer,
    });
    expect(Object.keys(verdict).sort()).toEqual(["blocking", "reasons", "satisfied"]);
    expect(verdict).not.toHaveProperty("done");
    expect(verdict).not.toHaveProperty("status");
  });

  it("refuses when review is required and none exists", () => {
    const verdict = reviewGateVerdict({
      required: true,
      revision: SHA_A,
      taskRevision: 3 as Revision,
      reviews: [],
      authorAttemptId: null,
      isNewer,
    });
    expect(verdict.reasons).toEqual(["review_missing"]);
  });

  it("refuses a review taken at a stale revision", () => {
    const verdict = reviewGateVerdict({
      required: true,
      revision: SHA_B,
      taskRevision: 3 as Revision,
      reviews: [record()],
      authorAttemptId: null,
      isNewer,
    });
    expect(verdict.reasons).toEqual(["review_stale_revision"]);
  });

  it("refuses a review produced by the authoring attempt", () => {
    const verdict = reviewGateVerdict({
      required: true,
      revision: SHA_A,
      taskRevision: 3 as Revision,
      reviews: [record({ reviewer: { ...REVIEWER, attemptId: "at-author" } })],
      authorAttemptId: "at-author",
      isNewer,
    });
    expect(verdict.reasons).toEqual(["review_not_independent"]);
  });

  it("is vacuously satisfied when policy does not require a review", () => {
    const verdict = reviewGateVerdict({
      required: false,
      revision: SHA_A,
      taskRevision: 3 as Revision,
      reviews: [],
      authorAttemptId: null,
      isNewer,
    });
    expect(verdict).toEqual({ satisfied: true, reasons: [], blocking: [] });
  });
});

// ---------------------------------------------------------------------------
// A review as evidence
// ---------------------------------------------------------------------------

describe("a review becomes model evidence, never deterministic evidence", () => {
  it("records a non-zero exit status while a blocker is unresolved", () => {
    const ev = reviewToEvidence({
      review: record({ findings: [ingestFinding(BLOCKER_RAW)] }),
      workflowId: "wf-1",
      requirementId: "ac1",
    });
    expect(ev.exitStatus).toEqual({ kind: "exited", code: 1 });
    expect(ev.reviewer.kind).toBe("model");
    expect(ev.checkId).toBeNull();
    expect(ev.caveats.join(" ")).toContain("f1");
  });

  it("records exit 0 with no blocking findings", () => {
    const ev = reviewToEvidence({
      review: record({ findings: [ingestFinding(NIT_RAW)] }),
      workflowId: "wf-1",
      requirementId: "ac1",
      authorFamily: "y",
    });
    expect(ev.exitStatus).toEqual({ kind: "exited", code: 0 });
    expect(ev.caveats).toEqual([]);
  });

  it("caveats a same-family reviewer instead of refusing it", () => {
    expect(isDifferentFamily(REVIEWER, "x")).toBe(false);
    expect(isDifferentFamily(REVIEWER, null)).toBe(true);
    expect(reviewCaveats(record(), "x").join(" ")).toContain("different model family");
  });
});

// ---------------------------------------------------------------------------
// Running a review, with and without a Jev key
// ---------------------------------------------------------------------------

describe("running a review grades every finding", () => {
  it("uses the reviewer's suggestion as the deterministic fallback with no key", async () => {
    const review = await runReview({
      id: "rv-1",
      context: CONTEXT,
      reviewer: REVIEWER,
      run: async () => [BLOCKER_RAW, NIT_RAW],
    });
    expect(review.findings.map((f) => [f.id, f.severity, f.severitySource])).toEqual([
      ["f1", "blocker", "reviewer"],
      ["f2", "nit", "reviewer"],
    ]);
    expect(await suggestedSeverityGrader(review.findings[1]!, CONTEXT)).toEqual({
      severity: "nit",
      source: "fallback",
      decisionId: null,
    });
  });

  it("falls back cleanly when the Jev transport is disabled", async () => {
    const ctx: AskContext = { transport: new DisabledJevTransport("no key"), model: "jev-test" };
    const review = await runReview({
      id: "rv-1",
      context: CONTEXT,
      reviewer: REVIEWER,
      grade: jevSeverityGrader(ctx),
      run: async () => [NIT_RAW],
    });
    expect(review.findings[0]?.severity).toBe("nit");
    expect(review.findings[0]?.severitySource).toBe("reviewer");
  });

  it("uses a validated Jev grade to raise severity, sending no claim text", async () => {
    const seen: SystemOneRequest[] = [];
    const transport = new MockJevTransport({
      responder: (request): JevEvaluateResult => {
        seen.push(request as unknown as SystemOneRequest);
        return {
          kind: "ok",
          response: {
            model: "jev-test",
            answers: Object.fromEntries(
              Object.entries(request.questions).map(([k, q]) => {
                const options = Object.keys((q as { criteria: Record<string, string> }).criteria);
                const probabilities = Object.fromEntries(
                  options.map((o) => [o, o === "major" ? 1 : 0]),
                );
                return [k, { type: "choice", choice: "major", probabilities, confidence: 0.95 }];
              }),
            ),
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          requestId: "req-1",
          attempts: 1,
          elapsedMs: 1,
        };
      },
    });
    const ctx: AskContext = { transport, model: "jev-test" };
    const review = await runReview({
      id: "rv-1",
      context: CONTEXT,
      reviewer: REVIEWER,
      claims: [WORKER_CLAIM],
      grade: jevSeverityGrader(ctx),
      run: async () => [NIT_RAW],
    });
    expect(review.findings[0]?.severity).toBe("major");
    expect(review.findings[0]?.severitySource).toBe("jev");
    expect(JSON.stringify(seen)).not.toContain("I implemented");
  });
});
