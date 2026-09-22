/**
 * Optional skill/tool discovery and ranking (issue #36; PLAN §3.B "Suggest
 * optional skills/tools; permit none or several; never override mandatory
 * skill-loading rules").
 *
 * This module never enumerates skills/tools itself — that requires the Pi
 * `ExtensionAPI` (`pi.getSkills()`/`ctx.getSystemPrompt()` structured
 * options, `pi.getAllTools()`), and domain modules never import
 * `extension/` (docs/adr/0002 layout boundary). Instead `src/extension/`
 * enumerates and passes plain `Capability` records in here.
 *
 * Two independent judgments, and only one of them ever touches Jev:
 *
 * 1. **Mandatory-trigger detection (`detectMandatoryTrigger`) is pure rule
 *    matching in code**, never a Jev call. A skill whose description reads
 *    "REQUIRED for ..." names its own trigger; if the task's keywords
 *    overlap that trigger clause, the capability is `required` and is
 *    *never* sent to `capability.relevance@1` — a suggestion is advisory,
 *    so nothing that is mandatory may ever be downgraded to a score.
 * 2. Every other capability is ranked by `capability.relevance@1`
 *    (`src/decisions/questions/capability.ts`), Jev-assisted with a
 *    deterministic keyword-overlap fallback, and included as `suggested`
 *    only if its score clears `threshold`. Permitting none or several is
 *    the point: nothing here forces a suggestion to be accepted, and an
 *    empty `suggested` list is a normal, valid result.
 */
import type { AskContext, DecisionResult } from "../decisions/ask.ts";
import { askAll } from "../decisions/ask.ts";
import {
  capabilityRelevanceQuestion,
  sharedKeywordCount,
  type CapabilityQuestionState,
} from "../decisions/questions/capability.ts";

/** Bound on capabilities ranked in one call, mirrors `context/rank.ts`. */
export const DEFAULT_MAX_CAPABILITIES = 30;

/** Default minimum `capability.relevance@1` score (0-2) to suggest. */
export const DEFAULT_SUGGEST_THRESHOLD = 2;

/** One installed skill or custom tool, as enumerated by `src/extension/`. */
export interface Capability {
  readonly name: string;
  readonly kind: "skill" | "tool";
  readonly description: string;
}

/** A suggested/required capability, with the evidence behind the verdict. */
export interface RankedCapability {
  readonly capability: Capability;
  /** `"required"` bypassed ranking entirely (mandatory trigger); `"suggested"` cleared the threshold. */
  readonly status: "required" | "suggested";
  /** The `"REQUIRED for ..."` clause that matched; `null` for a `"suggested"` entry. */
  readonly trigger: string | null;
  /** `null` for a `"required"` entry: mandatory status is never gated on a score. */
  readonly relevance: DecisionResult<number> | null;
}

export interface CapabilitySuggestions {
  /** Mandatory by rule; always included, in input order, never re-ordered by score. */
  readonly required: readonly RankedCapability[];
  /** Cleared the relevance threshold, highest score first. May be empty — a valid outcome. */
  readonly suggested: readonly RankedCapability[];
}

// ---------------------------------------------------------------------------
// mandatory-trigger detection (rule-based, never Jev)
// ---------------------------------------------------------------------------

/**
 * Skill descriptions that mandate loading phrase it as `"REQUIRED for ..."`
 * (see e.g. `.pi/skills/*\/SKILL.md` in this repo and `docs/skills.md`
 * "Description Best Practices"). This extracts every such clause, up to the
 * next sentence boundary.
 */
const REQUIRED_FOR_PATTERN = /required\s+for\s+([^.\n]+)/gi;

/**
 * True when `description` declares a `"REQUIRED for ..."` trigger whose
 * clause shares at least one keyword with `task` (PLAN §3.B "never override
 * mandatory skill-loading rules"; issue #36 AC "a skill whose description
 * says REQUIRED for a matching trigger is marked required regardless of Jev
 * score"). Pure rule matching — this never calls Jev, so a mandatory rule
 * can never be softened by a model's judgment.
 */
export function detectMandatoryTrigger(task: string, description: string): string | null {
  REQUIRED_FOR_PATTERN.lastIndex = 0;
  for (const match of description.matchAll(REQUIRED_FOR_PATTERN)) {
    const clause = match[1]?.trim();
    if (clause === undefined || clause.length === 0) continue;
    if (sharedKeywordCount(task, clause) >= 1) return clause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

export interface RankCapabilitiesOptions {
  /** Bound on capabilities *ranked* (not required ones) in one call. */
  readonly maxCandidates?: number;
  /** Minimum `capability.relevance@1` score (0-2) to suggest. */
  readonly threshold?: number;
  readonly reuse?: boolean;
}

function stateFor(task: string, capability: Capability): CapabilityQuestionState {
  return { task, name: capability.name, kind: capability.kind, description: capability.description };
}

/**
 * Split `capabilities` into `required` (mandatory-trigger matches, never
 * scored) and `suggested` (everything else, Jev-ranked against `task` with a
 * deterministic keyword-overlap fallback, kept only above `threshold`).
 * Permitting none or several is by design: `suggested` may be empty, and
 * nothing here loads a skill — this only classifies candidates for a caller
 * to present.
 */
export async function rankCapabilities(
  ctx: AskContext,
  task: string,
  capabilities: readonly Capability[],
  options: RankCapabilitiesOptions = {},
): Promise<CapabilitySuggestions> {
  const threshold = options.threshold ?? DEFAULT_SUGGEST_THRESHOLD;
  const bound = Math.max(1, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CAPABILITIES));
  const reuse = options.reuse ?? false;

  const required: RankedCapability[] = [];
  const rankable: Capability[] = [];
  for (const capability of capabilities) {
    const trigger = detectMandatoryTrigger(task, capability.description);
    if (trigger !== null) {
      required.push({ capability, status: "required", trigger, relevance: null });
    } else {
      rankable.push(capability);
    }
  }

  const bounded = rankable.slice(0, bound);
  if (bounded.length === 0) return { required, suggested: [] };

  const items = bounded.map((capability) => ({
    question: capabilityRelevanceQuestion,
    input: stateFor(task, capability),
    reuse,
  }));
  const results = await askAll(ctx, items);

  const suggested: RankedCapability[] = [];
  for (let i = 0; i < bounded.length; i += 1) {
    const capability = bounded[i];
    if (capability === undefined) continue;
    const relevance = results[i] as DecisionResult<number>;
    if (relevance.value >= threshold) {
      suggested.push({ capability, status: "suggested", trigger: null, relevance });
    }
  }
  suggested.sort((a, b) => (b.relevance?.value ?? 0) - (a.relevance?.value ?? 0));

  return { required, suggested };
}
