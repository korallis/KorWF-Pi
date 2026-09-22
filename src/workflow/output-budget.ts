/**
 * Output-token budget awareness for planning (issue #124; docs/PRD.md §3.3,
 * PLAN §2.3, §3.C).
 *
 * Every assistant turn has a hard *output*-token ceiling (`maxTokens` in Pi's
 * model registry), shared with reasoning when thinking is high. A turn asked
 * to produce a large artifact in one tool call is cut off at
 * `stopReason: "length"` **before the tool call is emitted**, so nothing
 * reaches disk. Planning that sizes tasks against the *context window* misses
 * this entirely: the context window was never the binding constraint.
 *
 * This module is pure data + arithmetic. No I/O, no Jev, no Pi imports, no
 * clock: every function here is deterministic and therefore works unchanged
 * with Jev disabled (AC6).
 */

/** Thinking level as exposed by Pi's `thinkingLevelMap`; `off` means no reasoning tokens. */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * The two registry numbers that matter, kept as a local shape so
 * `src/workflow/` never imports Pi (ADR 0002 module boundaries).
 *
 * `maxTokens` is `null` when the registry does not report one — that is a
 * *known unknown*, not "unlimited", so the policy substitutes a conservative
 * floor rather than assuming room.
 */
export interface ModelOutputLimits {
  /** Output-token ceiling for a single turn. `null` when unreported. */
  readonly maxTokens: number | null;
  /** Total context window, kept only so the two can be compared explicitly. */
  readonly contextWindow: number | null;
}

/**
 * Conservative output ceiling assumed when the registry reports none. The
 * smallest ceiling observed across the models this project has run is 16384;
 * assuming less is safe (it only decomposes more), assuming more is the exact
 * failure this module exists to prevent.
 */
export const ASSUMED_MAX_OUTPUT_TOKENS = 16_384 as const;

/**
 * Fraction of `maxTokens` a single artifact may be expected to consume before
 * the planner must decompose it. Documented here because the acceptance
 * criterion requires a *documented* fraction.
 *
 * 0.5 is not tuning taste. A turn's output budget is shared between the
 * reasoning trace, the narration and the tool call carrying the file body, so
 * the body can have at most a fraction of the ceiling. Half leaves an equal
 * share for everything else; anything above that reproduces the #14 signature
 * (six attempts, ~400k tokens, zero files) whenever a model thinks at length.
 */
export const DECOMPOSE_FRACTION = 0.5 as const;

/**
 * Fraction above which a task is *warned* about even though it still fits.
 * Between `WARN_FRACTION` and `DECOMPOSE_FRACTION` the artifact is plausible
 * in one turn but leaves little headroom for reasoning, so the plan says so.
 */
export const WARN_FRACTION = 0.25 as const;

/**
 * Extra output budget reserved for reasoning at each thinking level, as a
 * fraction of `maxTokens`. Pi shares the output budget between reasoning and
 * the visible turn, so a high-thinking model has materially less room for a
 * tool call than its ceiling suggests.
 */
export const THINKING_RESERVE: Readonly<Record<ThinkingLevel, number>> = Object.freeze({
  off: 0,
  low: 0.1,
  medium: 0.25,
  high: 0.5,
});

/**
 * Tokens per source line, used to turn an estimate expressed in lines into
 * output tokens. Deliberately a round over-estimate: under-estimating output
 * size is the failure mode, over-estimating merely decomposes more.
 */
export const TOKENS_PER_LINE = 14 as const;

/** Tokens per byte of plain text (~4 characters per token, rounded down to be safe). */
export const BYTES_PER_TOKEN = 3.5 as const;

/** One artifact a task is expected to produce, as the planner describes it. */
export interface ExpectedArtifact {
  /** Repository-relative path or a planner-chosen label. Never absolute. */
  readonly path: string;
  /**
   * Expected size. `lines` and `bytes` are converted with the constants
   * above; `tokens` is taken as given.
   */
  readonly estimate:
    | { readonly unit: "tokens"; readonly value: number }
    | { readonly unit: "lines"; readonly value: number }
    | { readonly unit: "bytes"; readonly value: number };
  /**
   * `true` when the artifact genuinely cannot be produced in pieces (a single
   * generated blob). Such an artifact cannot be fixed by incremental writes,
   * so it is flagged for the planner rather than silently split.
   */
  readonly atomic?: boolean;
}

/** Convert any estimate to output tokens. */
export function estimateTokens(estimate: ExpectedArtifact["estimate"]): number {
  if (!Number.isFinite(estimate.value) || estimate.value < 0) {
    throw new Error(`estimateTokens: value must be a non-negative finite number, got ${String(estimate.value)}`);
  }
  switch (estimate.unit) {
    case "tokens":
      return Math.ceil(estimate.value);
    case "lines":
      return Math.ceil(estimate.value * TOKENS_PER_LINE);
    case "bytes":
      return Math.ceil(estimate.value / BYTES_PER_TOKEN);
  }
}

/** The usable single-turn output budget, after the reasoning reserve. */
export interface OutputBudget {
  /** Ceiling actually used: the registry's `maxTokens`, or the assumed floor. */
  readonly maxTokens: number;
  /** `true` when the registry reported no ceiling and the floor was assumed. */
  readonly assumed: boolean;
  readonly thinking: ThinkingLevel;
  /** Tokens reserved for reasoning at this thinking level. */
  readonly reasoningReserve: number;
  /** `maxTokens - reasoningReserve`: what a turn may actually emit. */
  readonly usableTokens: number;
  /** `usableTokens * DECOMPOSE_FRACTION`: above this, decompose. */
  readonly decomposeAbove: number;
  /** `usableTokens * WARN_FRACTION`: above this, warn. */
  readonly warnAbove: number;
}

/**
 * Compute the single-turn output budget for a model at a thinking level.
 *
 * Note what is *not* consulted: `contextWindow`. It is carried on
 * `ModelOutputLimits` purely so a caller can report both, and
 * `contextWindowIsNotTheConstraint` can state the relationship. Sizing on the
 * context window is the defect this module corrects.
 */
export function outputBudget(limits: ModelOutputLimits, thinking: ThinkingLevel = "off"): OutputBudget {
  const assumed = limits.maxTokens === null || limits.maxTokens <= 0;
  const maxTokens = assumed ? ASSUMED_MAX_OUTPUT_TOKENS : (limits.maxTokens as number);
  const reasoningReserve = Math.floor(maxTokens * THINKING_RESERVE[thinking]);
  const usableTokens = Math.max(1, maxTokens - reasoningReserve);
  return {
    maxTokens,
    assumed,
    thinking,
    reasoningReserve,
    usableTokens,
    decomposeAbove: Math.floor(usableTokens * DECOMPOSE_FRACTION),
    warnAbove: Math.floor(usableTokens * WARN_FRACTION),
  };
}

/**
 * `true` when the model's output ceiling binds before its context window —
 * i.e. a task sized only against `contextWindow` would be mis-sized. True for
 * every model in the current registry (16384 output vs ≥200k context), which
 * is exactly why PRD §3.3 exists.
 */
export function outputCeilingBindsFirst(limits: ModelOutputLimits): boolean {
  const budget = outputBudget(limits);
  const context = limits.contextWindow;
  if (context === null || context <= 0) return true;
  return budget.maxTokens < context;
}

/** What the planner must do about one artifact. */
export type SizingVerdict = "fits" | "tight" | "decompose" | "flag";

/** Per-artifact sizing result. */
export interface ArtifactSizing {
  readonly path: string;
  readonly estimatedOutputTokens: number;
  /** Estimated tokens as a fraction of `usableTokens`. */
  readonly fractionOfBudget: number;
  readonly verdict: SizingVerdict;
  /**
   * Minimum number of write/edit steps this artifact must be produced in for
   * each step to stay under `decomposeAbove`. 1 when it already fits.
   */
  readonly suggestedSteps: number;
  /** Human-readable reason, suitable for the plan document and `/korwf` output. */
  readonly reason: string;
}

/** Sizing result for a whole task. */
export interface TaskSizing {
  readonly budget: OutputBudget;
  readonly artifacts: readonly ArtifactSizing[];
  /** Worst verdict across artifacts (`flag` > `decompose` > `tight` > `fits`). */
  readonly verdict: SizingVerdict;
  /** `true` when at least one artifact must be decomposed or flagged. */
  readonly mustDecompose: boolean;
  /** Sum of all artifact estimates — informational; the per-turn ceiling is per artifact. */
  readonly totalEstimatedOutputTokens: number;
  /** Ordered, deterministic explanation lines for the plan document. */
  readonly notes: readonly string[];
}

const VERDICT_RANK: Readonly<Record<SizingVerdict, number>> = Object.freeze({
  fits: 0,
  tight: 1,
  decompose: 2,
  flag: 3,
});

function sizeArtifact(artifact: ExpectedArtifact, budget: OutputBudget): ArtifactSizing {
  const tokens = estimateTokens(artifact.estimate);
  const fraction = tokens / budget.usableTokens;
  const steps = Math.max(1, Math.ceil(tokens / Math.max(1, budget.decomposeAbove)));
  const pct = `${Math.round(fraction * 100)}%`;
  if (tokens > budget.decomposeAbove) {
    if (artifact.atomic === true) {
      return {
        path: artifact.path,
        estimatedOutputTokens: tokens,
        fractionOfBudget: fraction,
        verdict: "flag",
        suggestedSteps: steps,
        reason:
          `${artifact.path}: ~${tokens} output tokens is ${pct} of the usable single-turn budget ` +
          `(${budget.usableTokens}) and the artifact is declared atomic, so incremental writes cannot ` +
          `fix it. A turn that exceeds the ceiling is cut off before its tool call is emitted and ` +
          `writes nothing. Reduce the artifact or make it splittable before dispatching.`,
      };
    }
    return {
      path: artifact.path,
      estimatedOutputTokens: tokens,
      fractionOfBudget: fraction,
      verdict: "decompose",
      suggestedSteps: steps,
      reason:
        `${artifact.path}: ~${tokens} output tokens is ${pct} of the usable single-turn budget ` +
        `(${budget.usableTokens}); produce it in at least ${steps} steps (short write, then edits), ` +
        `committing after each.`,
    };
  }
  if (tokens > budget.warnAbove) {
    return {
      path: artifact.path,
      estimatedOutputTokens: tokens,
      fractionOfBudget: fraction,
      verdict: "tight",
      suggestedSteps: 1,
      reason:
        `${artifact.path}: ~${tokens} output tokens is ${pct} of the usable single-turn budget ` +
        `(${budget.usableTokens}); it fits but leaves little headroom for reasoning and narration.`,
    };
  }
  return {
    path: artifact.path,
    estimatedOutputTokens: tokens,
    fractionOfBudget: fraction,
    verdict: "fits",
    suggestedSteps: 1,
    reason: `${artifact.path}: ~${tokens} output tokens (${pct} of ${budget.usableTokens}) fits in one turn.`,
  };
}

/**
 * Size a task's expected artifacts against the selected model's output
 * ceiling (AC1). Deterministic: same inputs, same verdict, with or without
 * Jev.
 */
export function sizeTaskOutput(
  artifacts: readonly ExpectedArtifact[],
  limits: ModelOutputLimits,
  thinking: ThinkingLevel = "off",
): TaskSizing {
  const budget = outputBudget(limits, thinking);
  const sized = artifacts.map((a) => sizeArtifact(a, budget));
  let verdict: SizingVerdict = "fits";
  for (const s of sized) if (VERDICT_RANK[s.verdict] > VERDICT_RANK[verdict]) verdict = s.verdict;
  const notes: string[] = [];
  if (budget.assumed) {
    notes.push(
      `Model reported no maxTokens; assuming the conservative floor of ${ASSUMED_MAX_OUTPUT_TOKENS} ` +
        `output tokens. Unreported is not unlimited.`,
    );
  }
  if (budget.reasoningReserve > 0) {
    notes.push(
      `Thinking level '${budget.thinking}' reserves ${budget.reasoningReserve} of ${budget.maxTokens} ` +
        `output tokens for reasoning, leaving ${budget.usableTokens} usable.`,
    );
  }
  notes.push(
    `Decompose above ${budget.decomposeAbove} tokens per artifact ` +
      `(${DECOMPOSE_FRACTION} of usable); warn above ${budget.warnAbove}.`,
  );
  for (const s of sized) if (s.verdict !== "fits") notes.push(s.reason);
  return {
    budget,
    artifacts: sized,
    verdict,
    mustDecompose: verdict === "decompose" || verdict === "flag",
    totalEstimatedOutputTokens: sized.reduce((sum, s) => sum + s.estimatedOutputTokens, 0),
    notes,
  };
}

/** A task as the planner has it before dispatch: an id and its expected artifacts. */
export interface PlannedTaskOutput {
  readonly taskId: string;
  readonly expectedArtifacts: readonly ExpectedArtifact[];
}

/** One planned task's sizing, plus the concrete steps for each over-budget artifact. */
export interface PlannedTaskSizing {
  readonly taskId: string;
  readonly sizing: TaskSizing;
  /** Artifacts that must be produced incrementally, with their step plans. */
  readonly decompositions: readonly {
    readonly path: string;
    readonly steps: ReturnType<typeof planIncrementalSteps>;
  }[];
}

/**
 * Size a whole plan at planning time (AC1). Returns every task, so a caller
 * can both annotate the plan and refuse to dispatch the ones where
 * `sizing.mustDecompose` is true until they are split or explicitly flagged.
 */
export function sizePlan(
  tasks: readonly PlannedTaskOutput[],
  limits: ModelOutputLimits,
  thinking: ThinkingLevel = "off",
): readonly PlannedTaskSizing[] {
  return tasks.map((task) => {
    const sizing = sizeTaskOutput(task.expectedArtifacts, limits, thinking);
    const overBudget = new Set(
      sizing.artifacts.filter((a) => a.verdict === "decompose").map((a) => a.path),
    );
    return {
      taskId: task.taskId,
      sizing,
      decompositions: task.expectedArtifacts
        .filter((a) => overBudget.has(a.path))
        .map((a) => ({ path: a.path, steps: planIncrementalSteps(a, limits, thinking) })),
    };
  });
}

/**
 * Split one over-budget artifact into the smallest number of equal-sized
 * production steps that each stay under `decomposeAbove`. Used by the planner
 * to turn a `decompose` verdict into concrete subtasks; returns a single step
 * when the artifact already fits.
 */
export function planIncrementalSteps(
  artifact: ExpectedArtifact,
  limits: ModelOutputLimits,
  thinking: ThinkingLevel = "off",
): readonly { readonly step: number; readonly kind: "write" | "edit"; readonly estimatedOutputTokens: number }[] {
  const budget = outputBudget(limits, thinking);
  const tokens = estimateTokens(artifact.estimate);
  const steps = Math.max(1, Math.ceil(tokens / Math.max(1, budget.decomposeAbove)));
  const per = Math.ceil(tokens / steps);
  return Array.from({ length: steps }, (_unused, i) => ({
    step: i + 1,
    // The first step creates the file with a short `write`; every later step
    // extends it with an `edit`, so a truncated turn never loses the file.
    kind: i === 0 ? ("write" as const) : ("edit" as const),
    estimatedOutputTokens: Math.min(per, tokens - per * i),
  }));
}
