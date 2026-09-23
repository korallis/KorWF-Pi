/**
 * Shared fixture for the Stage 5 exit-criterion suite (issue #73).
 *
 * Builds the scenario-4 fixture (`test/scenarios/04-cap-mid-task.md`): a real
 * git repository, a real SQLite store, a two-task phase (`T1`, `T2`), and
 * three fixture models (`M-primary`, `M-sub`, `M-weak`). Nothing here is
 * mocked that can be real: git is real (`test/helpers/git-repo.ts`), the
 * store is real (`src/storage/db.ts`), cap detection runs the real
 * `src/models/cap-detect.ts` over a synthetic 429, and fallback/selection run
 * the real `src/models/fallback.ts` / `src/models/select.ts`. Only the Jev
 * transport (`MockJevTransport`) and the provider call itself are faked —
 * there is no key and no network in this suite.
 */
import { join } from "node:path";
import { openStore, type Store } from "../../../src/storage/db.ts";
import {
  RECORDS_SCHEMA_VERSION,
  type Attempt,
  type AttemptId,
  type CheckDefinition,
  type IsoTimestamp,
  type PhaseId,
  type TaskId,
  type TaskProfile,
  type WorkflowId,
} from "../../../src/storage/records.ts";
import { makeAttempt, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";
import { FakeClock } from "../../helpers/fake-clock.ts";
import { mergeCards } from "../../../src/models/cards.ts";
import { deriveRouteId } from "../../../src/models/route.ts";
import type { CatalogEntry } from "../../../src/models/catalog.ts";
import type { SelectionCandidate } from "../../../src/models/select.ts";
import type { ModelAllowlist, ModelRef } from "../../../src/config/types.ts";

export const WF = "wf-1" as WorkflowId;
export const PH = "ph-1" as PhaseId;
export const T1 = "t1" as TaskId;
export const T2 = "t2" as TaskId;

export const PROFILE: TaskProfile = {
  domain: "backend",
  modalities: ["text"],
  reasoningDepth: 0.5,
  contextSize: 0.4,
  risk: "low",
};

export const PROVIDER = "fixture-provider";

/** Build the fixture's `CatalogEntry` + `SelectionCandidate` for one model id. */
export function candidateFor(modelId: string): SelectionCandidate {
  const entry: CatalogEntry = {
    id: `${PROVIDER}/${modelId}` as CatalogEntry["id"],
    provider: PROVIDER,
    name: modelId,
    routeId: deriveRouteId(PROVIDER, modelId),
    reasoning: true,
    thinkingLevelMap: "unknown",
    input: ["text"],
    contextWindow: "unknown",
    maxTokens: "unknown",
    cost: "unknown",
  };
  return { ref: entry.id, routeId: entry.routeId, card: mergeCards(entry, {}), entry };
}

export const M_PRIMARY = candidateFor("M-primary");
export const M_SUB = candidateFor("M-sub");
export const M_WEAK = candidateFor("M-weak");

export const ALLOW_ALL: ModelAllowlist = { providers: [], models: [], pins: {} };
export const STATIC_ORDER: readonly ModelRef[] = [M_PRIMARY.ref, M_SUB.ref, M_WEAK.ref];

export interface Stage5Fixture {
  readonly repo: TestRepo;
  readonly store: Store;
  readonly clock: FakeClock;
  readonly cleanup: () => void;
  head(): string;
  nextId(prefix: string): string;
  now(): IsoTimestamp;
}

export function createStage5Fixture(startMs = Date.parse("2026-01-01T00:00:00.000Z")): Stage5Fixture {
  const repo = makeTestRepo("korwf-stage5-");
  const clock = new FakeClock(startMs);
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  const now = (): IsoTimestamp => new Date(clock.now()).toISOString() as IsoTimestamp;

  const { store } = openStore({ storageRoot: join(repo.path, ".korwf-store"), now, newId: () => nextId("id") });

  store.workflows.insert(
    makeWorkflow({
      id: WF,
      baseRevision: repo.head(),
      planRevision: 1,
      status: "running",
      budgets: { maxSpendUsd: 3, maxTokens: null, maxRequests: null, maxConcurrency: 1, maxElapsedMs: null },
    }),
  );
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "running" }));

  const check: CheckDefinition = {
    id: "chk1",
    kind: "command",
    command: "true",
    cwd: ".",
    expectedExitCode: 0,
    coversCriteria: ["ac-1"],
    required: true,
  };

  store.tasks.insert(
    makeTask({
      id: T1,
      workflowId: WF,
      phaseId: PH,
      revision: 1,
      goal: "Add GET /orders/:id/summary",
      status: "ready",
      dependencies: [],
      checks: [check],
      riskClass: "low",
    }),
  );
  store.tasks.insert(
    makeTask({
      id: T2,
      workflowId: WF,
      phaseId: PH,
      revision: 1,
      goal: "Add GET /users/:id/orders",
      status: "proposed",
      dependencies: [T1],
      checks: [check],
      riskClass: "low",
    }),
  );

  return {
    repo,
    store,
    clock,
    now,
    nextId,
    head: () => repo.head(),
    cleanup: () => {
      store.close();
      repo.cleanup();
    },
  };
}

/** Insert a starting Attempt row for `T1` on the primary model. */
export function insertPrimaryAttempt(fixture: Stage5Fixture, overrides: Partial<Attempt> = {}): Attempt {
  return fixture.store.attempts.insert(
    makeAttempt({
      id: fixture.nextId("at") as AttemptId,
      taskId: T1,
      taskRevision: 1,
      requestedModel: M_PRIMARY.ref,
      usedModel: M_PRIMARY.ref,
      fallbackReason: null,
      taskProfile: PROFILE,
      timestamps: { startedAt: fixture.now(), endedAt: null, lastActivityAt: fixture.now() },
      worktree: { relativePath: `.korwf/worktrees/${fixture.nextId("wt")}`, branch: "korwf/attempt/t1", baseRevision: fixture.head() },
      ...overrides,
    }),
  );
}
