/**
 * Task evaluation questions (issue #39; PLAN §3.C "Jev evaluates atomic
 * properties: observable outcome, requirement coverage, ambiguity,
 * verification readiness, coupling").
 *
 * Three versioned questions, one bounded property each — the decomposition
 * lesson from `.pi/skills/jev-orchestration/SKILL.md` §2: a single
 * existential "is this task good?" deflates with plan size for reasons that
 * have nothing to do with quality. `src/workflow/evaluate-plan.ts` takes the
 * conjunction in code.
 *
 *  - `task.atomic@1` (choice) — does this task have one observable outcome,
 *    or is it actually several tasks (`composite`), or unclear.
 *  - `task.coverage@1` (noul) — does this task's goal+criteria cover the
 *    stated intake requirement.
 *  - `task.ambiguity@1` (score) — how ambiguous is the task as written.
 *
 * Every fallback is purely structural — no semantic guess when Jev is
 * disabled. "Disabled Jev shows `not_evaluated`" (issue #39 acceptance
 * criterion) is implemented by `evaluate-plan.ts`, which treats a fallback
 * result as `not_evaluated` for display, never as a silently-passed verdict.
 */
import { defineChoice, defineNoul, defineScore, type QuestionDefinition } from "../question.ts";
import { QuestionRegistry } from "../registry.ts";
import type { JevState } from "../../jev/transport.ts";

// ---------------------------------------------------------------------------
// task.atomic@1
// ---------------------------------------------------------------------------

export interface TaskAtomicState {
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
}

function atomicState(input: TaskAtomicState): JevState {
  return { goal: input.goal, acceptanceCriteria: input.acceptanceCriteria };
}

export type AtomicVerdict = "atomic" | "composite" | "unclear";

/**
 * Deterministic fallback (no key / disabled / abstained): structural check
 * only, never a semantic guess. More than three acceptance criteria is a
 * cheap, explainable signal that a task is bundling several outcomes; one
 * criterion or the exact three-way tie is `unclear` rather than a coin
 * toss (PLAN §6 "explicit none/unknown outcomes").
 */
export function atomicFallbackVerdict(criteriaCount: number): AtomicVerdict {
  if (criteriaCount <= 1) return "atomic";
  if (criteriaCount > 3) return "composite";
  return "unclear";
}

export const taskAtomicQuestion: QuestionDefinition<TaskAtomicState, AtomicVerdict> = defineChoice<
  TaskAtomicState,
  AtomicVerdict
>({
  id: "task.atomic",
  version: "1",
  prompt:
    "Given a task's `goal` and its `acceptanceCriteria`, does completing it produce exactly one observable " +
    "outcome (one thing a reviewer could point at and say \"that is what changed\"), or does it actually bundle " +
    "several independent outcomes that should be separate tasks? Answer `composite` only when the task could be " +
    "split into two or more tasks that could be verified and completed independently.",
  options: {
    atomic: "One observable outcome; the acceptance criteria all describe facets of the same change",
    composite: "Two or more independently verifiable outcomes bundled into one task",
    unclear: "Not enough information in the goal/criteria to tell",
  },
  minConfidence: 0.55,
  state: atomicState,
  decide: (answer) => {
    const value: AtomicVerdict =
      answer.choice === "atomic" || answer.choice === "composite" ? answer.choice : "unclear";
    return { value, rule: `atomic:${value}`, action: value };
  },
  fallback: (input) => {
    const value = atomicFallbackVerdict(input.acceptanceCriteria.length);
    return { value, rule: "criteria_count", action: value };
  },
  replay: (action) => (action === "atomic" || action === "composite" || action === "unclear" ? action : null),
  boundaries: [
    { name: "single criterion is atomic", state: emptyAtomicState({ acceptanceCriteria: ["one"] }), expectFallback: "atomic" },
    {
      name: "two or three criteria is unclear",
      state: emptyAtomicState({ acceptanceCriteria: ["a", "b", "c"] }),
      expectFallback: "unclear",
    },
    {
      name: "more than three criteria is composite",
      state: emptyAtomicState({ acceptanceCriteria: ["a", "b", "c", "d"] }),
      expectFallback: "composite",
    },
  ],
});

function emptyAtomicState(overrides: Partial<TaskAtomicState>): TaskAtomicState {
  return { goal: "g", acceptanceCriteria: [], ...overrides };
}

// ---------------------------------------------------------------------------
// task.coverage@1
// ---------------------------------------------------------------------------

/** One (task, intake requirement) pair. Asked per pair, never as one bulk question. */
export interface TaskCoverageState {
  readonly requirement: string;
  readonly taskGoal: string;
  readonly taskCriteria: readonly string[];
}

function coverageState(input: TaskCoverageState): JevState {
  return { requirement: input.requirement, taskGoal: input.taskGoal, taskCriteria: input.taskCriteria };
}

const COVERAGE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by",
  "with", "is", "are", "be", "this", "that", "it", "its", "as", "from",
]);

function coverageTokens(text: string): ReadonlySet<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !COVERAGE_STOPWORDS.has(w)));
}

/**
 * Deterministic fallback: keyword overlap between the requirement and the
 * task's goal+criteria. Purely structural — the same kind of signal
 * `context.relevance@1` and `capability.relevance@1` fall back to. `true`
 * requires at least two shared tokens, so a single incidental word cannot
 * mark a requirement covered.
 */
export function coverageFallbackVerdict(requirement: string, taskGoal: string, taskCriteria: readonly string[]): boolean {
  const req = coverageTokens(requirement);
  if (req.size === 0) return false;
  const task = coverageTokens([taskGoal, ...taskCriteria].join(" "));
  let shared = 0;
  for (const word of req) if (task.has(word)) shared += 1;
  return shared >= 2;
}

export const taskCoverageQuestion: QuestionDefinition<TaskCoverageState, boolean> = defineNoul<TaskCoverageState, boolean>({
  id: "task.coverage",
  version: "1",
  prompt:
    "Given one intake `requirement` and one task's `taskGoal`/`taskCriteria`, does completing this task, as " +
    "written, address this requirement? Answer `false` if the task is unrelated or only tangentially touches it.",
  criteria: {
    true: "The task's goal or at least one acceptance criterion directly addresses the requirement",
    false: "The task does not address the requirement, or addresses it only in passing",
  },
  abstainBand: [0.4, 0.6],
  state: coverageState,
  decide: (noul) => ({
    value: noul >= 0.5,
    rule: noul >= 0.5 ? "coverage:covered" : "coverage:not_covered",
    action: noul >= 0.5 ? "covered" : "not_covered",
  }),
  fallback: (input) => {
    const value = coverageFallbackVerdict(input.requirement, input.taskGoal, input.taskCriteria);
    return { value, rule: "keyword_overlap", action: value ? "covered" : "not_covered" };
  },
  replay: (action) => (action === "covered" ? true : action === "not_covered" ? false : null),
  boundaries: [
    {
      name: "no shared keywords",
      state: { requirement: "support dark mode theming", taskGoal: "fix the login button", taskCriteria: [] },
      expectFallback: false,
    },
    {
      name: "strong overlap",
      state: {
        requirement: "support dark mode theming across the app",
        taskGoal: "add dark mode theming support to the settings screen",
        taskCriteria: [],
      },
      expectFallback: true,
    },
  ],
});

// ---------------------------------------------------------------------------
// task.ambiguity@1
// ---------------------------------------------------------------------------

export interface TaskAmbiguityState {
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
}

function ambiguityState(input: TaskAmbiguityState): JevState {
  return { goal: input.goal, acceptanceCriteria: input.acceptanceCriteria };
}

export const AMBIGUITY_LEVELS = [
  "Clear — a competent worker would not need to ask a clarifying question",
  "Somewhat ambiguous — one detail is left to interpretation",
  "Highly ambiguous — the goal or criteria could reasonably be read several ways",
] as const;

/** Vague-language markers that are cheap, explainable signals of ambiguity. */
const VAGUE_MARKERS = [
  "etc", "appropriate", "as needed", "somehow", "maybe", "possibly", "various",
  "improve", "better", "nice", "clean up", "some kind of", "if needed",
];

/**
 * Deterministic fallback: no acceptance criteria at all is maximally
 * ambiguous (there is nothing to check completion against); otherwise count
 * vague-language markers in the goal text. Purely structural, no semantic
 * judgment.
 */
export function ambiguityFallbackScore(goal: string, criteriaCount: number): 0 | 1 | 2 {
  if (criteriaCount === 0) return 2;
  const lower = goal.toLowerCase();
  const hits = VAGUE_MARKERS.filter((marker) => lower.includes(marker)).length;
  if (hits === 0) return 0;
  if (hits === 1) return 1;
  return 2;
}

export const taskAmbiguityQuestion: QuestionDefinition<TaskAmbiguityState, number> = defineScore<
  TaskAmbiguityState,
  number
>({
  id: "task.ambiguity",
  version: "1",
  prompt:
    "Given a task's `goal` and `acceptanceCriteria`, how ambiguous is it? Consider whether a competent worker " +
    "could start work without needing to ask a clarifying question, and whether the acceptance criteria pin down " +
    "what \"done\" means.",
  levels: [...AMBIGUITY_LEVELS],
  minConfidence: 0.5,
  state: ambiguityState,
  decide: (answer) => ({
    value: Math.round(answer.score),
    rule: `ambiguity:${Math.round(answer.score)}`,
    action: String(Math.round(answer.score)),
  }),
  fallback: (input) => {
    const value = ambiguityFallbackScore(input.goal, input.acceptanceCriteria.length);
    return { value, rule: "vague_language", action: String(value) };
  },
  replay: (action) => (/^[0-2]$/.test(action) ? Number(action) : null),
  boundaries: [
    { name: "no criteria is maximally ambiguous", state: { goal: "improve the thing", acceptanceCriteria: [] }, expectFallback: 2 },
    { name: "clear goal, no vague markers", state: { goal: "add a logout button to the header", acceptanceCriteria: ["c1"] }, expectFallback: 0 },
    { name: "one vague marker", state: { goal: "make the header nice", acceptanceCriteria: ["c1"] }, expectFallback: 1 },
  ],
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Hashes as reviewed; editing prompt/options/levels without a version bump fails registration. */
export const TASK_QUESTION_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "task.atomic@1": taskAtomicQuestion.contentHash,
  "task.coverage@1": taskCoverageQuestion.contentHash,
  "task.ambiguity@1": taskAmbiguityQuestion.contentHash,
});

export const taskQuestionRegistry = new QuestionRegistry();
for (const question of [taskAtomicQuestion, taskCoverageQuestion, taskAmbiguityQuestion] as const) {
  taskQuestionRegistry.register(question as QuestionDefinition<unknown, unknown>, {
    pinnedHash: question.contentHash,
  });
}
