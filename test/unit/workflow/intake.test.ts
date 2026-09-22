/**
 * `src/workflow/intake.ts` (issue #33): `/korwf plan` flag parsing,
 * repository-identity resolution, and the deterministic clarification loop.
 */
import { describe, it, expect } from "vitest";
import {
  buildWorkflow,
  CURRENT_POLICY_VERSION,
  deterministicClarificationQuestions,
  GREENFIELD_ROOT_COMMIT,
  intakeSummary,
  parsePlanArgs,
  resolveRepo,
  runClarificationLoop,
} from "../../../src/workflow/intake.ts";
import type { RepoDetection } from "../../../src/git/status.ts";
import type { WorkflowId } from "../../../src/storage/records.ts";

describe("AC: parsePlanArgs — command parsing", () => {
  it("parses a plain goal with no flags", () => {
    const result = parsePlanArgs("Add a login page");
    expect(result.goal).toBe("Add a login page");
    expect(result.mode).toBeNull();
    expect(result.maxSpendUsd).toBeNull();
    expect(result.exclusions).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("parses --mode, --budget, and repeated --exclude, order-independent", () => {
    const result = parsePlanArgs(
      "--exclude vendor/** Build the app --mode supervised --budget 12.5 --exclude dist/**",
    );
    expect(result.goal).toBe("Build the app");
    expect(result.mode).toBe("supervised");
    expect(result.maxSpendUsd).toBe(12.5);
    expect(result.exclusions).toEqual(["vendor/**", "dist/**"]);
  });

  it("reports an error for an unknown mode rather than guessing", () => {
    const result = parsePlanArgs("Build it --mode turbo");
    expect(result.errors.some((e) => e.includes("unknown mode"))).toBe(true);
    expect(result.mode).toBeNull();
  });

  it("reports an error for a non-numeric budget", () => {
    const result = parsePlanArgs("Build it --budget lots");
    expect(result.errors.some((e) => e.includes("--budget"))).toBe(true);
    expect(result.maxSpendUsd).toBeNull();
  });

  it("rejects a negative budget", () => {
    const result = parsePlanArgs("Build it --budget -5");
    // "-5" parses as a flag-shaped token first; assert no silent negative cap.
    expect(result.maxSpendUsd === null || result.maxSpendUsd >= 0).toBe(true);
  });

  it("supports quoted goal text", () => {
    const result = parsePlanArgs('"Build the thing with spaces" --mode shadow');
    expect(result.goal).toBe("Build the thing with spaces");
  });
});

describe("AC: resolveRepo — existing-repo vs greenfield", () => {
  it("marks an existing repo with its real identity and base revision", () => {
    const detection: RepoDetection = {
      kind: "existing",
      gitRoot: "/repo",
      dirty: true,
      identity: { remoteUrl: "https://example.com/r.git", rootCommit: "a".repeat(40), name: "repo" },
    };
    const resolved = resolveRepo(detection, "fallback");
    expect(resolved.greenfield).toBe(false);
    expect(resolved.dirty).toBe(true);
    expect(resolved.baseRevision).toBe("a".repeat(40));
    expect(resolved.repoIdentity.remoteUrl).toBe("https://example.com/r.git");
  });

  it("flags greenfield with the zero-SHA placeholder and no remote", () => {
    const detection: RepoDetection = { kind: "greenfield" };
    const resolved = resolveRepo(detection, "my-new-project");
    expect(resolved.greenfield).toBe(true);
    expect(resolved.baseRevision).toBe(GREENFIELD_ROOT_COMMIT);
    expect(resolved.repoIdentity.remoteUrl).toBeNull();
    expect(resolved.repoIdentity.name).toBe("my-new-project");
  });
});

describe("AC3: exclusions from flags appear verbatim on the Workflow record", () => {
  it("carries --exclude globs through to buildWorkflow untouched", () => {
    const workflow = buildWorkflow({
      goal: "Build it",
      repo: resolveRepo({ kind: "greenfield" }, "proj"),
      mode: "supervised",
      budgets: { maxSpendUsd: null, maxTokens: null, maxRequests: null, maxConcurrency: null, maxElapsedMs: null },
      exclusions: ["vendor/**", "dist/**"],
      coordinatorSessionId: "sess-1",
      id: "wf-1" as WorkflowId,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(workflow.exclusions).toEqual(["vendor/**", "dist/**"]);
    expect(workflow.status).toBe("planning");
    expect(workflow.policyVersion).toBe(CURRENT_POLICY_VERSION);
  });
});

describe("AC1: existing-repo workflow carries the correct base revision", () => {
  it("buildWorkflow.baseRevision matches the detected root commit", () => {
    const sha = "b".repeat(40);
    const workflow = buildWorkflow({
      goal: "Add a feature",
      repo: resolveRepo(
        { kind: "existing", gitRoot: "/r", dirty: false, identity: { remoteUrl: null, rootCommit: sha, name: "r" } },
        "r",
      ),
      mode: "supervised",
      budgets: { maxSpendUsd: null, maxTokens: null, maxRequests: null, maxConcurrency: null, maxElapsedMs: null },
      exclusions: [],
      coordinatorSessionId: "sess-1",
      id: "wf-2" as WorkflowId,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(workflow.baseRevision).toBe(sha);
    expect(workflow.repoIdentity.rootCommit).toBe(sha);
  });
});

describe("AC2: greenfield detection flags the workflow", () => {
  it("intakeSummary names the Phase 0 bootstrap requirement for greenfield", () => {
    const repo = resolveRepo({ kind: "greenfield" }, "proj");
    const workflow = buildWorkflow({
      goal: "Build a CLI",
      repo,
      mode: "shadow",
      budgets: { maxSpendUsd: null, maxTokens: null, maxRequests: null, maxConcurrency: null, maxElapsedMs: null },
      exclusions: [],
      coordinatorSessionId: "sess-1",
      id: "wf-3" as WorkflowId,
      now: "2026-01-01T00:00:00.000Z",
    });
    const summary = intakeSummary({
      workflow,
      repo,
      clarification: { answers: [], skippedReason: "no_questions" },
      parseErrors: [],
    });
    expect(summary).toContain("greenfield");
    expect(summary).toContain("Phase 0 bootstrap");
  });
});

describe("Deterministic clarification rules run before any semantic classification", () => {
  it("asks nothing for a clear, well-specified existing-repo goal", () => {
    const questions = deterministicClarificationQuestions({
      goal: "Add a GET /orders/:id/summary endpoint returning item count and total",
      greenfield: false,
      exclusions: [],
    });
    expect(questions).toEqual([]);
  });

  it("asks for success criteria on a very short goal (short path stays available for trivial work)", () => {
    const questions = deterministicClarificationQuestions({ goal: "fix bug", greenfield: false, exclusions: [] });
    expect(questions.some((q) => q.id === "goal.underspecified")).toBe(true);
  });

  it("asks what kind of project on greenfield with no project-kind hint", () => {
    const questions = deterministicClarificationQuestions({
      goal: "Help me build something to manage my recipes and shopping",
      greenfield: true,
      exclusions: [],
    });
    expect(questions.some((q) => q.id === "greenfield.kind")).toBe(true);
  });

  it("does not ask the greenfield-kind question when the goal already names a kind", () => {
    const questions = deterministicClarificationQuestions({
      goal: "Build a CLI for managing recipes and shopping lists",
      greenfield: true,
      exclusions: [],
    });
    expect(questions.some((q) => q.id === "greenfield.kind")).toBe(false);
  });

  it("asks about exclusions when the goal implies broad scope and none were given", () => {
    const questions = deterministicClarificationQuestions({
      goal: "Rewrite everything to use the new framework",
      greenfield: false,
      exclusions: [],
    });
    expect(questions.some((q) => q.id === "scope.exclusions")).toBe(true);
  });

  it("caps the number of questions at MAX_CLARIFICATION_QUESTIONS", () => {
    const questions = deterministicClarificationQuestions({ goal: "fix", greenfield: true, exclusions: [] });
    expect(questions.length).toBeLessThanOrEqual(5);
  });
});

describe("AC4: non-interactive mode skips clarification without hanging", () => {
  it("returns immediately with skippedReason 'no_ui' when hasUI is false, never calling input", async () => {
    let called = false;
    const result = await runClarificationLoop(
      [{ id: "q1", prompt: "?" }],
      { input: () => { called = true; return "should never run"; }, hasUI: false },
    );
    expect(result.skippedReason).toBe("no_ui");
    expect(result.answers).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns skippedReason 'no_questions' when there is nothing to ask, even with a UI", async () => {
    const result = await runClarificationLoop([], { input: () => "x", hasUI: true });
    expect(result.skippedReason).toBe("no_questions");
  });

  it("asks each question and records skipped answers as null", async () => {
    const answers = ["yes", "", undefined];
    let i = 0;
    const result = await runClarificationLoop(
      [
        { id: "q1", prompt: "a" },
        { id: "q2", prompt: "b" },
        { id: "q3", prompt: "c" },
      ],
      { input: async () => answers[i++], hasUI: true },
    );
    expect(result.skippedReason).toBeNull();
    expect(result.answers).toEqual([
      { questionId: "q1", prompt: "a", answer: "yes" },
      { questionId: "q2", prompt: "b", answer: null },
      { questionId: "q3", prompt: "c", answer: null },
    ]);
  });
});
