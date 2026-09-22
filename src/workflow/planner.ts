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

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface PlannerPromptInput {
  readonly intake: PlannerIntake;
  readonly context: readonly PlannerContextExcerpt[];
  /** Output limits of the model that will *execute* the tasks, for sizing guidance. */
  readonly workerLimits?: ModelOutputLimits;
  readonly workerThinking?: ThinkingLevel;
  /** Characters of each excerpt embedded. Excerpts are truncated, never dropped silently. */
  readonly maxExcerptChars?: number;
}

export const DEFAULT_MAX_EXCERPT_CHARS = 1_200;

/**
 * Build the planner prompt: intake, retrieved context with full provenance,
 * the schema, and the rules that are enforced in code.
 *
 * The rules are restated here *and* enforced in `plan-schema.ts`. The prompt
 * exists to make a well-formed plan likely; the validator is what makes a
 * malformed one impossible to persist.
 */
export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const { intake } = input;
  const maxChars = input.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const lines: string[] = [
    "You are the planner. Produce a structured plan. You do not implement anything.",
    "",
    "## Goal",
    intake.goal,
    "",
    "## Repository",
    intake.greenfield
      ? `greenfield: no commits yet. Phase 0 must bootstrap the repository and its test scaffolding before any feature work (PLAN §2.7).`
      : `existing: ${intake.repoName} at ${intake.baseRevision.slice(0, 12)}`,
    `mode: ${intake.mode}`,
    `out of scope: ${intake.exclusions.length === 0 ? "nothing declared" : intake.exclusions.join(", ")}`,
  ];

  if (intake.clarifications.length > 0) {
    lines.push("", "## Clarifications from the user");
    for (const c of intake.clarifications) lines.push(`- ${c.prompt}`, `  ${c.answer}`);
  }

  lines.push("", "## Retrieved context");
  if (input.context.length === 0) {
    lines.push("(none retrieved; plan from the goal alone and record what you had to assume in openQuestions)");
  } else {
    for (const excerpt of input.context) lines.push(...renderExcerpt(excerpt, maxChars));
  }

  lines.push("", "## Output schema", "Return exactly one JSON document of this shape:", "", planSchemaText());
  lines.push("", ...planRulesText(input.workerLimits, input.workerThinking));
  return lines.join("\n");
}

function renderExcerpt(excerpt: PlannerContextExcerpt, maxChars: number): string[] {
  const p = excerpt.provenance;
  const range = p.range === null ? "whole file" : `lines ${p.range.startLine}-${p.range.endLine}`;
  const truncated = excerpt.text.length > maxChars;
  const body = truncated ? `${excerpt.text.slice(0, maxChars)}\n… [truncated]` : excerpt.text;
  return [
    "",
    `### ${p.path} (${range})`,
    `revision ${p.revision.slice(0, 12)} · retrieved by ${p.retrievalMethod} · sha256 ${p.contentHash.slice(0, 12)}` +
      (excerpt.pinned === true ? " · pinned (must be honoured)" : ""),
    "```",
    body,
    "```",
  ];
}
