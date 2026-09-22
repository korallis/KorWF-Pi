/**
 * `/korwf plan <goal>` intake (issue #33; PLAN §2.1, §3.A, §2.7).
 *
 * Pure logic: flag parsing, repository-identity interpretation, and the
 * clarification loop's deterministic rules, all offline-testable with no Pi
 * session and no Jev call. `src/extension/commands/plan.ts` is the thin
 * adapter that wires this to `ctx` and the store.
 *
 * PLAN §3.A: "Deterministic rules before semantic classification. Keep a
 * short path for trivial work." and "Never infer authorization for
 * irreversible actions from a Jev score." Nothing here calls Jev, and
 * nothing here grants an approval — clarification only shapes the intake
 * record.
 */
import type { RepoDetection } from "../git/status.ts";
import type { Budget, RepoIdentity, Workflow, WorkflowId, WorkflowMode } from "../storage/records.ts";

/** Policy version stamped on every Workflow created by this intake path. */
export const CURRENT_POLICY_VERSION = "1";

/** The zero-commit repository identity used for a freshly bootstrapped greenfield workflow. */
export const GREENFIELD_ROOT_COMMIT = "0".repeat(40);

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export type ParsedMode = WorkflowMode;

const KNOWN_MODES = ["shadow", "advisory", "supervised", "bounded_autonomous"] as const satisfies readonly WorkflowMode[];

export interface ParsedPlanArgs {
  readonly goal: string;
  readonly mode: ParsedMode | null;
  /** `null` when `--budget` was not given; parse failures are reported in `errors`. */
  readonly maxSpendUsd: number | null;
  readonly exclusions: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Parse `/korwf plan <goal> [--mode m] [--budget n] [--exclude glob]...`.
 *
 * The goal is everything not consumed by a recognised flag, order-independent,
 * joined back together in original order with single spaces. Unknown flags are
 * left in the goal text (so a goal that happens to contain `--` is not silently
 * eaten) but recognised flags with an invalid value are reported in `errors`
 * rather than guessed at — a malformed `--budget` must not silently become "no cap".
 */
export function parsePlanArgs(raw: string): ParsedPlanArgs {
  const tokens = tokenize(raw);
  const goalParts: string[] = [];
  const exclusions: string[] = [];
  const errors: string[] = [];
  let mode: ParsedMode | null = null;
  let maxSpendUsd: number | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "--mode") {
      const value = tokens[i + 1];
      i += 1;
      if (value === undefined) {
        errors.push("--mode requires a value");
      } else if (!isKnownMode(value)) {
        errors.push(`--mode: unknown mode "${value}" (expected one of ${KNOWN_MODES.join(", ")})`);
      } else {
        mode = value;
      }
      continue;
    }
    if (token === "--budget") {
      const value = tokens[i + 1];
      i += 1;
      if (value === undefined) {
        errors.push("--budget requires a numeric value");
      } else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          errors.push(`--budget: not a non-negative number: "${value}"`);
        } else {
          maxSpendUsd = parsed;
        }
      }
      continue;
    }
    if (token === "--exclude") {
      const value = tokens[i + 1];
      i += 1;
      if (value === undefined) {
        errors.push("--exclude requires a glob value");
      } else {
        exclusions.push(value);
      }
      continue;
    }
    goalParts.push(token);
  }

  return { goal: goalParts.join(" ").trim(), mode, maxSpendUsd, exclusions, errors };
}

function isKnownMode(value: string): value is ParsedMode {
  return (KNOWN_MODES as readonly string[]).includes(value);
}

/** Simple whitespace tokenizer with double-quote support, no shell semantics. */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

export interface ResolvedRepo {
  readonly greenfield: boolean;
  readonly repoIdentity: RepoIdentity;
  readonly baseRevision: string;
  readonly dirty: boolean;
}

/**
 * Turn a `RepoDetection` (src/git/status.ts) into the fields `Workflow`
 * needs. Greenfield gets a zero-SHA placeholder base revision; a real repo
 * bootstrap (its own issue, PLAN §2.7) replaces it once `git init` runs and
 * the first commit exists.
 */
export function resolveRepo(detection: RepoDetection, fallbackName: string): ResolvedRepo {
  if (detection.kind === "greenfield") {
    return {
      greenfield: true,
      dirty: false,
      baseRevision: GREENFIELD_ROOT_COMMIT,
      repoIdentity: { remoteUrl: null, rootCommit: GREENFIELD_ROOT_COMMIT, name: fallbackName },
    };
  }
  return {
    greenfield: false,
    dirty: detection.dirty,
    baseRevision: detection.identity.rootCommit,
    repoIdentity: detection.identity,
  };
}

// ---------------------------------------------------------------------------
// Clarification loop
// ---------------------------------------------------------------------------

/** One clarification question asked (or skipped) during intake. */
export interface ClarificationQuestion {
  readonly id: string;
  readonly prompt: string;
}

export interface ClarificationAnswer {
  readonly questionId: string;
  readonly prompt: string;
  /** `null` when the user skipped this question. */
  readonly answer: string | null;
}

/** Upper bound on clarification questions per intake (issue #33 Scope: "up to N questions"). */
export const MAX_CLARIFICATION_QUESTIONS = 5;

/**
 * The deterministic question set, evaluated before any semantic
 * classification (PLAN §3.A). Each question fires only when the goal text
 * gives no evidence the point is already settled — a short, well-specified
 * goal skips every question (the "short path for trivial work").
 */
export function deterministicClarificationQuestions(args: {
  readonly goal: string;
  readonly greenfield: boolean;
  readonly exclusions: readonly string[];
}): readonly ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const goal = args.goal.trim();

  if (goal.length === 0) {
    // Nothing to plan from; this is reported as an error by the caller, not
    // asked about here.
    return [];
  }

  if (goal.length < 12) {
    questions.push({
      id: "goal.underspecified",
      prompt: `"${goal}" is quite short. What does success look like for this goal?`,
    });
  }

  if (args.greenfield && !/\b(cli|api|service|app|library|package|script|web|server)\b/i.test(goal)) {
    questions.push({
      id: "greenfield.kind",
      prompt: "This is a new (greenfield) project. What kind of thing are you building (CLI, API, library, web app, ...)?",
    });
  }

  if (args.exclusions.length === 0 && /\ball\b|\beverything\b|\bwhole\b/i.test(goal)) {
    questions.push({
      id: "scope.exclusions",
      prompt: "The goal mentions a broad scope. Is anything explicitly out of scope?",
    });
  }

  return questions.slice(0, MAX_CLARIFICATION_QUESTIONS);
}

/** The slice of Pi's `ctx.ui` the clarification loop needs. */
export interface ClarificationPrompt {
  readonly input: (title: string, placeholder?: string) => Promise<string | null | undefined> | string | null | undefined;
  /** `false` in print/RPC mode: no one to answer, and no TTY to hang on (issue #33 AC4). */
  readonly hasUI?: boolean;
}

export interface ClarificationResult {
  readonly answers: readonly ClarificationAnswer[];
  /** Why the loop produced no interaction, when it produced none. */
  readonly skippedReason: "no_questions" | "no_ui" | null;
}

/**
 * Ask the deterministic clarification questions, skipping cleanly (never
 * hanging) when there is no UI to answer them — issue #33 AC "non-interactive
 * mode (no TTY) skips clarification without hanging".
 */
export async function runClarificationLoop(
  questions: readonly ClarificationQuestion[],
  ui: ClarificationPrompt,
): Promise<ClarificationResult> {
  if (questions.length === 0) return { answers: [], skippedReason: "no_questions" };
  if (ui.hasUI === false) return { answers: [], skippedReason: "no_ui" };

  const answers: ClarificationAnswer[] = [];
  for (const question of questions) {
    const raw = await ui.input(question.prompt);
    const trimmed = typeof raw === "string" ? raw.trim() : null;
    answers.push({
      questionId: question.id,
      prompt: question.prompt,
      answer: trimmed !== null && trimmed.length > 0 ? trimmed : null,
    });
  }
  return { answers, skippedReason: null };
}

// ---------------------------------------------------------------------------
// Workflow assembly
// ---------------------------------------------------------------------------

export interface BuildWorkflowInput {
  readonly goal: string;
  readonly repo: ResolvedRepo;
  readonly mode: WorkflowMode;
  readonly budgets: Budget;
  readonly exclusions: readonly string[];
  readonly coordinatorSessionId: string;
  readonly id: WorkflowId;
  readonly now: string;
}

/**
 * Build the `Workflow` record for a fresh intake. Status is always
 * `planning`: intake alone does not produce a plan (that is the next issue),
 * so a workflow leaving this function has no phases yet.
 */
export function buildWorkflow(input: BuildWorkflowInput): Workflow {
  return {
    id: input.id,
    createdAt: input.now,
    updatedAt: input.now,
    schemaVersion: 1,
    kind: "mutable",
    goal: input.goal,
    repoIdentity: input.repo.repoIdentity,
    baseRevision: input.repo.baseRevision,
    exclusions: input.exclusions,
    mode: input.mode,
    budgets: input.budgets,
    policyVersion: CURRENT_POLICY_VERSION,
    sessionRefs: { coordinatorSessionId: input.coordinatorSessionId, workerSessionIds: [] },
    planRevision: 0,
    status: "planning",
  };
}

// ---------------------------------------------------------------------------
// Intake summary text
// ---------------------------------------------------------------------------

export function intakeSummary(args: {
  readonly workflow: Workflow;
  readonly repo: ResolvedRepo;
  readonly clarification: ClarificationResult;
  readonly parseErrors: readonly string[];
}): string {
  const { workflow, repo, clarification, parseErrors } = args;
  const lines: string[] = [`KorWF-Pi intake — workflow ${workflow.id}`, "", `  goal: ${workflow.goal}`];

  lines.push(
    repo.greenfield
      ? "  repository: greenfield (no commits yet; Phase 0 bootstrap required — PLAN §2.7)"
      : `  repository: existing — ${repo.repoIdentity.name} @ ${repo.baseRevision.slice(0, 12)}${repo.dirty ? " (working tree dirty)" : ""}`,
  );
  lines.push(`  mode: ${workflow.mode}`);
  lines.push(
    `  budget: ${workflow.budgets.maxSpendUsd === null ? "no cap set on this workflow" : `$${workflow.budgets.maxSpendUsd}`}`,
  );
  lines.push(
    `  exclusions: ${workflow.exclusions.length === 0 ? "none" : workflow.exclusions.join(", ")}`,
  );

  if (clarification.skippedReason === "no_ui") {
    lines.push("  clarification: skipped (non-interactive session)");
  } else if (clarification.skippedReason === "no_questions") {
    lines.push("  clarification: none needed");
  } else {
    lines.push("  clarification:");
    for (const answer of clarification.answers) {
      lines.push(`    - ${answer.prompt}`);
      lines.push(`      ${answer.answer === null ? "(skipped)" : answer.answer}`);
    }
  }

  if (parseErrors.length > 0) {
    lines.push("  flag errors:", ...parseErrors.map((e) => `    ! ${e}`));
  }

  lines.push("", "Status: intake recorded. Investigation and plan generation are the next step (separate command).");
  return lines.join("\n");
}
