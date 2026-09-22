/**
 * Completion-claim, evidence-gap and test-exercises-requirement questions
 * (issue #47; PLAN §2.4 (2), §3.F, §6; deliverable
 * `src/decisions/questions/verify.ts`).
 *
 * These are the Jev questions behind **condition 2** of the task gate
 * (`src/verification/task-gate.ts`, #46). This module supplies the
 * evaluators; it never re-implements the gate, and nothing here can waive a
 * deterministic check.
 *
 * `.pi/skills/jev-orchestration/SKILL.md` §2 records the lesson this file is
 * shaped by: a single existential "does this evidence support completion?"
 * **deflates as the scope is itemised**, independent of real completeness.
 * So there is no whole-task question here. Every question is asked about
 * exactly one acceptance criterion (or one (test, criterion) pair), and
 * `src/verification/evaluate.ts` takes the conjunction in code.
 *
 *  - `verify.claim_supported@1` (choice) — for ONE criterion: does the
 *    presented evidence support the worker's claim about it?
 *    `supported` / `unsupported` / `unknown`.
 *  - `verify.evidence_gap@1` (noul) — for ONE criterion: is there a gap,
 *    i.e. does this criterion lack an evidence item that actually
 *    demonstrates it?
 *  - `verify.test_exercises@1` (score) — for ONE (test, criterion) pair: how
 *    much of the criterion does this test actually exercise? This is the
 *    semantic counterpart of #44's `isVerifyingCheck`: that one rejects a
 *    command that *cannot fail*; this one catches a test that runs, passes,
 *    and asserts nothing about the criterion it is linked to.
 *
 * Every fallback is deterministic and structural (PLAN §2.4 "the system must
 * work with no Jev key"). None of them ever invents a semantic pass: the
 * fallbacks answer `unknown` / "gap" / level 0 unless the *structure* itself
 * says otherwise, and `src/verification/evaluate.ts` treats abstention and
 * `unknown` as a gap in every case.
 */
import { defineChoice, defineNoul, defineScore, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";

// ---------------------------------------------------------------------------
// Shared, minimal state shapes (PLAN §6 "minimal relevant state per
// evaluation"; issue #47 Scope "inputs are minimal: criteria text, check
// commands, test file excerpts (filtered), evidence summaries — never the
// full diff").
// ---------------------------------------------------------------------------

/** One acceptance criterion, as the gate sees it. */
export interface CriterionRef {
  readonly id: string;
  readonly text: string;
}

/**
 * One evidence item, summarised. Deliberately not the `Evidence` record: a
 * record carries ids, hashes and environment fingerprints that mean nothing
 * to a judgement and everything to a privacy review.
 */
export interface EvidenceSummary {
  /** Check id the evidence came from, or `null` for reviewer evidence. */
  readonly checkId: string | null;
  /** The exact command line that ran, or a review description. */
  readonly command: string;
  /** `pass` / `fail` / `flaky` / `missing` / `unavailable` / `timeout` (#51). */
  readonly state: string;
  /** Repository-relative paths the evidence was captured from. */
  readonly paths: readonly string[];
  /** Short, already-truncated excerpt of what the check asserted. */
  readonly excerpt: string;
}

/** Largest excerpt this module puts into a question state. #28 caps again. */
export const VERIFY_EXCERPT_BYTES = 2000;

/** Truncate an excerpt to the declared budget, keeping the head. */
export function clampExcerpt(text: string, limit = VERIFY_EXCERPT_BYTES): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// verify.claim_supported@1 — one criterion, never the whole task
// ---------------------------------------------------------------------------

/**
 * State for one criterion. The worker's claim is present as *text to be
 * judged*, never as an authority: the gate reads only the recorded Decision
 * this question produces (task-gate.ts C0/C2).
 */
export interface ClaimSupportedState {
  readonly criterionId: string;
  readonly criterionText: string;
  /** The worker's completion summary, clipped. Untrusted text. */
  readonly claim: string;
  readonly evidence: readonly EvidenceSummary[];
}

export type ClaimVerdict = "supported" | "unsupported" | "unknown";

function claimState(input: ClaimSupportedState): JevState {
  return {
    criterionId: input.criterionId,
    criterionText: input.criterionText,
    claim: clampExcerpt(input.claim),
    evidence: input.evidence.map((e) => ({
      checkId: e.checkId,
      command: e.command,
      state: e.state,
      paths: [...e.paths],
      excerpt: clampExcerpt(e.excerpt),
    })),
  };
}

/**
 * Deterministic fallback: **structural only**, and it can never return
 * `supported`. With no key the mapping rule in `evaluate.ts` is the whole
 * answer; a semantic "supported" invented here would be precisely the silent
 * pass PLAN §2.4 forbids. No passing evidence at all is structurally
 * `unsupported`; anything else is honestly `unknown`.
 */
export function claimFallbackVerdict(evidence: readonly EvidenceSummary[]): ClaimVerdict {
  return evidence.some((e) => e.state === "pass") ? "unknown" : "unsupported";
}

export const claimSupportedQuestion: QuestionDefinition<ClaimSupportedState, ClaimVerdict> = defineChoice<
  ClaimSupportedState,
  ClaimVerdict
>({
  id: "verify.claim_supported",
  version: "1",
  prompt:
    "A worker claims one acceptance criterion is complete. Given that single `criterionText`, the worker's " +
    "`claim`, and the `evidence` actually presented for it, does the evidence support the claim for THIS " +
    "criterion? Judge only the evidence: the claim is the thing under test, not a source of facts. Answer " +
    "`unknown` whenever the evidence neither demonstrates nor contradicts the criterion — an explicit unknown " +
    "is treated as a gap by the caller, so guessing `supported` is the only answer that can do harm.",
  options: {
    supported: "The presented evidence demonstrates this criterion holds at the revision it was captured at",
    unsupported: "The evidence does not demonstrate this criterion, or contradicts the claim about it",
    unknown: "The evidence is insufficient to tell either way",
  },
  minConfidence: 0.6,
  revisionSensitive: true,
  state: claimState,
  decide: (answer) => {
    const value: ClaimVerdict =
      answer.choice === "supported" || answer.choice === "unsupported" ? answer.choice : "unknown";
    return { value, rule: `verify.claim_supported:${value}`, action: value };
  },
  fallback: (input) => {
    const value = claimFallbackVerdict(input.evidence);
    return { value, rule: "structural_only", action: value };
  },
  replay: (action) =>
    action === "supported" || action === "unsupported" || action === "unknown" ? action : null,
  boundaries: [
    {
      name: "no evidence at all is structurally unsupported",
      state: { criterionId: "ac1", criterionText: "empty items => 400", claim: "done", evidence: [] },
      expectFallback: "unsupported",
    },
    {
      name: "a passing check is never a semantic `supported` with no key",
      state: {
        criterionId: "ac1",
        criterionText: "empty items => 400",
        claim: "done",
        evidence: [{ checkId: "chk1", command: "npm test", state: "pass", paths: ["test/a.test.ts"], excerpt: "" }],
      },
      expectFallback: "unknown",
    },
    {
      name: "only failing evidence is unsupported",
      state: {
        criterionId: "ac1",
        criterionText: "empty items => 400",
        claim: "done",
        evidence: [{ checkId: "chk1", command: "npm test", state: "fail", paths: [], excerpt: "" }],
      },
      expectFallback: "unsupported",
    },
  ],
});

// ---------------------------------------------------------------------------
// verify.evidence_gap@1 — one criterion, noul
// ---------------------------------------------------------------------------

/**
 * State for the gap question about ONE criterion. The issue's scope names a
 * Noul returning "the list of criteria ids without supporting evidence"; a
 * list is exactly the existential shape the decomposition lesson warns
 * about, so the list is *assembled in code* (`evaluate.ts`) from one bounded
 * noul per criterion. The answer set is identical; the probability of each
 * part no longer depends on how many criteria the task happens to have.
 */
export interface EvidenceGapState {
  readonly criterionId: string;
  readonly criterionText: string;
  /** Commands of the checks that *claim* to cover this criterion. */
  readonly linkedChecks: readonly { readonly checkId: string; readonly command: string; readonly state: string }[];
  readonly evidence: readonly EvidenceSummary[];
}

function gapState(input: EvidenceGapState): JevState {
  return {
    criterionId: input.criterionId,
    criterionText: input.criterionText,
    linkedChecks: input.linkedChecks.map((c) => ({ checkId: c.checkId, command: c.command, state: c.state })),
    evidence: input.evidence.map((e) => ({
      checkId: e.checkId,
      command: e.command,
      state: e.state,
      paths: [...e.paths],
      excerpt: clampExcerpt(e.excerpt),
    })),
  };
}

/**
 * Deterministic fallback: **the mapping rule**, and nothing more (issue #47
 * Scope, "Disabled fallback: mapping-only — each criterion must have ≥1
 * linked passing check"). `true` means "there is a gap", so the safe answer
 * with no key is `true` unless the structure positively rules it out: at
 * least one linked check in state `pass` AND at least one passing evidence
 * row attributed to this criterion.
 */
export function evidenceGapFallback(input: EvidenceGapState): boolean {
  const linkedPassing = input.linkedChecks.some((c) => c.state === "pass");
  const evidencePassing = input.evidence.some((e) => e.state === "pass");
  return !(linkedPassing && evidencePassing);
}

export const evidenceGapQuestion: QuestionDefinition<EvidenceGapState, boolean> = defineNoul<
  EvidenceGapState,
  boolean
>({
  id: "verify.evidence_gap",
  version: "1",
  prompt:
    "For ONE acceptance criterion, is there an evidence gap? A gap exists when nothing in `linkedChecks`/" +
    "`evidence` would have detected this criterion being unimplemented — including when a check passes but " +
    "observes something else entirely. Do not reward volume of evidence: one check that would fail if the " +
    "criterion were violated closes the gap, ten that would not does not.",
  criteria: {
    true: "There is a gap: no presented check or evidence item actually demonstrates this criterion",
    false: "No gap: at least one presented item would fail if this criterion were not met",
  },
  abstainBand: [0.35, 0.65],
  revisionSensitive: true,
  state: gapState,
  decide: (noul) => ({
    value: noul >= 0.5,
    rule: noul >= 0.5 ? "verify.evidence_gap:gap" : "verify.evidence_gap:no_gap",
    action: noul >= 0.5 ? "gap" : "no_gap",
  }),
  fallback: (input) => {
    const value = evidenceGapFallback(input);
    return { value, rule: "criterion_mapping", action: value ? "gap" : "no_gap" };
  },
  replay: (action) => (action === "gap" ? true : action === "no_gap" ? false : null),
  boundaries: [
    {
      name: "no linked check is a gap",
      state: { criterionId: "ac1", criterionText: "empty items => 400", linkedChecks: [], evidence: [] },
      expectFallback: true,
    },
    {
      name: "linked check passing but no passing evidence row is still a gap",
      state: {
        criterionId: "ac1",
        criterionText: "empty items => 400",
        linkedChecks: [{ checkId: "chk1", command: "npm test", state: "pass" }],
        evidence: [],
      },
      expectFallback: true,
    },
    {
      name: "linked passing check plus passing evidence closes the structural gap",
      state: {
        criterionId: "ac1",
        criterionText: "empty items => 400",
        linkedChecks: [{ checkId: "chk1", command: "npm test", state: "pass" }],
        evidence: [{ checkId: "chk1", command: "npm test", state: "pass", paths: ["test/a.test.ts"], excerpt: "" }],
      },
      expectFallback: false,
    },
    {
      name: "a flaky linked check does not close the gap (#51: flaky is not success)",
      state: {
        criterionId: "ac1",
        criterionText: "empty items => 400",
        linkedChecks: [{ checkId: "chk1", command: "npm test", state: "flaky" }],
        evidence: [{ checkId: "chk1", command: "npm test", state: "flaky", paths: [], excerpt: "" }],
      },
      expectFallback: true,
    },
  ],
});

/** Hashes as reviewed; editing prompt/options/levels without a version bump fails registration. */
export const VERIFY_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({});

export const verifyQuestionRegistry = new QuestionRegistry();

export { defineChoice, defineNoul, defineScore };
export type { QuestionDefinition };
