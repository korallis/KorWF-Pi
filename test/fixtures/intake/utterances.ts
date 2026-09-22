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

export const INTAKE_FIXTURES: readonly IntakeFixture[] = [
  // -- investigation (rule match) --
  { text: "Why does the login page crash on submit?", expectRules: "investigation", expectFinal: "investigation" },
  { text: "Investigate the flaky test in auth.spec.ts", expectRules: "investigation", expectFinal: "investigation" },
  { text: "Debug the memory leak in the worker pool", expectRules: "investigation", expectFinal: "investigation" },
  { text: "Figure out why the build is slow", expectRules: "investigation", expectFinal: "investigation" },
  { text: "Look into the intermittent 500 errors", expectRules: "investigation", expectFinal: "investigation" },
  { text: "Track down the race condition in the scheduler", expectRules: "investigation", expectFinal: "investigation" },
  { text: "Diagnose why deploys keep failing", expectRules: "investigation", expectFinal: "investigation" },

  // -- review (rule match) --
  { text: "Review this PR for security issues", expectRules: "review", expectFinal: "review" },
  { text: "Critique the new caching design", expectRules: "review", expectFinal: "review" },
  { text: "Check the changes I made to the parser", expectRules: "review", expectFinal: "review" },
  { text: "Any thoughts on this approach?", expectRules: "review", expectFinal: "review" },
  { text: "Feedback on the refactor please", expectRules: "review", expectFinal: "review" },

  // -- planning (rule match) --
  { text: "Plan the rollout for the new billing system", expectRules: "planning", expectFinal: "planning" },
  { text: "Design the API for the notifications service", expectRules: "planning", expectFinal: "planning" },
  { text: "Propose an approach for migrating the database", expectRules: "planning", expectFinal: "planning" },
  { text: "How should we structure the new module?", expectRules: "planning", expectFinal: "planning" },
  { text: "Outline the steps to add OAuth support", expectRules: "planning", expectFinal: "planning" },

  // -- implementation (rule match) --
  { text: "Add a login page with email and password", expectRules: "implementation", expectFinal: "implementation" },
  { text: "Fix the null pointer exception in UserService", expectRules: "implementation", expectFinal: "implementation" },
  { text: "Implement rate limiting for the API", expectRules: "implementation", expectFinal: "implementation" },
  { text: "Create a new endpoint for exporting reports", expectRules: "implementation", expectFinal: "implementation" },
  { text: "Refactor the payment module to use async/await", expectRules: "implementation", expectFinal: "implementation" },
  { text: "Update the README with install instructions", expectRules: "implementation", expectFinal: "implementation" },
  { text: "Remove the deprecated legacy auth flow", expectRules: "implementation", expectFinal: "implementation" },

  // -- explanation (rule match) --
  { text: "What does the retry logic do?", expectRules: "explanation", expectFinal: "explanation" },
  { text: "How does the caching layer work?", expectRules: "explanation", expectFinal: "explanation" },
  { text: "Explain the difference between a Task and a Phase", expectRules: "explanation", expectFinal: "explanation" },
  { text: "Describe how the scheduler picks the next task", expectRules: "explanation", expectFinal: "explanation" },
  { text: "Tell me about the architecture of the worker pool", expectRules: "explanation", expectFinal: "explanation" },
  { text: "What is a Jev score?", expectRules: "explanation", expectFinal: "explanation" },

  // -- clarification (rule match) --
  { text: "What do you mean by 'atomic property'?", expectRules: "clarification", expectFinal: "clarification" },
  { text: "Can you clarify what 'trivial fast path' means?", expectRules: "clarification", expectFinal: "clarification" },
  { text: "I don't understand the difference between shadow and advisory mode", expectRules: "clarification", expectFinal: "clarification" },
  { text: "Clarify what happens when the cap is hit", expectRules: "clarification", expectFinal: "clarification" },

  // -- bare-question explanation (rule match, distinguishes discuss from act) --
  { text: "Does this handle concurrent writes?", expectRules: "explanation", expectFinal: "explanation" },
  { text: "Is src/workflow/intake.ts covered by tests?", expectRules: "explanation", expectFinal: "explanation" },

  // -- no deterministic match: escalated to intake.classify@1 (mocked) --
  { text: "the payment flow is broken", expectRules: null, expectFinal: "investigation" },
  { text: "users are logged out randomly", expectRules: null, expectFinal: "investigation" },
  { text: "make it faster", expectRules: null, expectFinal: "implementation" },
  { text: "let's revisit the caching strategy sometime", expectRules: null, expectFinal: "planning" },

  // -- no deterministic match, genuinely ambiguous: must return unknown, never a guess --
  { text: "the new dashboard mockup", expectRules: null, expectFinal: "unknown", ambiguous: true },
  { text: "thanks!", expectRules: null, expectFinal: "unknown", ambiguous: true },
  { text: "ok let's go with option B", expectRules: null, expectFinal: "unknown", ambiguous: true },
  { text: "async", expectRules: null, expectFinal: "unknown", ambiguous: true },
];
