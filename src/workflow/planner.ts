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
  /**
   * Greenfield-only prompt lines appended when `intake.greenfield` is true
   * (typically `greenfieldPromptAddendum()` from `greenfield.ts`). Passed in
   * rather than imported, so this module never depends on `greenfield.ts`
   * (which itself reuses `greenfieldScaffoldingIssues` from here).
   */
  readonly greenfieldAddendum?: readonly string[];
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
  if (intake.greenfield && input.greenfieldAddendum !== undefined) lines.push("", ...input.greenfieldAddendum);
  return lines.join("\n");
}

/**
 * The non-negotiable rules, restated for the model. Every one of these is
 * also enforced by `validatePlanDocument`; a plan that breaks one is rejected
 * with a path-qualified error, not quietly repaired.
 */
export function planRulesText(limits?: ModelOutputLimits, thinking: ThinkingLevel = "off"): readonly string[] {
  const lines = [
    "## Rules (enforced in code — a plan that breaks one is rejected)",
    "",
    "1. **Every task carries at least one verification check.** A check is a test command, an assertion, a lint or typecheck invocation, or an explicitly required human check. A task with no checks is stored as `proposed` with the blocker `no_checks` and can never become ready (PLAN \u00a72.3). This is the point of the plan: the deterministic gate needs something to gate on.",
    "2. **Executable checks are command lines, not descriptions.** `npm test -- planner` is a check; \u201crun the tests and confirm they pass\u201d is not. Put the instruction in `command` for `kind: \"human\"` instead.",
    "3. **Every acceptance criterion should be covered** by at least one check's `coversCriteria`. Criteria are observable outcomes, not activities.",
    "4. **Tasks are atomic**: one observable outcome, one owner, one coherent set of files.",
    "5. **`dependencies` name task ids in this document**, form no cycle, and never point into a later phase.",
    "6. **Ownership paths are repository-relative.** Two tasks in the same phase that own the same path cannot run in parallel; prefer to merge or sequence them.",
    "7. **Phases are ordered 0,1,2,\u2026 with no gaps.** For a greenfield repository, phase 0 creates the repository and the test scaffolding, so later phases have checks that can run at all.",
  ];
  if (limits !== undefined) {
    lines.push(
      `8. **Size each task against the worker model's per-turn output ceiling** (\`maxTokens\` = ${limits.maxTokens ?? "unreported"}${thinking === "off" ? "" : `, thinking ${thinking}`}), not its context window. Declare \`expectedArtifacts\` for every file a task produces. An artifact estimated above the documented fraction of that ceiling must be split across tasks or produced in explicit incremental steps: a turn that exceeds the ceiling is cut off before its tool call is emitted and writes nothing.`,
    );
  } else {
    lines.push(
      "8. **Declare `expectedArtifacts`** for every file a task produces, with a size estimate. Tasks are sized against the worker model's per-turn output ceiling, not its context window.",
    );
  }
  lines.push("", "Return only the JSON document. No commentary before or after it.");
  return lines;
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

// ---------------------------------------------------------------------------
// Output-budget sizing of a generated plan (#124)
// ---------------------------------------------------------------------------

/**
 * Fallback limits used when the caller does not know which model will execute
 * the tasks. `outputBudget` substitutes the conservative floor for a `null`
 * ceiling, so sizing still happens rather than being skipped.
 */
export const UNKNOWN_WORKER_LIMITS: ModelOutputLimits = Object.freeze({ maxTokens: null, contextWindow: null });

/** Size every task's declared artifacts against the worker model's output ceiling. */
export function sizePlanTasks(
  plan: PlanDocument,
  limits: ModelOutputLimits = UNKNOWN_WORKER_LIMITS,
  thinking: ThinkingLevel = "off",
): readonly PlannedTaskSizing[] {
  return sizePlan(
    plan.tasks.map((task) => ({
      taskId: task.id,
      expectedArtifacts: (task.expectedArtifacts ?? []).map((a) => ({
        path: a.path,
        estimate: a.estimate,
        ...(a.atomic === true ? { atomic: true } : {}),
      })),
    })),
    limits,
    thinking,
  );
}

/** Tasks whose expected output cannot be produced in one turn as planned. */
export function tasksNeedingDecomposition(sizing: readonly PlannedTaskSizing[]): readonly string[] {
  return sizing.filter((s) => s.sizing.mustDecompose).map((s) => s.taskId);
}

// ---------------------------------------------------------------------------
// Generation loop
// ---------------------------------------------------------------------------

/**
 * The model call, supplied by the caller. Returns whatever the model produced:
 * a parsed object from a structured-output tool call, or raw text.
 * `src/workflow/` never imports Pi (ADR 0002), so this is a plain function.
 */
export type PlannerModel = (prompt: string, attempt: number) => Promise<unknown> | unknown;

/** One planner attempt, kept for `/korwf why` and for tests. */
export interface PlannerAttemptRecord {
  readonly attempt: number;
  readonly ok: boolean;
  readonly errors: readonly PlanIssue[];
  readonly warnings: readonly PlanIssue[];
  /** The retry prompt this attempt produced, when it failed. */
  readonly retryPrompt: string | null;
}

export interface GeneratePlanOptions {
  readonly intake: PlannerIntake;
  readonly context: readonly PlannerContextExcerpt[];
  readonly model: PlannerModel;
  readonly maxAttempts?: number;
  readonly workerLimits?: ModelOutputLimits;
  readonly workerThinking?: ThinkingLevel;
  readonly maxExcerptChars?: number;
  /** See `PlannerPromptInput.greenfieldAddendum`. */
  readonly greenfieldAddendum?: readonly string[];
}

export type GeneratePlanResult =
  | {
      readonly ok: true;
      readonly plan: PlanDocument;
      readonly warnings: readonly PlanIssue[];
      readonly attempts: readonly PlannerAttemptRecord[];
      /** Output-budget sizing for every task (#124). */
      readonly sizing: readonly PlannedTaskSizing[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly PlanIssue[];
      readonly attempts: readonly PlannerAttemptRecord[];
      /** Message suitable for the user, summarising why planning failed. */
      readonly message: string;
    };

/**
 * Run the planner: prompt, parse, and on failure re-prompt with the actual
 * findings, up to `maxAttempts`. A failed run returns errors and persists
 * nothing — there is no partial-plan path out of this function.
 */
export async function generatePlan(options: GeneratePlanOptions): Promise<GeneratePlanResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_PLAN_ATTEMPTS);
  const basePrompt = buildPlannerPrompt({
    intake: options.intake,
    context: options.context,
    ...(options.workerLimits === undefined ? {} : { workerLimits: options.workerLimits }),
    ...(options.workerThinking === undefined ? {} : { workerThinking: options.workerThinking }),
    ...(options.maxExcerptChars === undefined ? {} : { maxExcerptChars: options.maxExcerptChars }),
    ...(options.greenfieldAddendum === undefined ? {} : { greenfieldAddendum: options.greenfieldAddendum }),
  });

  const attempts: PlannerAttemptRecord[] = [];
  let prompt = basePrompt;
  let lastErrors: readonly PlanIssue[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw: unknown;
    try {
      raw = await options.model(prompt, attempt);
    } catch (error) {
      const issue: PlanIssue = {
        rule: "type",
        path: "",
        severity: "error",
        message: `planner model call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      attempts.push({ attempt, ok: false, errors: [issue], warnings: [], retryPrompt: null });
      lastErrors = [issue];
      continue;
    }

    const parsed: PlanParseResult = parsePlanOutput(raw);
    if (parsed.ok) {
      const warnings = options.intake.greenfield
        ? [...parsed.warnings, ...greenfieldScaffoldingIssues(parsed.plan)]
        : parsed.warnings;
      attempts.push({ attempt, ok: true, errors: [], warnings, retryPrompt: null });
      return {
        ok: true,
        plan: parsed.plan,
        warnings,
        attempts,
        sizing: sizePlanTasks(parsed.plan, options.workerLimits, options.workerThinking),
      };
    }
    attempts.push({
      attempt,
      ok: false,
      errors: parsed.errors,
      warnings: parsed.warnings,
      retryPrompt: parsed.retryPrompt,
    });
    lastErrors = parsed.errors;
    prompt = `${basePrompt}\n\n---\n\n${parsed.retryPrompt}`;
  }

  return {
    ok: false,
    errors: lastErrors,
    attempts,
    message:
      `Planning failed after ${maxAttempts} attempt(s); nothing was saved. Last findings:\n` +
      lastErrors.map((e) => `  ! ${e.path === "" ? "<root>" : e.path}: ${e.message} [${e.rule}]`).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Greenfield scaffolding (PLAN §2.3, §2.7)
// ---------------------------------------------------------------------------

/**
 * PLAN §2.3: "For greenfield projects the planner also produces the test
 * scaffolding as early tasks."
 *
 * Checked rather than assumed: in an empty repository every check a later task
 * registers is unrunnable until something can run tests at all, so a
 * greenfield plan whose first phase builds no scaffolding produces tasks that
 * are `ready` on paper and blocked in practice.
 *
 * Reported as warnings — the user may legitimately be adding to a project
 * whose harness arrives another way — but reported, never inferred away.
 */
export function greenfieldScaffoldingIssues(plan: PlanDocument): readonly PlanIssue[] {
  const first = plan.phases.find((p) => p.order === 0);
  if (first === undefined) return [];
  const firstPhaseTasks = plan.tasks.filter((t) => t.phaseId === first.id);
  if (firstPhaseTasks.length === 0) return [];
  const scaffolds = firstPhaseTasks.some((task) =>
    task.checks.some((check) => check.kind === "command" || check.kind === "typecheck" || check.kind === "lint"),
  );
  if (scaffolds) return [];
  return [
    {
      rule: "no_checks",
      path: `phases[${plan.phases.indexOf(first)}]`,
      severity: "warning",
      message:
        `greenfield plan: phase "${first.id}" registers no executable check, so nothing in it can ` +
        `establish a runnable test harness. Later tasks' checks will have no runner (PLAN \u00a72.3, \u00a72.7).`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no model available at all)
// ---------------------------------------------------------------------------

/**
 * A valid, honest plan produced with no model call.
 *
 * It contains exactly one task — "write the plan" — with a human check, so it
 * satisfies PLAN §2.3 without pretending to know work it has not analysed. It
 * exists so `/korwf plan` degrades to something inspectable instead of an
 * error when no model is configured or every attempt failed (AGENTS.md §4:
 * every assisted decision has a deterministic fallback).
 */
export function deterministicPlanSkeleton(intake: PlannerIntake): PlanDocument {
  const task: PlanTask = {
    id: "t1",
    phaseId: "p1",
    goal: `Decompose the goal into phases, tasks and per-task checks by hand: ${intake.goal}`,
    acceptanceCriteria: [
      { id: "ac1", text: "Every phase has acceptance criteria and every task has at least one verification check." },
      { id: "ac2", text: "The task dependency graph is acyclic and no task depends on a later phase." },
    ],
    checks: [
      {
        id: "c1",
        kind: "human",
        command:
          "Review the plan: confirm each task is atomic, has an observable acceptance criterion, and has an executable check.",
        cwd: ".",
        expectedExitCode: 0,
        coversCriteria: ["ac1", "ac2"],
        required: true,
        rationale: "No model was available to plan, so a person must supply the decomposition.",
      },
    ],
    ownership: { paths: [], components: ["plan"] },
    dependencies: [],
    riskClass: "low",
  };
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    architectureSummary:
      `No planner model was available, so no architecture was analysed. This is a placeholder plan for ` +
      `"${intake.goal}" in ${intake.greenfield ? "a new repository" : intake.repoName}; replace it with a real plan ` +
      `before running any phase.`,
    phases: [
      {
        id: "p1",
        order: 0,
        goal: "Produce a real plan",
        acceptanceCriteria: [{ id: "pac1", text: "A reviewed plan with phases, tasks and per-task checks exists." }],
      },
    ],
    tasks: [task],
    openQuestions: ["Everything: this plan was generated deterministically with no model call."],
  };
}
