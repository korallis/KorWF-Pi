/**
 * Fixture set for free-text intake classification (issue #34 acceptance
 * criterion: "Fixture set of >= 40 utterances with expected class; rules
 * alone hit >= 60%, rules+mock-Jev hit 100%").
 *
 * `expectRules: null` marks utterances the deterministic rules are expected
 * to leave unclassified (escalated to `intake.classify@1`); `ambiguous: true`
 * marks utterances whose correct end-to-end answer is `"clarify"` — never a
 * guessed action.
 */
import type { IntakeClass } from "../../../src/workflow/intake-rules.ts";

export interface IntakeFixture {
  readonly text: string;
  /** Expected class from `classifyByRules` alone; `null` = no rule match. */
  readonly expectRules: IntakeClass | null;
  /** Expected end-to-end class once Jev (mocked) is consulted. */
  readonly expectFinal: IntakeClass | "unknown";
  /** True when this utterance is deliberately ambiguous (expectFinal must be "unknown"). */
  readonly ambiguous?: boolean;
}

export const INTAKE_FIXTURES: readonly IntakeFixture[] = [];
