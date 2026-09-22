/**
 * `/korwf plan <goal>` (issue #33; PLAN §2.1, §3.A, §2.7).
 *
 * Intake for both existing-repo and greenfield, plus the clarification loop.
 * A pure `runPlanIntake` so the command is testable without a Pi session; the
 * extension entry point supplies `ctx.cwd`, `ctx.ui`, and a session id.
 */
import { detectRepoIdentity, realGitRunner, type GitRunner } from "../../git/index.ts";
import { loadConfig, type ConfigLoadResult } from "../../config/index.ts";
import { openStore, resolveStorageRoot, type Store } from "../../storage/index.ts";
import type { WorkflowId } from "../../storage/records.ts";
import {
  buildWorkflow,
  deterministicClarificationQuestions,
  intakeSummary,
  parsePlanArgs,
  resolveRepo,
  runClarificationLoop,
  type ClarificationPrompt,
} from "../../workflow/index.ts";
import { configMessage } from "./config.ts";

/** The slice of Pi's `ctx` this command needs, declared structurally (ADR 0002). */
export interface PlanCommandContext {
  readonly cwd: string;
  readonly ui: ClarificationPrompt;
  /** Coordinator session id (`Workflow.sessionRefs.coordinatorSessionId`). */
  readonly sessionId: string;
}

export interface PlanIntakeDeps {
  readonly gitRunner?: GitRunner;
  readonly openStore?: typeof openStore;
  readonly loadConfig?: typeof loadConfig;
  readonly now?: () => string;
  readonly newId?: () => string;
}

let idCounter = 0;
function defaultNewId(): string {
  idCounter += 1;
  return `wf-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export interface PlanIntakeResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Run intake end to end: parse flags, detect the repository, run the
 * deterministic clarification loop, and persist a `Workflow` record with
 * `status: "planning"` through the store (issue #23).
 */
export async function runPlanIntake(
  args: string,
  ctx: PlanCommandContext,
  deps: PlanIntakeDeps = {},
): Promise<PlanIntakeResult> {
  const parsed = parsePlanArgs(args);
  if (parsed.goal.length === 0) {
    return {
      ok: false,
      message: "Usage: /korwf plan <goal> [--mode m] [--budget n] [--exclude glob]...",
    };
  }

  const configResult: ConfigLoadResult = (deps.loadConfig ?? loadConfig)(ctx.cwd);
  if (!configResult.ok) {
    return { ok: false, message: configMessage(configResult) };
  }
  const { config } = configResult;

  const detection = detectRepoIdentity(ctx.cwd, deps.gitRunner ?? realGitRunner);
  const fallbackName = ctx.cwd.split("/").filter((s) => s.length > 0).pop() ?? "workspace";
  const repo = resolveRepo(detection, fallbackName);

  const questions = deterministicClarificationQuestions({
    goal: parsed.goal,
    greenfield: repo.greenfield,
    exclusions: parsed.exclusions,
  });
  const clarification = await runClarificationLoop(questions, ctx.ui);

  const mode = parsed.mode ?? config.mode;
  const budgets = {
    ...config.budgets.workflow,
    maxSpendUsd: parsed.maxSpendUsd ?? config.budgets.workflow.maxSpendUsd,
  };

  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? defaultNewId;

  const workflow = buildWorkflow({
    goal: parsed.goal,
    repo,
    mode,
    budgets,
    exclusions: parsed.exclusions,
    coordinatorSessionId: ctx.sessionId,
    id: newId() as WorkflowId,
    now: now(),
  });

  const storageRoot = resolveStorageRoot(ctx.cwd, config.storage.path ?? undefined);
  const opener = deps.openStore ?? openStore;
  const { store } = opener({ storageRoot });
  let persisted;
  try {
    persisted = store.workflows.insert(workflow);
  } finally {
    (store as Store).close();
  }

  const summary = intakeSummary({
    workflow: persisted,
    repo,
    clarification,
    parseErrors: parsed.errors,
  });
  return { ok: true, message: summary };
}
