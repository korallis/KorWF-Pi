/**
 * Task-profile evaluator (issue #59; PLAN §3.D "Task profile").
 *
 * Composes the three versioned questions in
 * `src/decisions/questions/profile.ts` (domain, reasoning depth, context
 * size) with two purely structural signals — modality (deterministic
 * attachment detection) and risk (the task's own `riskClass`) — into a
 * `TaskProfile` (`src/storage/records.ts`).
 *
 * Independence rule (PLAN §3.D, restated in the issue): "A profile that
 * mentions a model has leaked the answer into the question." This module
 * never imports `src/models/catalog.ts`, `cards.ts`, `cap-detect.ts`,
 * `availability.ts`, or `route.ts`, never receives a `ModelRef`, and never
 * produces one. `src/models/selection.ts` (#60) is the only place a profile
 * meets a model card.
 *
 * Works with no Jev key (PLAN §2.4): `buildProfileFallback` produces a
 * complete, usable `TaskProfile` from structural signals alone.
 */
import { ask, type AskContext } from "../decisions/ask.ts";
import {
  profileContextSizeQuestion,
  profileDepthQuestion,
  profileDomainQuestion,
  type ContextSize,
  type Domain,
} from "../decisions/questions/profile.ts";
import type { RiskClass, TaskProfile } from "../storage/records.ts";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One attachment declared on a task's intake, before any model selection. */
export interface TaskAttachment {
  /** `image`, `audio`, `pdf`, ... never a model id or provider name. */
  readonly kind: string;
}

/**
 * Everything `buildProfile` needs. All fields are facts about the WORK: no
 * model id, no provider name, no card text may ever appear here — enforced
 * at the type level by the absence of any such field, and at test time by
 * `assertProfileHasNoModelLeak`.
 */
export interface TaskProfileInput {
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly ownershipPaths: readonly string[];
  readonly riskClass: RiskClass;
  /** Deterministically detected, never inferred by Jev. */
  readonly attachments: readonly TaskAttachment[];
  /** Optional structural size hint (e.g. summed byte/token estimate of ownership paths). */
  readonly estimatedTokens?: number | null;
}

// ---------------------------------------------------------------------------
// Modality (deterministic; PLAN §3.D "modality needs")
// ---------------------------------------------------------------------------

/**
 * Modalities required by the task, derived purely from declared attachment
 * kinds plus the always-present `text` modality. No Jev call: modality is a
 * structural fact about what was attached, not a judgment.
 */
export function detectModalities(attachments: readonly TaskAttachment[]): readonly string[] {
  const kinds = new Set<string>(["text"]);
  for (const a of attachments) {
    const kind = a.kind.trim().toLowerCase();
    if (kind.length > 0) kinds.add(kind);
  }
  return [...kinds].sort();
}

// ---------------------------------------------------------------------------
// Numeric mapping for contextSize/reasoningDepth (TaskProfile fields are 0..1)
// ---------------------------------------------------------------------------

const CONTEXT_SIZE_VALUE: Readonly<Record<ContextSize, number>> = { small: 0, medium: 0.5, large: 1 };

/** Unknown reasoning depth (no Jev signal) reports the midpoint, not a guess in either direction. */
export const UNKNOWN_REASONING_DEPTH = 0.5;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Where each Jev-assisted dimension's value came from, for display/telemetry. */
export interface ProfileSources {
  readonly domain: "jev" | "fallback";
  readonly reasoningDepth: "jev" | "fallback";
  readonly contextSize: "jev" | "fallback";
}

export interface ProfileResult {
  readonly profile: TaskProfile;
  readonly sources: ProfileSources;
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no Jev key / disabled / abstained)
// ---------------------------------------------------------------------------

/**
 * Build a complete, usable `TaskProfile` from structural signals alone
 * (PLAN §2.4 "the system must work with no Jev key"; issue #59 Scope
 * "Fallback when disabled: domain from ownership path heuristics; depth
 * `unknown`"). Never calls Jev, never throws, deterministic for the same
 * input.
 *
 * `reasoningDepth` reports the neutral midpoint (`UNKNOWN_REASONING_DEPTH`)
 * rather than a low or high guess: `TaskProfile.reasoningDepth` is a fixed
 * `number`, so "unknown" cannot be represented as a distinct value there —
 * `sources.reasoningDepth === "fallback"` is the caller-visible signal that
 * this number carries no real depth information.
 */
export function buildProfileFallback(input: TaskProfileInput): ProfileResult {
  const domain = domainFallback(input.ownershipPaths);
  const contextSize = contextSizeFallback(input.ownershipPaths);
  return {
    profile: {
      domain,
      modalities: detectModalities(input.attachments),
      reasoningDepth: UNKNOWN_REASONING_DEPTH,
      contextSize: CONTEXT_SIZE_VALUE[contextSize],
      risk: input.riskClass,
    },
    sources: { domain: "fallback", reasoningDepth: "fallback", contextSize: "fallback" },
  };
}

function domainFallback(ownershipPaths: readonly string[]): Domain {
  return profileDomainQuestion.fallback({ goal: "", acceptanceCriteria: [], ownershipPaths }, "disabled").value;
}

function contextSizeFallback(ownershipPaths: readonly string[]): ContextSize {
  return profileContextSizeQuestion.fallback({ ownershipPaths, estimatedTokens: null }, "disabled").value;
}

// ---------------------------------------------------------------------------
// Jev-assisted build
// ---------------------------------------------------------------------------

/**
 * Build a `TaskProfile` by asking the three profile questions, with
 * modality and risk taken structurally as always. Every question's own
 * `ask()` fallback applies transparently when Jev is disabled, unreachable,
 * or abstains — this function never has to special-case that itself.
 */
export async function buildProfile(ctx: AskContext, input: TaskProfileInput): Promise<ProfileResult> {
  const domainResult = await ask(ctx, profileDomainQuestion, {
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria,
    ownershipPaths: input.ownershipPaths,
  });
  const depthResult = await ask(ctx, profileDepthQuestion, {
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria,
  });
  const contextResult = await ask(ctx, profileContextSizeQuestion, {
    ownershipPaths: input.ownershipPaths,
    estimatedTokens: input.estimatedTokens ?? null,
  });

  const reasoningDepth = depthResult.value ?? UNKNOWN_REASONING_DEPTH;

  return {
    profile: {
      domain: domainResult.value,
      modalities: detectModalities(input.attachments),
      reasoningDepth,
      contextSize: CONTEXT_SIZE_VALUE[contextResult.value],
      risk: input.riskClass,
    },
    sources: {
      domain: domainResult.source,
      reasoningDepth: depthResult.value === null ? "fallback" : depthResult.source,
      contextSize: contextResult.source,
    },
  };
}
