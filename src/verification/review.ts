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
import {
  REVIEW_SEVERITIES,
  SEVERITY_RANK,
  clampReviewExcerpt,
  normaliseSeverity,
  reviewSeverityQuestion,
} from "../decisions/questions/review.ts";
import { ask, type AskContext } from "../decisions/ask.ts";
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

// ---------------------------------------------------------------------------
// Findings and dispositions
// ---------------------------------------------------------------------------

/** What the reviewer returns, before Jev grades it. Untrusted structured text. */
export interface RawFinding {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly description: string;
  /** The reviewer's own opinion of severity; normalised on ingest. */
  readonly suggestedSeverity: string;
  /** Acceptance criterion the finding bears on, when it names one. */
  readonly criterionId: string | null;
}

/**
 * What the user or policy decided to do about a finding (issue #48 Scope).
 *
 * `open` is the initial state and is deliberately included: a finding with no
 * decision yet is not "accepted", and the gate must see the difference.
 */
export type FindingDisposition = "open" | "fix" | "accept_with_reason" | "reject";

export const FINDING_DISPOSITIONS: readonly FindingDisposition[] = Object.freeze([
  "open",
  "fix",
  "accept_with_reason",
  "reject",
]);

/**
 * A finding after grading and disposition.
 *
 * `severity` is the *effective* severity: Jev's answer when it answered and
 * did not soften a reviewer blocker, otherwise the reviewer's suggestion.
 * Both are kept, because "Jev downgraded this" is exactly the thing an audit
 * needs to see.
 */
export interface ReviewFinding {
  readonly id: string;
  readonly location: { readonly path: string; readonly startLine: number; readonly endLine: number };
  readonly description: string;
  readonly suggestedSeverity: ReviewSeverity;
  readonly severity: ReviewSeverity;
  /** `"jev"` when the graded severity came from a validated Jev answer. */
  readonly severitySource: "jev" | "reviewer";
  readonly criterionId: string | null;
  readonly disposition: FindingDisposition;
  /** Required for `accept_with_reason` and `reject`; `null` otherwise. */
  readonly dispositionReason: string | null;
  /** Who dispositioned it. A `policy` actor can never clear a blocker. */
  readonly dispositionBy: { readonly kind: "user" | "policy"; readonly identity: string } | null;
  /** `Decision.id` of the `review.severity@1` row, when one was written. */
  readonly severityDecisionId: string | null;
}

/** Normalise a raw reviewer finding; an unknown severity stays `unknown`. */
export function ingestFinding(raw: RawFinding): ReviewFinding {
  const suggested = normaliseSeverity(raw.suggestedSeverity);
  return {
    id: raw.id,
    location: { path: raw.path, startLine: raw.startLine, endLine: raw.endLine },
    description: raw.description,
    suggestedSeverity: suggested,
    severity: suggested,
    severitySource: "reviewer",
    criterionId: raw.criterionId,
    disposition: "open",
    dispositionReason: null,
    dispositionBy: null,
    severityDecisionId: null,
  };
}

/**
 * Apply a graded severity to a finding.
 *
 * **Jev may raise a severity but never lower a reviewer's `blocker`.** PLAN
 * §2.4 says Jev cannot waive condition 3; a severity downgrade from `blocker`
 * to `nit` on a Jev answer alone would be exactly that waiver wearing a
 * different name. Lowering a blocker is a *disposition* — a human act with a
 * recorded reason — not a scoring outcome.
 */
export function applyGradedSeverity(
  finding: ReviewFinding,
  graded: { readonly severity: ReviewSeverity; readonly source: "jev" | "fallback"; readonly decisionId: string | null },
): ReviewFinding {
  const fromJev = graded.source === "jev";
  const wouldSoftenBlocker = finding.suggestedSeverity === "blocker" && graded.severity !== "blocker";
  const severity = !fromJev || wouldSoftenBlocker ? finding.suggestedSeverity : graded.severity;
  return {
    ...finding,
    severity,
    severitySource: severity === graded.severity && fromJev ? "jev" : "reviewer",
    severityDecisionId: graded.decisionId,
  };
}

/** Raised when a disposition is not a usable record. */
export class DispositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispositionError";
  }
}

/**
 * Record a disposition against a finding.
 *
 * Two rules, both structural:
 *
 * - `accept_with_reason` and `reject` need a non-empty reason. "Accepted"
 *   with no reason is indistinguishable from "ignored", and an audit cannot
 *   tell them apart later.
 * - A **blocking** finding can only be accepted or rejected by a `user`.
 *   Policy may dispose of a nit; it may not decide that a blocker does not
 *   matter, because that is the decision the human-approval class exists for
 *   (`src/workflow/approvals.ts`, #49).
 */
export function disposeFinding(
  finding: ReviewFinding,
  disposition: FindingDisposition,
  by: { readonly kind: "user" | "policy"; readonly identity: string },
  reason: string | null = null,
): ReviewFinding {
  if (disposition === "open") {
    throw new DispositionError("`open` is the initial state and cannot be applied as a disposition");
  }
  const needsReason = disposition === "accept_with_reason" || disposition === "reject";
  if (needsReason && (reason === null || reason.trim().length === 0)) {
    throw new DispositionError(`disposition ${disposition} on finding ${finding.id} requires a reason`);
  }
  if (needsReason && by.kind !== "user" && isBlockingSeverity(finding.severity)) {
    throw new DispositionError(
      `finding ${finding.id} is ${finding.severity}: only a user may ${disposition} it, not policy actor ${by.identity}`,
    );
  }
  return { ...finding, disposition, dispositionReason: reason, dispositionBy: by };
}

/**
 * Severities that block the gate. `unknown` is blocking on purpose: an
 * ungradable finding is an open question, and PLAN §2.4's whole point is that
 * an open question is not a pass.
 */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return severity === "blocker" || severity === "unknown";
}

/**
 * Is this finding still holding the gate?
 *
 * A blocking finding is unresolved unless it was explicitly accepted or
 * rejected by a user with a reason. `fix` does **not** resolve it: a claimed
 * fix is a claim, and the only thing that clears it is a recheck at a newer
 * revision (`recheckOutcome`).
 */
export function isUnresolvedBlocking(finding: ReviewFinding): boolean {
  if (!isBlockingSeverity(finding.severity)) return false;
  return !(
    (finding.disposition === "accept_with_reason" || finding.disposition === "reject") &&
    finding.dispositionBy?.kind === "user"
  );
}

/** Every unresolved blocking finding, most severe first then by id. */
export function blockingFindings(findings: readonly ReviewFinding[]): readonly ReviewFinding[] {
  return [...findings]
    .filter(isUnresolvedBlocking)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Review policy: which changes require an independent review
// ---------------------------------------------------------------------------

/** One policy rule: a change class and/or ownership globs that demand review. */
export interface ReviewPolicyRule {
  /** Human-readable id, reported as the reason review was required. */
  readonly id: string;
  /** Change classes this rule applies to; empty means "any class". */
  readonly changeClasses: readonly string[];
  /** Ownership globs (repo-relative); empty means "any path". */
  readonly paths: readonly string[];
  /** Lowest risk class this rule fires at. */
  readonly minRiskClass: "low" | "medium" | "high";
}

/** The configured review policy. */
export interface ReviewPolicy {
  readonly rules: readonly ReviewPolicyRule[];
  /**
   * Require review for every change, whatever the rules say. A config may
   * turn this on; turning it off never removes a rule, so the policy can only
   * be tightened by configuration, per AGENTS.md §4.
   */
  readonly reviewEverything: boolean;
}

const RISK_ORDER: Readonly<Record<"low" | "medium" | "high", number>> = { low: 0, medium: 1, high: 2 };

/**
 * The facts a requirement is computed from. **Every field comes from the plan
 * record or from `src/git/`.** There is no `workerSaysItIsSimple`, no
 * `selfAssessedRisk` and no attempt id: issue #48 AC3, "review requirement is
 * derived from policy, not from the worker's self-assessment", is true
 * because the worker's assessment is not in scope of this function.
 */
export interface ReviewSubject {
  readonly changeClass: string;
  readonly riskClass: "low" | "medium" | "high";
  /** Repository-relative paths the diff touches, from `src/git/`. */
  readonly touchedPaths: readonly string[];
}

/** Why review was (or was not) required. Machine-readable, for the receipt. */
export interface ReviewRequirement {
  readonly required: boolean;
  /** Ids of every rule that fired, in policy order. */
  readonly matchedRules: readonly string[];
  readonly reason: "review_everything" | "rule_matched" | "no_rule_matched";
}

/** Prefix match on path segments, the same comparison ownership uses. */
function pathMatches(path: string, prefix: string): boolean {
  const p = path.replace(/^\.\//, "").replace(/\/+$/, "");
  const q = prefix.replace(/^\.\//, "").replace(/\/+$/, "");
  if (q.length === 0) return true;
  return p === q || p.startsWith(`${q}/`);
}

/**
 * Does this change require an independent review?
 *
 * High risk always does, whatever the rules say: PLAN §2.4 (3) names review
 * for "change classes the policy specifies", and a policy that omitted the
 * high-risk class would be a policy that weakened itself, which AGENTS.md §4
 * forbids. So the high-risk clause is applied *on top of* the rules, exactly
 * as `task-gate.ts` applies the high-risk human-approval clause.
 */
export function reviewRequirement(policy: ReviewPolicy, subject: ReviewSubject): ReviewRequirement {
  const matched = policy.rules
    .filter((rule) => {
      if (RISK_ORDER[subject.riskClass] < RISK_ORDER[rule.minRiskClass]) return false;
      if (rule.changeClasses.length > 0 && !rule.changeClasses.includes(subject.changeClass)) return false;
      if (rule.paths.length > 0 && !subject.touchedPaths.some((p) => rule.paths.some((g) => pathMatches(p, g)))) {
        return false;
      }
      return true;
    })
    .map((rule) => rule.id);

  if (policy.reviewEverything) {
    return { required: true, matchedRules: matched, reason: "review_everything" };
  }
  if (subject.riskClass === "high") {
    return { required: true, matchedRules: [...matched, "high_risk_always"], reason: "rule_matched" };
  }
  if (matched.length > 0) return { required: true, matchedRules: matched, reason: "rule_matched" };
  return { required: false, matchedRules: [], reason: "no_rule_matched" };
}

/**
 * Shipped default policy. Conservative: anything that can change behaviour,
 * security posture or the project's own policy is reviewed from `low` risk
 * upwards; documentation-only changes are not.
 */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = Object.freeze({
  reviewEverything: false,
  rules: Object.freeze([
    Object.freeze({ id: "behaviour_change", changeClasses: ["behaviour", "mixed"], paths: [], minRiskClass: "low" }),
    Object.freeze({ id: "security_surface", changeClasses: [], paths: ["src/security"], minRiskClass: "low" }),
    Object.freeze({ id: "verification_surface", changeClasses: [], paths: ["src/verification"], minRiskClass: "low" }),
    Object.freeze({ id: "policy_surface", changeClasses: [], paths: ["src/config"], minRiskClass: "low" }),
    Object.freeze({ id: "medium_risk_any", changeClasses: [], paths: [], minRiskClass: "medium" }),
  ]) as readonly ReviewPolicyRule[],
});

// ---------------------------------------------------------------------------
// The review record
// ---------------------------------------------------------------------------

/** Which model produced a review, and which family it belongs to. */
export interface ReviewerIdentity {
  /** `provider/model` reference exactly as the allowlist spells it. */
  readonly model: string;
  /**
   * Model family, as declared by the model card — never parsed out of an id
   * here, because `src/models/` owns that mapping and two providers may
   * expose the same family under different ids (#125).
   */
  readonly family: string;
  /** Attempt the review ran in; must differ from the authoring attempt. */
  readonly attemptId: string;
}

/** A completed review at one revision. */
export interface ReviewRecord {
  readonly id: string;
  readonly taskId: string;
  readonly taskRevision: Revision;
  /** Exact revision reviewed. A recheck must be at a strictly newer one. */
  readonly revision: GitSha;
  readonly reviewer: ReviewerIdentity;
  /** Hash of the prompt actually sent; proves what the reviewer saw. */
  readonly promptHash: string;
  readonly findings: readonly ReviewFinding[];
  /** `id` of the earlier review this one rechecks, or `null`. */
  readonly rechecksReviewId: string | null;
}

/**
 * Did this review come from a different model family than the author's?
 *
 * `.pi/skills/jev-orchestration/SKILL.md` §4: the fabricated transcript was
 * caught by "an independent audit by a different model". A same-family
 * reviewer shares the author's blind spots, so this is *preferred* — it is
 * reported as a caveat on the evidence rather than a hard refusal, because a
 * single-family configuration must still be able to review at all.
 */
export function isDifferentFamily(reviewer: ReviewerIdentity, authorFamily: string | null): boolean {
  if (authorFamily === null) return true;
  return reviewer.family !== authorFamily;
}

/** Caveats recorded on the review evidence row. Facts, not opinions. */
export function reviewCaveats(review: ReviewRecord, authorFamily: string | null): readonly string[] {
  const caveats: string[] = [];
  if (!isDifferentFamily(review.reviewer, authorFamily)) {
    caveats.push(
      `reviewer family ${review.reviewer.family} matches the author's; ` +
        "an independent review is preferred from a different model family (PLAN §3.F)",
    );
  }
  const blocking = blockingFindings(review.findings);
  if (blocking.length > 0) {
    caveats.push(`${blocking.length} unresolved blocking finding(s): ${blocking.map((f) => f.id).join(", ")}`);
  }
  return caveats;
}

// ---------------------------------------------------------------------------
// Recheck at a newer revision
// ---------------------------------------------------------------------------

/** Why a recheck did or did not clear the blockers. Closed set. */
export type RecheckReason =
  | "cleared"
  | "not_a_recheck"
  | "same_revision"
  | "older_revision"
  | "still_blocking"
  | "no_blockers";

export interface RecheckOutcome {
  readonly cleared: boolean;
  readonly reason: RecheckReason;
  /** Finding ids still blocking after the recheck. */
  readonly stillBlocking: readonly string[];
}

/**
 * Does `recheck` clear the blocking findings of `original`?
 *
 * The revision comparison is the whole point of the function. A recheck at
 * the **same** revision is a second opinion on identical bytes; PLAN §2.4's
 * "at the exact revision" rule means only a *newer* revision can represent a
 * fix. Revisions are compared by the caller-supplied ordering, since a SHA
 * has none of its own: `isNewer(a, b)` must answer "is `a` a descendant of
 * `b`?", which only `src/git/` can know.
 */
export function recheckOutcome(
  original: ReviewRecord,
  recheck: ReviewRecord,
  isNewer: (candidate: GitSha, base: GitSha) => boolean,
): RecheckOutcome {
  const blockers = blockingFindings(original.findings);
  if (blockers.length === 0) return { cleared: true, reason: "no_blockers", stillBlocking: [] };
  if (recheck.rechecksReviewId !== original.id) {
    return { cleared: false, reason: "not_a_recheck", stillBlocking: blockers.map((f) => f.id) };
  }
  if (recheck.revision === original.revision) {
    return { cleared: false, reason: "same_revision", stillBlocking: blockers.map((f) => f.id) };
  }
  if (!isNewer(recheck.revision, original.revision)) {
    return { cleared: false, reason: "older_revision", stillBlocking: blockers.map((f) => f.id) };
  }
  const stillBlocking = blockingFindings(recheck.findings).map((f) => f.id);
  if (stillBlocking.length > 0) return { cleared: false, reason: "still_blocking", stillBlocking };
  return { cleared: true, reason: "cleared", stillBlocking: [] };
}

// ---------------------------------------------------------------------------
// The one predicate the task gate reads
// ---------------------------------------------------------------------------

/** Why review evidence does not satisfy condition 3. Closed set. */
export type ReviewGateReason =
  | "review_missing"
  | "review_stale_revision"
  | "review_not_independent"
  | "blocking_finding_unresolved";

export interface ReviewGateVerdict {
  readonly satisfied: boolean;
  readonly reasons: readonly ReviewGateReason[];
  /** Ids of findings still blocking; empty when satisfied. */
  readonly blocking: readonly string[];
}

/**
 * Condition-3 view of the reviews for one task.
 *
 * A **review is evidence, not authority**: this returns a verdict the gate
 * reads alongside its own checks. It cannot set `done`, it never returns a
 * `Task`, and a `satisfied: true` here means only "review does not refuse",
 * which the gate then conjoins with C0–C2.
 *
 * The chain is evaluated newest-first over rechecks, so a blocker raised at
 * revision A and cleared by a recheck at revision B is resolved, while the
 * same blocker "fixed" at revision A is not.
 */
export function reviewGateVerdict(args: {
  readonly required: boolean;
  readonly revision: GitSha;
  readonly taskRevision: Revision;
  readonly reviews: readonly ReviewRecord[];
  readonly authorAttemptId: string | null;
  readonly isNewer: (candidate: GitSha, base: GitSha) => boolean;
}): ReviewGateVerdict {
  if (!args.required) return { satisfied: true, reasons: [], blocking: [] };

  const atRevision = args.reviews.filter(
    (r) => r.revision === args.revision && r.taskRevision === args.taskRevision,
  );
  if (atRevision.length === 0) {
    const reason: ReviewGateReason = args.reviews.length === 0 ? "review_missing" : "review_stale_revision";
    return { satisfied: false, reasons: [reason], blocking: [] };
  }

  const independent = atRevision.filter(
    (r) => args.authorAttemptId === null || r.reviewer.attemptId !== args.authorAttemptId,
  );
  if (independent.length === 0) {
    return { satisfied: false, reasons: ["review_not_independent"], blocking: [] };
  }

  // Blockers from *any* review in the chain must be cleared, including ones
  // raised at an earlier revision: a fix that moved the revision forward is
  // only a fix if a recheck said so.
  const blocking = new Set<string>();
  for (const earlier of args.reviews) {
    const open = blockingFindings(earlier.findings);
    if (open.length === 0) continue;
    const rechecks = args.reviews.filter((r) => r.rechecksReviewId === earlier.id);
    const anyCleared = rechecks.some((r) => recheckOutcome(earlier, r, args.isNewer).cleared);
    if (!anyCleared) for (const f of open) blocking.add(f.id);
  }
  for (const review of independent) for (const f of blockingFindings(review.findings)) blocking.add(f.id);

  if (blocking.size > 0) {
    return { satisfied: false, reasons: ["blocking_finding_unresolved"], blocking: [...blocking].sort() };
  }
  return { satisfied: true, reasons: [], blocking: [] };
}

// ---------------------------------------------------------------------------
// Running a review
// ---------------------------------------------------------------------------

/**
 * The reviewing model, injected.
 *
 * Until Stage 5 workers exist the review runs in-process with the
 * structured-output approach (issue #48 Context), so this module takes a
 * function rather than spawning anything. It also means the tests never make
 * a live model call: they pass a deterministic reviewer.
 *
 * The signature is the contract: a reviewer receives a **prompt string** and
 * nothing else. It has no handle on the attempt, the claim, or the store.
 */
export type ReviewRunner = (prompt: string, context: ReviewContext) => Promise<readonly RawFinding[]>;

/** Grade one finding. Returns the reviewer's suggestion when Jev is absent. */
export type SeverityGrader = (
  finding: ReviewFinding,
  context: ReviewContext,
) => Promise<{ readonly severity: ReviewSeverity; readonly source: "jev" | "fallback"; readonly decisionId: string | null }>;

/**
 * The deterministic grader: the reviewer's own suggested severity, unchanged.
 *
 * This is the no-Jev-key path required by AGENTS.md §4, and it is the
 * question's declared fallback (`review.severity@1`), so the disabled path
 * and the abstention path agree by construction.
 */
export const suggestedSeverityGrader: SeverityGrader = (finding) =>
  Promise.resolve({ severity: finding.suggestedSeverity, source: "fallback", decisionId: null });

/**
 * Run one independent review and return the record.
 *
 * Order matters: the prompt is built, asserted claim-free, and only then
 * handed to the reviewer. `claims` is passed *solely* so the assertion can
 * check for its absence — it is never rendered, and `buildReviewerPrompt` has
 * no access to it.
 */
export async function runReview(args: {
  readonly id: string;
  readonly context: ReviewContext;
  readonly reviewer: ReviewerIdentity;
  readonly run: ReviewRunner;
  readonly grade?: SeverityGrader;
  /** Author claim text, for contamination checking only. */
  readonly claims?: readonly string[];
  readonly rechecksReviewId?: string | null;
}): Promise<ReviewRecord> {
  const prompt = buildReviewerPrompt(args.context);
  assertClaimFree(prompt, args.claims ?? []);

  const raw = await args.run(prompt, args.context);
  const grade = args.grade ?? suggestedSeverityGrader;
  const findings: ReviewFinding[] = [];
  for (const item of raw) {
    const ingested = ingestFinding(item);
    findings.push(applyGradedSeverity(ingested, await grade(ingested, args.context)));
  }

  return {
    id: args.id,
    taskId: args.context.taskId,
    taskRevision: args.context.taskRevision,
    revision: args.context.revision,
    reviewer: args.reviewer,
    promptHash: reviewPromptHash(prompt),
    findings,
    rechecksReviewId: args.rechecksReviewId ?? null,
  };
}

/**
 * Grader backed by `review.severity@1`.
 *
 * `ask()` never throws: a disabled transport, an error, an invalid response
 * and an abstention all land on the question's deterministic fallback, which
 * is the reviewer's suggestion. A `Decision` row is written on every path, so
 * "Jev graded this" and "the key was absent" are distinguishable afterwards
 * rather than being the same silent value.
 */
export function jevSeverityGrader(
  ctx: AskContext,
  options: { readonly subject?: { readonly taskId: string; readonly taskRevision: number } } = {},
): SeverityGrader {
  return async (finding, context) => {
    const criterion = context.criteria.find((c) => c.id === finding.criterionId) ?? null;
    const excerpt =
      context.diff.find(
        (h) =>
          h.path === finding.location.path &&
          h.startLine <= finding.location.endLine &&
          h.endLine >= finding.location.startLine,
      )?.patch ?? "";
    const where =
      options.subject === undefined
        ? {}
        : { subject: { taskId: options.subject.taskId as never, taskRevision: options.subject.taskRevision } };
    const result = await ask(
      ctx,
      reviewSeverityQuestion,
      {
        findingId: finding.id,
        location: finding.location,
        description: finding.description,
        suggested: finding.suggestedSeverity,
        criterion: criterion === null ? null : { id: criterion.id, text: criterion.text },
        excerpt: clampReviewExcerpt(excerpt),
        changeClass: context.changeClass,
      },
      where,
    );
    return {
      severity: result.value,
      source: result.source === "jev" ? "jev" : "fallback",
      decisionId: result.decisionId,
    };
  };
}

// ---------------------------------------------------------------------------
// A review, as evidence
// ---------------------------------------------------------------------------

/**
 * Turn a review into an `Evidence` draft for the gate to read.
 *
 * `exitStatus` is `exited 0` only when no blocking finding is unresolved —
 * `task-gate.ts` C3 counts a review row as passing on exactly that condition,
 * so a blocking finding refuses the gate through the evidence itself rather
 * than through a parallel code path that could drift.
 *
 * `reviewer.kind` is `"model"`: a review is never `deterministic` evidence,
 * so it can never stand in for a registered check under condition 1.
 */
export function reviewToEvidence(args: {
  readonly review: ReviewRecord;
  readonly workflowId: string;
  readonly requirementId: string;
  readonly authorFamily?: string | null;
}): {
  readonly checkId: null;
  readonly requirementId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly taskRevision: Revision;
  readonly revision: GitSha;
  readonly attemptId: string;
  readonly exitStatus: { readonly kind: "exited"; readonly code: number };
  readonly reviewer: { readonly kind: "model"; readonly model: string; readonly attemptId: string };
  readonly caveats: readonly string[];
  readonly promptHash: string;
} {
  const blocking = blockingFindings(args.review.findings);
  return {
    checkId: null,
    requirementId: args.requirementId,
    workflowId: args.workflowId,
    taskId: args.review.taskId,
    taskRevision: args.review.taskRevision,
    revision: args.review.revision,
    attemptId: args.review.reviewer.attemptId,
    exitStatus: { kind: "exited", code: blocking.length === 0 ? 0 : 1 },
    reviewer: { kind: "model", model: args.review.reviewer.model, attemptId: args.review.reviewer.attemptId },
    caveats: reviewCaveats(args.review, args.authorFamily ?? null),
    promptHash: args.review.promptHash,
  };
}
