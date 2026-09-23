/**
 * `tasks.coupling@1` — the semantic-coupling signal (issue #76; PLAN §3.E
 * "Declared ownership conflicts detected in code; Jev adds a
 * semantic-coupling signal; default to serial when coupling is uncertain").
 *
 * This question is asked about a pair of tasks whose *declared ownership is
 * already known to be disjoint*. It exists for the case declared ownership
 * cannot see: two tasks that touch different files but the same API
 * contract, schema, or wire format, so that running them at once produces
 * two locally-correct changes that do not compose.
 *
 * Two properties are deliberate:
 *
 *  - It can only **subtract** concurrency. `src/workflow/coupling.ts`
 *    consults it only after the deterministic ownership check has already
 *    passed, so an `independent` answer never unblocks an overlap.
 *  - Its fallback is `unknown`, and `unknown` serialises. With no Jev key,
 *    an abstention, a validation failure or a deadline, this question's
 *    answer is the one that gives up concurrency rather than the one that
 *    takes a risk — the product is correct without Jev and merely slower.
 */
import { defineChoice, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";
import type { CouplingVerdict } from "../../workflow/scheduler.ts";

/** One side of the pair, as the question sees it. */
export interface CouplingTaskView {
  readonly id: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly ownershipPaths: readonly string[];
  readonly ownershipComponents: readonly string[];
}

/** Minimal state for one coupling evaluation: exactly two task summaries. */
export interface CouplingState {
  readonly a: CouplingTaskView;
  readonly b: CouplingTaskView;
}

/**
 * Minimal relevant state (PLAN §6): the two tasks' goals, criteria and
 * declared ownership — nothing else. No file contents, no diffs, no repo
 * paths beyond the patterns the planner already wrote down, so this question
 * cannot become a channel for sending the user's source outbound. The
 * outbound policy (#28) filters it again regardless.
 *
 * The pair is ordered canonically by task id so that asking about (a, b) and
 * (b, a) produces the same state hash and therefore the same cache key.
 */
export function couplingState(input: CouplingState): JevState {
  const [first, second] = input.a.id <= input.b.id ? [input.a, input.b] : [input.b, input.a];
  return { taskA: viewState(first), taskB: viewState(second) };
}

function viewState(view: CouplingTaskView): Readonly<Record<string, unknown>> {
  return {
    id: view.id,
    goal: view.goal,
    acceptanceCriteria: view.acceptanceCriteria,
    ownership: { paths: view.ownershipPaths, components: view.ownershipComponents },
  };
}

/**
 * The deterministic fallback, used whenever Jev does not produce a usable
 * answer: no key, disabled, abstained, low confidence, validation failure,
 * deadline, transport error.
 *
 * It is a constant, and that is the design. Any structural heuristic here
 * ("same component word in both goals" and so on) would be a semantic guess
 * dressed as a rule, and a wrong guess in the `independent` direction is an
 * uncontrolled concurrent write. `unknown` is the only answer this function
 * can give that is safe in every case, and `canRunConcurrently` turns it
 * into serial execution.
 */
export const COUPLING_FALLBACK_VERDICT: CouplingVerdict = "unknown";

function view(id: string, goal: string, paths: readonly string[]): CouplingTaskView {
  return { id, goal, acceptanceCriteria: [], ownershipPaths: paths, ownershipComponents: [] };
}

/**
 * `tasks.coupling@1` — Choice over `independent` / `coupled` / `unknown`.
 *
 * `unknown` is an explicit option rather than an abstention artefact (PLAN
 * §6 "explicit none/unknown outcomes"): a model that cannot tell should say
 * so, and saying so has the same effect as not answering — serial.
 */
export const tasksCouplingQuestion: QuestionDefinition<CouplingState, CouplingVerdict> = defineChoice<
  CouplingState,
  CouplingVerdict
>({
  id: "tasks.coupling",
  version: "1",
  prompt:
    "Two tasks, `taskA` and `taskB`, are about to run at the same time in separate git worktrees by two " +
    "different workers. Their declared file ownership has already been checked and does not overlap, so they " +
    "will not edit the same files. Could completing them concurrently still produce changes that do not compose " +
    "— for example because both change the same API contract, data schema, wire format, configuration key or " +
    "shared invariant from different files, or because one task's correct result depends on a decision the " +
    "other is making? Answer `coupled` if concurrent work is likely to conflict semantically, `independent` " +
    "only if you are confident the two can proceed without coordination, and `unknown` whenever the goals or " +
    "criteria do not give you enough to tell.",
  options: {
    independent: "The two tasks can be completed concurrently without coordinating; neither constrains the other",
    coupled:
      "Concurrent work is likely to conflict semantically — a shared contract, schema, format, key or invariant, " +
      "or one task's outcome depends on the other's decision",
    unknown: "Not enough information in the goals, criteria and ownership to judge",
  },
  // A concurrency decision is not a coin toss: a weakly-held `independent`
  // is exactly the answer that should become `unknown`, and therefore serial.
  minConfidence: 0.7,
  revisionSensitive: false,
  state: couplingState,
  decide: (answer) => {
    const value: CouplingVerdict =
      answer.choice === "independent" || answer.choice === "coupled" ? answer.choice : "unknown";
    return { value, rule: `coupling:${value}`, action: value };
  },
  fallback: () => ({ value: COUPLING_FALLBACK_VERDICT, rule: "fallback", action: COUPLING_FALLBACK_VERDICT }),
  replay: (action) =>
    action === "independent" || action === "coupled" || action === "unknown" ? action : null,
  boundaries: [
    {
      name: "disabled Jev on two obviously separate tasks is still unknown",
      state: {
        a: view("t1", "add a logout button to the header", ["src/ui/header.tsx"]),
        b: view("t2", "fix a typo in the README", ["README.md"]),
      },
      expectFallback: "unknown",
      note: "The fallback never says independent; without Jev the pair serialises (PLAN §3.E).",
    },
    {
      name: "two tasks changing the same response shape from different files",
      state: {
        a: view("t3", "add a `total` field to the /orders response", ["src/api/orders.ts"]),
        b: view("t4", "consume the /orders response in the dashboard", ["src/ui/dashboard.tsx"]),
      },
      expectFallback: "unknown",
      note: "Semantically coupled, but the fallback cannot know that — unknown serialises it anyway.",
    },
    {
      name: "empty goals",
      state: { a: view("t5", "", []), b: view("t6", "", []) },
      expectFallback: "unknown",
    },
  ],
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Hash as reviewed; editing the prompt or options without a version bump fails registration. */
export const COUPLING_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "tasks.coupling@1": tasksCouplingQuestion.contentHash,
});

export const couplingQuestionRegistry = new QuestionRegistry();
couplingQuestionRegistry.register(tasksCouplingQuestion as QuestionDefinition<unknown, unknown>, {
  pinnedHash: tasksCouplingQuestion.contentHash,
});
