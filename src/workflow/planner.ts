/**
 * Structured plan generation (issue #37; PLAN §2.1, §2.3, §3.C).
 *
 * The planner role — a coding model, never Jev — turns intake plus retrieved
 * context into a `PlanDocument`. This module owns:
 *
 * - the prompt template that embeds the intake, the retrieved context with its
 *   provenance, and the plan schema;
 * - the generate → parse → retry loop, bounded and deterministic;
 * - output-budget annotation of the resulting tasks via
 *   `output-budget.ts` (`sizePlan` / `sizeTaskOutput`), so a task whose
 *   expected artifact cannot be produced in one turn is decomposed or flagged
 *   *at planning time* rather than discovered when a worker is truncated.
 *
 * No Pi import and no transport: the caller passes a `PlannerModel` function.
 * With no model available at all, `deterministicPlanSkeleton` produces a
 * single-phase plan that states what must be planned by hand — the system
 * still works with no Jev key and no model call (AGENTS.md §4).
 */
import type { Provenance } from "../storage/records.ts";
import { parsePlanOutput, type PlanParseResult } from "./plan-parse.ts";
import {
  PLAN_CHECK_KINDS,
  PLAN_RISK_CLASSES,
  PLAN_SCHEMA_VERSION,
  type PlanDocument,
  type PlanIssue,
  type PlanTask,
} from "./plan-schema.ts";
import {
  sizePlan,
  type ModelOutputLimits,
  type PlannedTaskSizing,
  type ThinkingLevel,
} from "./output-budget.ts";

/** Default number of planner attempts, including the first. */
export const DEFAULT_PLAN_ATTEMPTS = 3;

/** One retrieved excerpt as the planner sees it (from `src/context/`). */
export interface PlannerContextExcerpt {
  readonly text: string;
  readonly provenance: Provenance;
  /** `true` for user pins and required instructions: never dropped (PLAN §3.B). */
  readonly pinned?: boolean;
}

/** Everything the prompt embeds about the request. */
export interface PlannerIntake {
  readonly goal: string;
  readonly greenfield: boolean;
  readonly repoName: string;
  readonly baseRevision: string;
  readonly exclusions: readonly string[];
  readonly mode: string;
  /** Clarification answers gathered by `intake.ts`, already filtered of skips. */
  readonly clarifications: readonly { readonly prompt: string; readonly answer: string }[];
}

// ---------------------------------------------------------------------------
// The schema, as the planner is told it
// ---------------------------------------------------------------------------

/**
 * The plan schema in the exact shape a model is asked to produce. Generated
 * from the constants in `plan-schema.ts` rather than retyped, so the prompt
 * and the validator can never describe different contracts.
 */
export function planSchemaText(): string {
  return [
    "{",
    `  "schemaVersion": ${PLAN_SCHEMA_VERSION},`,
    '  "architectureSummary": "<prose: the architecture this plan assumes or creates>",',
    '  "openQuestions": ["<anything you could not settle>"],',
    '  "phases": [',
    "    {",
    '      "id": "p1",',
    '      "order": 0,',
    '      "goal": "<what this phase delivers>",',
    '      "acceptanceCriteria": [{ "id": "pac1", "text": "<observable outcome>" }],',
    '      "integrationBranch": "<optional branch name>"',
    "    }",
    "  ],",
    '  "tasks": [',
    "    {",
    '      "id": "t1",',
    '      "phaseId": "p1",',
    '      "goal": "<one atomic, observable unit of work>",',
    '      "acceptanceCriteria": [{ "id": "ac1", "text": "<observable outcome>" }],',
    '      "checks": [',
    "        {",
    '          "id": "c1",',
    `          "kind": "${PLAN_CHECK_KINDS.join(" | ")}",`,
    '          "command": "<exact command line; for kind=human, the instruction>",',
    '          "cwd": ".",',
    '          "expectedExitCode": 0,',
    '          "coversCriteria": ["ac1"],',
    '          "required": true,',
    '          "rationale": "<why this is the right evidence>"',
    "        }",
    "      ],",
    '      "ownership": { "paths": ["src/example.ts"], "components": ["example"] },',
    '      "dependencies": [],',
    `      "riskClass": "${PLAN_RISK_CLASSES.join(" | ")}",`,
    '      "expectedArtifacts": [{ "path": "src/example.ts", "estimate": { "unit": "lines", "value": 120 } }]',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}
