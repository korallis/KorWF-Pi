/**
 * Parsing planner output into a validated `PlanDocument` (issue #37).
 *
 * The reuse table (docs/pi-integration-map.md row 13) settled how a model
 * returns structured data here: a tool call with a typed schema, the same
 * mechanism `structured-output.ts` uses, so the payload arrives as JSON rather
 * than prose. That mechanism still yields *untrusted* JSON, and a model that
 * cannot call tools falls back to emitting JSON in a message, so this module
 * accepts both and is the single place either is turned into a plan.
 *
 * Two rules the issue requires:
 *
 * - Malformed output is rejected with **path-qualified** errors and produces a
 *   retry prompt. Nothing is persisted, not even the valid parts — the caller
 *   never sees a `PlanDocument` from a failed parse.
 * - The retry prompt quotes the actual findings, so a second attempt is not a
 *   blind re-roll.
 *
 * Pure: no I/O, no model call, no clock.
 */
import {
  formatPlanIssues,
  validatePlanDocument,
  type PlanDocument,
  type PlanIssue,
  type PlanValidation,
} from "./plan-schema.ts";

/** Outcome of parsing raw planner output. */
export type PlanParseResult =
  | { readonly ok: true; readonly plan: PlanDocument; readonly warnings: readonly PlanIssue[] }
  | {
      readonly ok: false;
      readonly errors: readonly PlanIssue[];
      readonly warnings: readonly PlanIssue[];
      /** Prompt to send back to the planner for attempt N+1. */
      readonly retryPrompt: string;
    };

/** Maximum bytes of planner output considered. Beyond this the output is refused. */
export const MAX_PLAN_BYTES = 512 * 1024;
