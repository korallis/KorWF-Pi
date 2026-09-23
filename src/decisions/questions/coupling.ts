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
