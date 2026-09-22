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
