/**
 * Driving the real task gate from the Stage 4 fixture (issue #55).
 *
 * These helpers assemble exactly what `runTaskGate` assembles — from the
 * store, and with the revision read from the fixture repository — so a test
 * can compute the freshness hash a `Decision` must carry without any test-only
 * knowledge of how the gate works. Nothing here evaluates a condition itself:
 * every verdict in this suite comes from `src/verification/`.
 */
import {
  evaluateTaskGate,
  freshEvidence,
  gateStateHash,
  type JevGateConfig,
  type PolicyReviewResult,
  type TaskGateInput,
} from "../../../src/verification/task-gate.ts";
import { recordGateDecision, type EvidenceGapEvaluation, type GateFallbackReason } from "../../../src/verification/evaluate.ts";
import { runCheck, type CheckRunResult } from "../../../src/verification/checks.ts";
import type { CheckDefinition, Decision, Evidence, GitSha } from "../../../src/storage/records.ts";
import type { ReviewRecord } from "../../../src/verification/review.ts";
import {
  AT,
  JEV_ENABLED,
  TK,
  WF,
  provenanceFor,
  storeEvidence,
  type Stage4Fixture,
} from "./fixture.ts";

export interface GateContext {
  readonly policy: PolicyReviewResult;
  readonly jev?: JevGateConfig;
  readonly reviews?: readonly ReviewRecord[];
  /** Overrides the revision the gate evaluates at. Tests use it for staleness. */
  readonly revision?: GitSha | null;
}

/**
 * The input `runTaskGate` would build right now. Kept in one place so the
 * state hash a `Decision` carries is the hash the gate will recompute.
 */
export function gateInput(fixture: Stage4Fixture, ctx: GateContext): TaskGateInput {
  const task = fixture.store.tasks.require(TK);
  return {
    workflow: fixture.store.workflows.require(WF),
    task,
    revision: ctx.revision === undefined ? fixture.head() : ctx.revision,
    evidence: fixture.store.evidence.findBy("taskId", TK),
    decisions: fixture.store.decisions.findBy("workflowId", WF),
    approvals: fixture.store.approvals.findBy("workflowId", WF),
    attempts: fixture.store.attempts.forTask(TK),
    unresolvedBlockers: fixture.store.blockers.unresolvedForSubject("task", TK).map((b) => b.kind),
    policy: ctx.policy,
    ...(ctx.reviews === undefined ? {} : { reviews: ctx.reviews }),
    jev: ctx.jev ?? JEV_ENABLED,
    now: AT,
  };
}

/** The gate's own freshness hash for the current store state. */
export function currentStateHash(fixture: Stage4Fixture, ctx: GateContext): string {
  const input = gateInput(fixture, ctx);
  const revision = input.revision ?? fixture.head();
  const result = evaluateTaskGate(input);
  return gateStateHash({
    task: input.task,
    revision,
    checkStates: result.checkStates,
    fresh: freshEvidence(input, revision),
  });
}

/**
 * Run one registered check for real in the fixture repository and append the
 * resulting evidence row.
 *
 * The provenance is the check's own covered paths at the revision it ran at —
 * `runCheck` does not infer provenance, and `DET_COVERAGE` reads it, so the
 * caller states which files the check touched exactly as a real runner would
 * report them.
 */
export async function runAndStore(
  fixture: Stage4Fixture,
  check: CheckDefinition,
  options: { readonly paths?: readonly string[]; readonly overrides?: Partial<Evidence> } = {},
): Promise<{ readonly run: CheckRunResult; readonly evidence: Evidence | null }> {
  const task = fixture.store.tasks.require(TK);
  const attempts = fixture.store.attempts.forTask(TK);
  const run = await runCheck(check, {
    cwd: fixture.repo.path,
    subject: {
      workflowId: WF,
      taskId: TK,
      taskRevision: task.revision,
      attemptId: attempts[attempts.length - 1]?.id ?? null,
      requirementId: check.coversCriteria[0] ?? "ac1",
    },
    timeoutMs: 20_000,
    killGraceMs: 200,
  });
  if (run.evidence === null) return { run, evidence: null };
  const revision = run.revision ?? fixture.head();
  const paths = options.paths ?? ["test/routes/orders.test.js"];
  const evidence = storeEvidence(fixture, run.evidence, {
    provenance: paths.map((p) => provenanceFor(p, revision)),
    ...options.overrides,
  } as Partial<Evidence>);
  return { run, evidence };
}

/**
 * Append the condition-2 `Decision` for the current state, built by #47's
 * `recordGateDecision` rather than hand-rolled here.
 */
export function recordC2(
  fixture: Stage4Fixture,
  evaluation: EvidenceGapEvaluation,
  ctx: GateContext,
  options: { readonly fallbackReason?: GateFallbackReason; readonly stateHash?: string; readonly revision?: GitSha } = {},
): Decision {
  const input = gateInput(fixture, ctx);
  return recordGateDecision(fixture.store.decisions, evaluation, {
    workflowId: WF,
    taskId: TK,
    taskRevision: input.task.revision,
    revision: options.revision ?? input.revision ?? fixture.head(),
    stateHash: options.stateHash ?? currentStateHash(fixture, ctx),
    now: AT,
    newId: () => fixture.nextId("dc"),
    jevModelVersion: options.fallbackReason === undefined ? "jev-test" : null,
    ...(options.fallbackReason === undefined ? {} : { fallbackReason: options.fallbackReason }),
  });
}
