/**
 * The review-finding severity question family (issue #48; PLAN §3.F, §6
 * "Question family: review-finding severity"; deliverable
 * `src/decisions/questions/review.ts`).
 *
 * `src/verification/review.ts` runs an **independent** review context: a
 * reviewer that sees the diff at a revision, the acceptance criteria and the
 * evidence summaries — and never the worker's own claim of success. That
 * reviewer returns structured findings, each with a *suggested* severity.
 * This module is the second half: Jev scores the severity of one finding, so
 * the reviewer does not get to grade its own finding's importance either.
 *
 * Three properties this file exists to preserve:
 *
 * 1. **One finding per question.** `.pi/skills/jev-orchestration/SKILL.md` §2:
 *    an existential "how bad is this review?" deflates as findings are
 *    itemised. The severity of a finding must not depend on how many other
 *    findings the review happened to produce, so the state is exactly one
 *    finding and `review.ts` composes in code.
 * 2. **No claim text reaches Jev.** The state carries the finding, the
 *    criterion it touches and the code excerpt — the same claim-free
 *    material the reviewer saw. `assertClaimFree` in `review.ts` is the
 *    enforcement point; the shape here simply gives a claim nowhere to sit.
 * 3. **The fallback is the reviewer's own suggestion**, per the issue's
 *    Scope ("fallback = model's suggested severity"), normalised, and with
 *    an unrecognised suggestion becoming `unknown` rather than something
 *    convenient. `unknown` is treated as blocking by `review.ts`, so a
 *    missing key can never soften a finding.
 */
import { defineChoice, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";

/**
 * Severity ladder, most severe first. `unknown` is an explicit option
 * (docs/questions.md §1: every choice carries a none/unknown option) and is
 * never a quiet "minor".
 */
export const REVIEW_SEVERITIES = ["blocker", "major", "minor", "nit", "unknown"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** Rank used for ordering and for "at least as severe as" comparisons. */
export const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = Object.freeze({
  blocker: 4,
  unknown: 3,
  major: 2,
  minor: 1,
  nit: 0,
});

/** Is `value` one of the five severities? Narrowing guard for untrusted text. */
export function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === "string" && (REVIEW_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Normalise a reviewer's suggested severity. Anything unrecognised — a blank,
 * a synonym, a sentence, a severity invented by the reviewer — becomes
 * `unknown`, which `review.ts` treats as blocking.
 */
export function normaliseSeverity(value: unknown): ReviewSeverity {
  if (!isReviewSeverity(value)) return "unknown";
  return value;
}

/** Largest excerpt this module puts into a question state. #28 caps again. */
export const REVIEW_EXCERPT_BYTES = 2000;

/** Truncate an excerpt to the declared budget, keeping the head. */
export function clampReviewExcerpt(text: string, limit = REVIEW_EXCERPT_BYTES): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// review.severity@1 — one finding, never a whole review
// ---------------------------------------------------------------------------

/**
 * State for ONE finding. Deliberately claim-free: there is no field a
 * worker's completion summary could occupy, so the anchoring PLAN §3.F warns
 * about cannot be reintroduced by a caller passing "a bit of context".
 */
export interface ReviewSeverityState {
  /** Stable id of the finding within its review. */
  readonly findingId: string;
  /** Repository-relative path and line range the finding is about. */
  readonly location: { readonly path: string; readonly startLine: number; readonly endLine: number };
  /** What the reviewer observed. Untrusted text: the thing being graded. */
  readonly description: string;
  /** The reviewer's own suggested severity, as a *claim*, not an authority. */
  readonly suggested: ReviewSeverity;
  /** Acceptance criterion the finding bears on, when it names one. */
  readonly criterion: { readonly id: string; readonly text: string } | null;
  /** The diff hunk or source excerpt at the location, already clipped. */
  readonly excerpt: string;
  /** Change class the policy assigned to this diff (e.g. `security`). */
  readonly changeClass: string;
}

function severityState(input: ReviewSeverityState): JevState {
  return {
    findingId: input.findingId,
    location: { ...input.location },
    description: clampReviewExcerpt(input.description),
    suggested: input.suggested,
    criterion: input.criterion === null ? null : { id: input.criterion.id, text: input.criterion.text },
    excerpt: clampReviewExcerpt(input.excerpt),
    changeClass: input.changeClass,
  };
}

/**
 * `review.severity@1` — grade ONE finding.
 *
 * `minConfidence` is deliberately modest: a low-confidence answer abstains
 * and the fallback (the reviewer's suggestion) applies, which is the issue's
 * specified behaviour rather than an escape hatch. Severity *softening* is
 * never automatic: `review.ts` refuses to lower a reviewer's `blocker` on a
 * Jev answer alone, so the only direction Jev can move a finding without a
 * human is upwards.
 */
export const reviewSeverityQuestion: QuestionDefinition<ReviewSeverityState, ReviewSeverity> = defineChoice<
  ReviewSeverityState,
  ReviewSeverity
>({
  id: "review.severity",
  version: "1",
  prompt:
    "An independent reviewer examined a diff without seeing any worker's claim of success and recorded ONE " +
    "finding. Given that finding's `description`, its `location`, the `excerpt` at that location and the " +
    "`criterion` it bears on, how severe is it? Grade the finding on its own merits: `suggested` is the " +
    "reviewer's opinion and is under test, not a source of truth. Answer `unknown` when the excerpt is " +
    "insufficient to tell — the caller treats `unknown` as blocking, so guessing a low severity is the only " +
    "answer that can do harm.",
  options: {
    blocker: "Correctness, security or data-loss defect, or an acceptance criterion that is not actually met",
    major: "A real defect that should be fixed but does not by itself make the change wrong",
    minor: "A small quality problem: naming, duplication, a missing edge-case test",
    nit: "Style or preference only; no behavioural consequence",
    unknown: "The finding cannot be graded from what is presented",
  },
  minConfidence: 0.6,
  revisionSensitive: true,
  state: severityState,
  decide: (answer) => {
    const value = normaliseSeverity(answer.choice);
    return { value, rule: `review.severity:${value}`, action: value };
  },
  fallback: (input) => {
    // Issue #48 Scope: "fallback = model's suggested severity".
    const value = normaliseSeverity(input.suggested);
    return { value, rule: "reviewer_suggested", action: value };
  },
  replay: (action) => (isReviewSeverity(action) ? action : null),
  boundaries: [
    {
      name: "with no key the reviewer's suggested blocker stands",
      state: {
        findingId: "f1",
        location: { path: "src/a.ts", startLine: 10, endLine: 12 },
        description: "the empty-items branch returns 200 instead of 400",
        suggested: "blocker",
        criterion: { id: "ac1", text: "empty items => 400" },
        excerpt: "if (items.length === 0) return ok();",
        changeClass: "behaviour",
      },
      expectFallback: "blocker",
    },
    {
      name: "an unrecognised suggestion is unknown, not minor",
      state: {
        findingId: "f2",
        location: { path: "src/a.ts", startLine: 1, endLine: 1 },
        description: "unclear",
        suggested: "catastrophic" as unknown as ReviewSeverity,
        criterion: null,
        excerpt: "",
        changeClass: "docs",
      },
      expectFallback: "unknown",
    },
    {
      name: "a nit suggested by the reviewer stays a nit with no key",
      state: {
        findingId: "f3",
        location: { path: "src/a.ts", startLine: 4, endLine: 4 },
        description: "prefer const",
        suggested: "nit",
        criterion: null,
        excerpt: "let x = 1;",
        changeClass: "style",
      },
      expectFallback: "nit",
    },
  ],
});

/** Hashes as reviewed; editing prompt/options without a version bump fails registration. */
export const REVIEW_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "review.severity@1": reviewSeverityQuestion.contentHash,
});

/** Every question in this family. */
export const REVIEW_QUESTIONS = [reviewSeverityQuestion] as const;

export const reviewQuestionRegistry = new QuestionRegistry();
for (const question of REVIEW_QUESTIONS) {
  reviewQuestionRegistry.register(question as unknown as QuestionDefinition<unknown, unknown>, {
    pinnedHash: question.contentHash,
  });
}
