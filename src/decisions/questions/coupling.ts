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
