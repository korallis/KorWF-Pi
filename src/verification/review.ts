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
