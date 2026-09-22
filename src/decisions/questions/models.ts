/**
 * `models.rank@1` (issue #60; PLAN §3.D "Selection").
 *
 * One noul question per candidate: "is this candidate model adequate for
 * this task profile?" — never a single question asking Jev to pick from a
 * list, so adding a candidate cannot change another candidate's score
 * (`.pi/skills/jev-orchestration/SKILL.md` §2). `src/models/select.ts`
 * asks it once per eligible candidate and ranks the results in code.
 *
 * The state is a minimal card summary plus the task profile — never a bare
 * model id with no aptitude data attached (PLAN §3.D "Jev ranks against
 * cards, not bare IDs"). An unrated card (no hint/override/outcome data)
 * still gets a state, but its `rated: false` flag is visible to Jev, which
 * is the honest "not enough information" signal — the deterministic
 * fallback below never guesses `true` for it.
 *
 * Fallback (no key / transport failure / abstention): always `false`
 * ("not adequate"). A missing or low-confidence Jev signal must never make
 * a candidate look better than it would with no signal at all — that would
 * let an unreachable Jev silently widen selection, which PLAN §3.D forbids.
 * `src/models/select.ts` is what turns "everything fell back" into the
 * static fallback order or an explicit "none adequate" / "insufficient
 * info", not this question.
 */
import { defineNoul, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";

/** Minimal, credential-free card summary sent to Jev for one candidate. */
export interface ModelRankCardSummary {
  readonly ref: string;
  readonly aptitudes: readonly string[];
  readonly notes: string | null;
  readonly rated: boolean;
}

/** Task profile fields, independent of any model (#59). */
export interface ModelRankProfileSummary {
  readonly domain: string;
  readonly modalities: readonly string[];
  readonly reasoningDepth: number;
  readonly contextSize: number;
  readonly risk: string;
}

export interface ModelRankState {
  readonly profile: ModelRankProfileSummary;
  readonly candidate: ModelRankCardSummary;
}

function toJevState(input: ModelRankState): JevState {
  return {
    profile: { ...input.profile, modalities: input.profile.modalities },
    candidate: { ...input.candidate, aptitudes: input.candidate.aptitudes },
  };
}

export const modelsRankQuestion: QuestionDefinition<ModelRankState, boolean> = defineNoul<ModelRankState, boolean>({
  id: "models.rank",
  version: "1",
  prompt:
    "Given a task `profile` (domain, modalities, reasoningDepth, contextSize, risk) and one candidate model's " +
    "`candidate` card (aptitudes, notes, whether it is rated), is this candidate adequate to complete the task " +
    "well? Answer `false` when the card has no aptitude data relevant to the profile (`rated: false`) rather " +
    "than guessing it would do fine.",
  criteria: {
    true: "The candidate's aptitudes and notes indicate it can handle this profile's domain, modality, depth and context needs",
    false: "The candidate lacks relevant aptitude data, or its aptitudes/notes indicate a poor fit for this profile",
  },
  abstainBand: [0.4, 0.6],
  state: toJevState,
  decide: (noul) => ({
    value: noul >= 0.5,
    rule: noul >= 0.5 ? "rank:adequate" : "rank:not_adequate",
    action: noul >= 0.5 ? "adequate" : "not_adequate",
  }),
  fallback: () => ({ value: false, rule: "no_signal", action: "not_adequate" }),
  replay: (action) => (action === "adequate" ? true : action === "not_adequate" ? false : null),
  boundaries: [
    {
      name: "disabled never guesses adequate",
      state: {
        profile: { domain: "backend", modalities: ["text"], reasoningDepth: 0.5, contextSize: 0.5, risk: "low" },
        candidate: { ref: "acme/model-1", aptitudes: ["backend"], notes: null, rated: true },
      },
      expectFallback: false,
    },
    {
      name: "unrated candidate never guesses adequate",
      state: {
        profile: { domain: "backend", modalities: ["text"], reasoningDepth: 0.5, contextSize: 0.5, risk: "low" },
        candidate: { ref: "acme/model-2", aptitudes: [], notes: null, rated: false },
      },
      expectFallback: false,
    },
  ],
});

export const MODELS_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "models.rank@1": modelsRankQuestion.contentHash,
});

export const modelsQuestionRegistry = new QuestionRegistry();
modelsQuestionRegistry.register(modelsRankQuestion as QuestionDefinition<unknown, unknown>, {
  pinnedHash: modelsRankQuestion.contentHash,
});
