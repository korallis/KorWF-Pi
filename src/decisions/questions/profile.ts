/**
 * Task-profile questions (issue #59; PLAN §3.D "Task profile").
 *
 * "Jev characterises each task (domain, modality needs, reasoning depth,
 * context size, risk) independently of model names." That independence is
 * the whole design: this module describes the WORK, never a model. None of
 * the questions, prompts, options, or fallbacks below may mention a model
 * id, a provider name, or model-card text — `src/models/selection.ts` (#60)
 * is the only place that crosses from profile to model.
 *
 * Decomposition (per `.pi/skills/jev-orchestration/SKILL.md` §2 and the
 * proven question shapes in `scripts/orchestrate/run.mjs`
 * `profileAndSelect`): one bounded question per dimension, never a single
 * "what kind of task is this?":
 *
 *  - `profile.domain@1` (choice) — what kind of work the task mainly requires.
 *  - `profile.reasoning_depth@1` (score) — how much reasoning depth it needs.
 *  - `profile.context_size@1` (choice: small/medium/large) — how much of the
 *    repository/docs must be held in context at once.
 *
 * Modality and risk are NOT asked of Jev: modality comes from deterministic
 * attachment detection and risk from the task's own `riskClass` (issue #59
 * Scope) — both are structural facts already known to the caller, so asking
 * a model to guess them would just add noise and an unnecessary failure
 * mode.
 *
 * Every fallback is purely structural (PLAN §6 "every Jev-assisted decision
 * has a deterministic fallback"; PLAN §2.4 "the fallback must still produce
 * a usable profile with no Jev key"): domain from ownership-path heuristics,
 * depth `unknown`, context size from a structural size estimate.
 */
import { defineChoice, defineScore, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";

// ---------------------------------------------------------------------------
// profile.domain@1
// ---------------------------------------------------------------------------

/**
 * Minimal state for domain classification: the task's own description plus
 * its declared ownership paths (never a model name, never a card).
 */
export interface ProfileDomainState {
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly ownershipPaths: readonly string[];
}

function domainState(input: ProfileDomainState): JevState {
  return { goal: input.goal, acceptanceCriteria: input.acceptanceCriteria, ownershipPaths: input.ownershipPaths };
}

export const DOMAINS = ["frontend", "backend", "infra", "docs", "testing", "security", "unknown"] as const;
export type Domain = (typeof DOMAINS)[number];

/** Ordered path-prefix heuristics; first match wins. Purely structural. */
const DOMAIN_PATH_RULES: readonly { readonly prefix: string; readonly domain: Domain }[] = [
  { prefix: "test/", domain: "testing" },
  { prefix: "docs/", domain: "docs" },
  { prefix: "scripts/", domain: "infra" },
  { prefix: "src/security/", domain: "security" },
  { prefix: "src/extension/ui/", domain: "frontend" },
  { prefix: "src/config/", domain: "infra" },
  { prefix: "src/storage/", domain: "backend" },
];

/**
 * Deterministic fallback (no key / disabled / abstained): match ownership
 * paths against ordered prefix rules; `README.md`/`*.md` at the root counts
 * as `docs`; anything under `src/` with no more specific match is
 * `backend`; no ownership paths at all is `unknown` rather than a guess.
 */
export function domainFallbackVerdict(ownershipPaths: readonly string[]): Domain {
  if (ownershipPaths.length === 0) return "unknown";
  for (const path of ownershipPaths) {
    for (const rule of DOMAIN_PATH_RULES) {
      if (path.startsWith(rule.prefix)) return rule.domain;
    }
    if (path.endsWith(".md")) return "docs";
  }
  if (ownershipPaths.some((p) => p.startsWith("src/"))) return "backend";
  return "unknown";
}

export const profileDomainQuestion: QuestionDefinition<ProfileDomainState, Domain> = defineChoice<
  ProfileDomainState,
  Domain
>({
  id: "profile.domain",
  version: "1",
  prompt:
    "Given a task's `goal`, `acceptanceCriteria`, and `ownershipPaths`, what kind of work does completing it " +
    "mainly require? Answer `unknown` only when the task genuinely does not fit any of the other options.",
  options: {
    frontend: "User-facing UI, presentation logic, or client-side interaction",
    backend: "Server-side logic, data models, storage, or application services",
    infra: "Toolchain, packaging, CI, build/deploy process, or repository tooling",
    docs: "Writing or editing specifications, ADRs, or documentation; little or no code",
    testing: "Mainly writing tests, fixtures, or evaluation harnesses",
    security: "Permission boundaries, secret handling, or adversarial hardening",
    unknown: "Does not fit any of the above, or not enough information to tell",
  },
  minConfidence: 0.5,
  state: domainState,
  decide: (answer) => {
    const value = (DOMAINS as readonly string[]).includes(answer.choice) ? (answer.choice as Domain) : "unknown";
    return { value, rule: `domain:${value}`, action: value };
  },
  fallback: (input) => {
    const value = domainFallbackVerdict(input.ownershipPaths);
    return { value, rule: "ownership_path_heuristic", action: value };
  },
  replay: (action) => ((DOMAINS as readonly string[]).includes(action) ? (action as Domain) : null),
  boundaries: [
    { name: "no ownership paths is unknown", state: { goal: "g", acceptanceCriteria: [], ownershipPaths: [] }, expectFallback: "unknown" },
    { name: "test path is testing", state: { goal: "g", acceptanceCriteria: [], ownershipPaths: ["test/models/profile.test.ts"] }, expectFallback: "testing" },
    { name: "docs path is docs", state: { goal: "g", acceptanceCriteria: [], ownershipPaths: ["docs/adr/0001.md"] }, expectFallback: "docs" },
    { name: "plain markdown file is docs", state: { goal: "g", acceptanceCriteria: [], ownershipPaths: ["README.md"] }, expectFallback: "docs" },
    { name: "other src path is backend", state: { goal: "g", acceptanceCriteria: [], ownershipPaths: ["src/workflow/index.ts"] }, expectFallback: "backend" },
  ],
});

// ---------------------------------------------------------------------------
// profile.reasoning_depth@1
// ---------------------------------------------------------------------------

export interface ProfileDepthState {
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
}

function depthState(input: ProfileDepthState): JevState {
  return { goal: input.goal, acceptanceCriteria: input.acceptanceCriteria };
}

export const DEPTH_LEVELS = [
  "Mechanical: follow clear instructions, no design decisions",
  "Standard: ordinary feature work with a few local design decisions",
  "Deep: novel design, subtle concurrency, security, or many interacting constraints",
] as const;

/** Cheap, explainable signals of deep reasoning: never a semantic guess. */
const DEPTH_MARKERS = [
  "concurren", "race condition", "security", "architecture", "protocol",
  "consisten", "migration", "invariant", "deadlock", "cryptograph",
];

/**
 * Deterministic fallback: with no Jev, depth is reported `unknown` (issue
 * #59 Scope: "Fallback when disabled: domain from ownership path
 * heuristics; depth `unknown`") — a numeric guess here would silently rank
 * models on a fabricated signal, exactly what PLAN §3.D's independence rule
 * forbids. `unknown` is `null`; callers must treat it as "no depth signal",
 * never as the middle of the scale.
 */
export function depthFallbackVerdict(goal: string): number | null {
  const lower = goal.toLowerCase();
  if (DEPTH_MARKERS.some((m) => lower.includes(m))) return null;
  return null;
}

export const profileDepthQuestion: QuestionDefinition<ProfileDepthState, number | null> = defineScore<
  ProfileDepthState,
  number | null
>({
  id: "profile.reasoning_depth",
  version: "1",
  prompt:
    "Given a task's `goal` and `acceptanceCriteria`, how much reasoning depth does completing it need? Consider " +
    "whether it is mechanical instruction-following, ordinary feature work with a few local decisions, or novel " +
    "design work with many interacting constraints.",
  levels: [...DEPTH_LEVELS],
  minConfidence: 0.5,
  state: depthState,
  decide: (answer) => {
    const value = Math.round(answer.score) / (DEPTH_LEVELS.length - 1);
    return { value, rule: `depth:${Math.round(answer.score)}`, action: String(Math.round(answer.score)) };
  },
  fallback: (input) => ({ value: depthFallbackVerdict(input.goal), rule: "unknown", action: "unknown" }),
  replay: (action) => {
    if (action === "unknown") return null;
    return /^[0-2]$/.test(action) ? Number(action) / (DEPTH_LEVELS.length - 1) : null;
  },
  boundaries: [
    { name: "disabled always reports unknown", state: { goal: "add a logout button", acceptanceCriteria: [] }, expectFallback: null },
    { name: "security-flavoured goal still reports unknown without Jev", state: { goal: "harden the security boundary", acceptanceCriteria: [] }, expectFallback: null },
  ],
});

// ---------------------------------------------------------------------------
// profile.context_size@1
// ---------------------------------------------------------------------------

export interface ProfileContextSizeState {
  readonly ownershipPaths: readonly string[];
  readonly estimatedTokens: number | null;
}

function contextSizeState(input: ProfileContextSizeState): JevState {
  return { ownershipPaths: input.ownershipPaths, estimatedTokens: input.estimatedTokens };
}

export type ContextSize = "small" | "medium" | "large";
export const CONTEXT_SIZES: readonly ContextSize[] = ["small", "medium", "large"];

/**
 * Deterministic fallback: file-count buckets on the declared ownership
 * paths, the same kind of structural size proxy used elsewhere in this
 * module. Fewer than 3 files is `small`, 3-10 is `medium`, more is `large`;
 * zero files defaults to `small` (nothing declared to hold in context).
 */
export function contextSizeFallbackVerdict(ownershipPaths: readonly string[]): ContextSize {
  const n = ownershipPaths.length;
  if (n <= 2) return "small";
  if (n <= 10) return "medium";
  return "large";
}

export const profileContextSizeQuestion: QuestionDefinition<ProfileContextSizeState, ContextSize> = defineChoice<
  ProfileContextSizeState,
  ContextSize
>({
  id: "profile.context_size",
  version: "1",
  prompt:
    "Given a task's declared `ownershipPaths` and an optional `estimatedTokens` size, how much of the repository " +
    "and docs must an agent hold in context at once to complete it?",
  options: {
    small: "A few files",
    medium: "A module and its tests",
    large: "Many modules or long external documents",
  },
  minConfidence: 0.5,
  state: contextSizeState,
  decide: (answer) => {
    const value: ContextSize = CONTEXT_SIZES.includes(answer.choice as ContextSize) ? (answer.choice as ContextSize) : "small";
    return { value, rule: `context_size:${value}`, action: value };
  },
  fallback: (input) => {
    const value = contextSizeFallbackVerdict(input.ownershipPaths);
    return { value, rule: "path_count_heuristic", action: value };
  },
  replay: (action) => (CONTEXT_SIZES.includes(action as ContextSize) ? (action as ContextSize) : null),
  boundaries: [
    { name: "no paths is small", state: { ownershipPaths: [], estimatedTokens: null }, expectFallback: "small" },
    { name: "two paths is small", state: { ownershipPaths: ["a", "b"], estimatedTokens: null }, expectFallback: "small" },
    { name: "five paths is medium", state: { ownershipPaths: ["a", "b", "c", "d", "e"], estimatedTokens: null }, expectFallback: "medium" },
    { name: "eleven paths is large", state: { ownershipPaths: Array.from({ length: 11 }, (_, i) => `f${i}`), estimatedTokens: null }, expectFallback: "large" },
  ],
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Hashes as reviewed; editing prompt/options/levels without a version bump fails registration. */
export const PROFILE_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "profile.domain@1": profileDomainQuestion.contentHash,
  "profile.reasoning_depth@1": profileDepthQuestion.contentHash,
  "profile.context_size@1": profileContextSizeQuestion.contentHash,
});

export const profileQuestionRegistry = new QuestionRegistry();
for (const question of [profileDomainQuestion, profileDepthQuestion, profileContextSizeQuestion] as const) {
  profileQuestionRegistry.register(question as QuestionDefinition<unknown, unknown>, {
    pinnedHash: question.contentHash,
  });
}
