/**
 * Independent review contexts (issue #48; PLAN §2.4 (3), §3.F, §6;
 * `docs/gates.md` §2–§3; deliverable `src/verification/review.ts`).
 *
 * > **PLAN §3.F** Independent review contexts to reduce anchoring on worker
 * > claims.
 *
 * This module is the **context boundary**, not a second gate. It builds the
 * reviewer's input, structures what comes back, grades each finding with
 * `review.severity@1` (`src/decisions/questions/review.ts`), applies a
 * disposition, and exposes one predicate the task gate's condition 3 reads.
 *
 * Why it is shaped this way — four properties, each made structural:
 *
 * 1. **The reviewer never sees the worker's claim.** `ReviewContext` has no
 *    field a claim could occupy, and `buildReviewerPrompt` renders only that
 *    type. `assertClaimFree` is the belt to that braces: it refuses a prompt
 *    containing the attempt's completion summary. This project learned the
 *    need for it the hard way — a worker once pasted a fabricated
 *    verification transcript and the gate passed it; an independent audit by
 *    a *different model* caught it
 *    (`.pi/skills/jev-orchestration/SKILL.md` §4).
 * 2. **A review is evidence, not authority.** `reviewToEvidence` produces an
 *    `Evidence` row. Nothing here writes a status, returns `done`, or is read
 *    by the gate's conditions 1 and 2. A passing review is one input to C3;
 *    a review can only ever *withhold* completion, never confer it.
 * 3. **An unresolved blocking finding refuses the gate.** `blockingFindings`
 *    treats `blocker` and `unknown` as blocking, and a blocker is cleared
 *    only by a recheck **at a strictly newer revision** — "fixed" at the same
 *    revision is the same code.
 * 4. **Requirement comes from policy, never from the worker.** The input to
 *    `reviewRequirement` is the change class, risk class and touched paths,
 *    all derived from `src/git/` and the task record. A worker's
 *    self-assessment is not a parameter of that function.
 *
 * Pure module: no I/O, no subprocesses, no git. The caller supplies the diff
 * and the revision; `src/git/` is the only place that runs git.
 */
import { createHash } from "node:crypto";
import type { ReviewSeverity } from "../decisions/questions/review.ts";
import { REVIEW_SEVERITIES, SEVERITY_RANK, normaliseSeverity } from "../decisions/questions/review.ts";
import type { GitSha, Revision } from "../storage/records.ts";

export type { ReviewSeverity };
export { REVIEW_SEVERITIES, SEVERITY_RANK };

// ---------------------------------------------------------------------------
// The review context: what a reviewer is allowed to see
// ---------------------------------------------------------------------------

/** One hunk of the diff under review, already scoped to the task's ownership. */
export interface ReviewDiffHunk {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Unified-diff text for this hunk, already clipped by the caller. */
  readonly patch: string;
}

/** One acceptance criterion, exactly as the plan records it. */
export interface ReviewCriterion {
  readonly id: string;
  readonly text: string;
}

/**
 * One evidence item as the reviewer sees it: what ran and what state it
 * reached. Never the worker's narration of what it means.
 */
export interface ReviewEvidenceLine {
  readonly checkId: string | null;
  readonly command: string;
  /** `pass` / `fail` / `flaky` / `missing` / `unavailable` / `timeout` (#51). */
  readonly state: string;
  readonly criterionIds: readonly string[];
}

/**
 * Everything the independent reviewer receives — and, by construction,
 * everything it *can* receive.
 *
 * There is no `claim`, no `summary`, no `attemptNotes` and no `worker`
 * field. That absence is the feature: PLAN §3.F's anchoring reduction is a
 * property of the type, so it cannot be undone by a caller who thinks a
 * little context would help.
 */
export interface ReviewContext {
  readonly taskId: string;
  readonly taskRevision: Revision;
  /** Exact revision the diff was taken at; the review is pinned to it. */
  readonly revision: GitSha;
  /** The task goal, as written in the plan — not as the worker restated it. */
  readonly goal: string;
  readonly criteria: readonly ReviewCriterion[];
  readonly diff: readonly ReviewDiffHunk[];
  readonly evidence: readonly ReviewEvidenceLine[];
  /** Change class from `src/git/`, e.g. `behaviour`, `security`, `docs`. */
  readonly changeClass: string;
}

// ---------------------------------------------------------------------------
// The reviewer prompt, and the proof that it carries no worker claim
// ---------------------------------------------------------------------------

/**
 * Instructions given to the reviewing model. Note what is *not* said: there
 * is no "the worker reports", no "verify that the claimed fix", and no
 * summary to react to. The reviewer is asked to form its own view of the
 * diff against the criteria.
 */
export const REVIEWER_INSTRUCTIONS = [
  "You are reviewing a change in an independent context.",
  "You have the goal, the acceptance criteria, the diff at one exact revision, and the state of each recorded check.",
  "You have deliberately NOT been given the author's account of what it did or whether it succeeded.",
  "Judge the diff against the criteria on its own terms.",
  "Report findings only: one per problem, each with a location, a description and a suggested severity",
  "(blocker, major, minor, nit, or unknown when you cannot tell from what is shown).",
  "Absence of findings is not an endorsement, and you do not decide whether the task is complete.",
].join("\n");

/**
 * Render the reviewer prompt from a `ReviewContext`.
 *
 * Deterministic: the same context yields the same bytes, so the prompt can be
 * hashed onto the evidence row and a test can assert on it exactly (issue #48
 * AC1, "test asserts on the built prompt").
 */
export function buildReviewerPrompt(context: ReviewContext): string {
  const lines: string[] = [REVIEWER_INSTRUCTIONS, "", `## Goal`, context.goal, "", "## Acceptance criteria"];
  for (const c of context.criteria) lines.push(`- [${c.id}] ${c.text}`);
  lines.push("", `## Diff at ${context.revision} (change class: ${context.changeClass})`);
  for (const hunk of context.diff) {
    lines.push(`### ${hunk.path}:${hunk.startLine}-${hunk.endLine}`, hunk.patch);
  }
  lines.push("", "## Recorded checks");
  if (context.evidence.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const e of context.evidence) {
      const ids = e.criterionIds.length === 0 ? "-" : e.criterionIds.join(",");
      lines.push(`- ${e.command} => ${e.state} [criteria: ${ids}]`);
    }
  }
  return lines.join("\n");
}

/** Stable fingerprint of a built prompt, recorded on the review evidence. */
export function reviewPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/** Raised when a prompt would carry material from the author's own account. */
export class ReviewContaminationError extends Error {
  readonly excerpt: string;
  constructor(excerpt: string) {
    super(
      `reviewer prompt contains the author's claim text (${JSON.stringify(excerpt.slice(0, 60))}); ` +
        "an independent review context may not be primed by the worker's account (PLAN §3.F)",
    );
    this.name = "ReviewContaminationError";
    this.excerpt = excerpt;
  }
}

/** Shortest claim fragment worth matching; below this, collisions are noise. */
export const MIN_CLAIM_FRAGMENT = 24;

/** Normalise whitespace and case so reformatted claim text still matches. */
function normaliseForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Refuse a prompt that contains the author's claim.
 *
 * Matching is on normalised sentence-ish fragments rather than the whole
 * string, because a claim pasted into a prompt is usually reflowed. Fragments
 * shorter than `MIN_CLAIM_FRAGMENT` are ignored: "Done." appearing in a diff
 * is not contamination, and a check that cried wolf would be disabled.
 *
 * This is the *second* line of defence. The first is `ReviewContext` having
 * nowhere to put a claim.
 */
export function assertClaimFree(prompt: string, claims: readonly string[]): void {
  const haystack = normaliseForMatch(prompt);
  for (const claim of claims) {
    for (const raw of claim.split(/(?<=[.!?\n])/)) {
      const fragment = normaliseForMatch(raw);
      if (fragment.length < MIN_CLAIM_FRAGMENT) continue;
      if (haystack.includes(fragment)) throw new ReviewContaminationError(raw.trim());
    }
    const whole = normaliseForMatch(claim);
    if (whole.length >= MIN_CLAIM_FRAGMENT && haystack.includes(whole)) {
      throw new ReviewContaminationError(claim.trim());
    }
  }
}
