/**
 * Shared fixture for the Stage 4 exit-criterion suite (issue #55).
 *
 * The suite is **adversarial**: every test in this directory tries to get a
 * task to `done` without having earned it, and asserts that the attempt is
 * refused with a named reason. So the fixture deliberately provides no
 * shortcuts — there is no `forceDone`, no "assume checks passed", and no way
 * to hand the gate a revision that did not come from a real repository.
 *
 * What it does provide is the *honest* path, end to end:
 *
 *  - a real git repository in a temp directory (so `Evidence.revision` is a
 *    real `git rev-parse HEAD` read by `src/git/`, and "an older revision"
 *    means an actual earlier commit),
 *  - a real store (`src/storage/`) with a workflow → phase → task seeded from
 *    `test/scenarios/03-wrong-test.md`,
 *  - real check execution (`runCheck` from #45) against files in that repo,
 *  - the real gate (`completeTask` from #46) and the real C2 `Decision`
 *    builder (#47).
 *
 * Nothing here touches the author's machine: the repository, the store and
 * every path live under one temp directory that is removed in `cleanup()`.
 * No network, no Jev key, no model call.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openStore, type Store } from "../../../src/storage/db.ts";
import {
  RECORDS_SCHEMA_VERSION,
  type Attempt,
  type AttemptId,
  type CheckDefinition,
  type Decision,
  type Evidence,
  type EvidenceId,
  type GitSha,
  type IsoTimestamp,
  type PhaseId,
  type Provenance,
  type TaskId,
  type WorkflowId,
} from "../../../src/storage/records.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import type { EvidenceDraft } from "../../../src/verification/evidence.ts";
import type { JevGateConfig, PolicyReviewResult } from "../../../src/verification/task-gate.ts";

/** Fixed timestamps: the gate is pure, so the suite gives it a fixed clock. */
export const AT = "2026-01-01T00:00:00.000Z" as IsoTimestamp;

export const WF = "wf-1" as WorkflowId;
export const PH = "ph-1" as PhaseId;
export const TK = "tk-1" as TaskId;

/** Scenario 3's acceptance criterion, verbatim from the outline. */
export const AC1 = { id: "ac1", text: "empty items => 400 empty_order" } as const;

/** Paths the task owns (03-wrong-test.md § Fixture). */
export const OWNED_PATHS = ["src/routes/orders.js", "test/routes/orders.test.js"] as const;

/** `chk1` — the task's own test file. A real command, run for real. */
export const CHK1: CheckDefinition = {
  id: "chk1",
  kind: "command",
  command: "node test/routes/orders.test.js",
  cwd: ".",
  expectedExitCode: 0,
  coversCriteria: [AC1.id],
  required: true,
};

/** `chk2` — the scenario's "typecheck": loads the module and smoke-checks it. */
export const CHK2: CheckDefinition = {
  id: "chk2",
  kind: "command",
  command: 'node -e "const m=require(\'./src/routes/orders.js\'); if (typeof m.createOrder !== \'function\') process.exit(1)"',
  cwd: ".",
  expectedExitCode: 0,
  coversCriteria: [AC1.id],
  required: true,
};

export const JEV_ENABLED: JevGateConfig = {
  enabled: true,
  optional: false,
  confidenceThreshold: 0.8,
  questionVersion: "1",
};

export const JEV_DISABLED: JevGateConfig = { ...JEV_ENABLED, enabled: false };

/** Everything a Stage 4 test drives. */
export interface Stage4Fixture {
  readonly repo: TestRepo;
  readonly store: Store;
  /** Scratch directory outside the repository, for flaky-check state files. */
  readonly scratch: string;
  readonly cleanup: () => void;
  /** Current `git rev-parse HEAD` of the fixture repository. */
  head(): GitSha;
  /** Monotonic ids, so a test never has to invent one. */
  nextId(prefix: string): string;
}

export interface FixtureOptions {
  readonly checks?: readonly CheckDefinition[];
  readonly taskStatus?: "running" | "verifying" | "review" | "needs_changes" | "ready";
  readonly riskClass?: "low" | "medium" | "high";
}

/**
 * A repository, a store, and the scenario-3 workflow/phase/task.
 *
 * The repository starts at "patch #0": the route module exists but rejects
 * nothing, and the test file asserts only the happy path. That is deliberately
 * the *wrong* starting point, because every test here is about what happens
 * when something claims that state is finished.
 */
export function createFixture(options: FixtureOptions = {}): Stage4Fixture {
  const repo = makeTestRepo("korwf-stage4-");
  const scratch = join(repo.path, ".korwf-scratch");
  mkdirSync(scratch, { recursive: true });

  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  const { store } = openStore({ storageRoot: join(repo.path, ".korwf-store"), now: () => AT, newId: () => nextId("a") });

  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, policyVersion: "1", status: "running" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "running" }));
  store.tasks.insert(
    makeTask({
      id: TK,
      workflowId: WF,
      phaseId: PH,
      revision: 1,
      goal: "Reject POST /orders with an empty items array (400 empty_order)",
      status: options.taskStatus ?? "review",
      riskClass: options.riskClass ?? "low",
      blocker: null,
      ownership: { paths: [...OWNED_PATHS], components: ["orders"] },
      acceptanceCriteria: [{ ...AC1 }],
      checks: [...(options.checks ?? [CHK1, CHK2])],
    }),
  );

  return {
    repo,
    store,
    scratch,
    head: () => repo.head() as GitSha,
    nextId,
    cleanup: () => {
      store.close();
      repo.cleanup();
    },
  };
}

/** Write a file in the repository, creating parent directories. */
export function writeRepoFile(fixture: Stage4Fixture, relativePath: string, contents: string): void {
  const absolute = join(fixture.repo.path, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** Write files and commit them; returns the new HEAD. */
export function commitFiles(
  fixture: Stage4Fixture,
  files: Readonly<Record<string, string>>,
  message: string,
): GitSha {
  for (const [path, contents] of Object.entries(files)) writeRepoFile(fixture, path, contents);
  for (const path of Object.keys(files)) fixture.repo.git("add", path);
  fixture.repo.git("commit", "-q", "-m", message);
  return fixture.head();
}

/** Provenance entry for a path inside the repository at a revision. */
export function provenanceFor(path: string, revision: GitSha): Provenance {
  return {
    revision,
    path,
    range: null,
    retrievalMethod: "tool_output",
    contentHash: "d".repeat(64),
  };
}

/** Turn an `EvidenceDraft` from `runCheck` into a stored `Evidence` row. */
export function storeEvidence(
  fixture: Stage4Fixture,
  draft: EvidenceDraft,
  overrides: Partial<Evidence> = {},
): Evidence {
  const id = fixture.nextId("ev") as EvidenceId;
  return fixture.store.evidence.insert({
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "append_only",
    ...draft,
    ...overrides,
    // The id is the fixture's, not the draft's: a helper that silently
    // re-used an id would turn an append-only violation into a test bug.
    id: overrides.id ?? id,
  } as Evidence);
}

/** The implementer attempt whose completion request the gate is assessing. */
export function claimAttempt(fixture: Stage4Fixture, overrides: Partial<Attempt> = {}): Attempt {
  return fixture.store.attempts.insert(
    makeAttempt({
      id: fixture.nextId("at") as AttemptId,
      taskId: TK,
      taskRevision: fixture.store.tasks.require(TK).revision,
      role: "implementer",
      outcome: "succeeded",
      worktree: { relativePath: ".", branch: "main", baseRevision: fixture.head() },
      ...overrides,
    }),
  );
}

/** `policyNone()` — recorded, and requiring neither review nor approval. */
export function policyNone(fixture: Stage4Fixture, overrides: Partial<PolicyReviewResult> = {}): PolicyReviewResult {
  return {
    modelReview: false,
    humanApproval: false,
    changeClass: "code_change",
    policyVersion: "1",
    revision: fixture.head(),
    taskRevision: fixture.store.tasks.require(TK).revision,
    ...overrides,
  };
}

/** A policy result that demands the independent model review of variant B. */
export function policyRequiringReview(fixture: Stage4Fixture): PolicyReviewResult {
  return policyNone(fixture, { modelReview: true, changeClass: "test_change" });
}

/** Placate the linter about unused imports in a types-only position. */
export type { Decision };
