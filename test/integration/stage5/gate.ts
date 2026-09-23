/**
 * Drives the real task gate for the Stage 5 fixture (issue #73), mirroring
 * `test/integration/stage4/gate.ts`'s pattern: real check execution, a real
 * mapping-only C2 evaluation, and `completeTask` — no shortcut to `done`.
 */
import { runCheck, type CheckRunResult } from "../../../src/verification/checks.ts";
import { evaluateMappingOnly, recordGateDecision, type EvidenceGapEvaluation } from "../../../src/verification/evaluate.ts";
import { completeTask, gateStateHash, evaluateTaskGate, freshEvidence, type PolicyReviewResult, type TaskGateInput } from "../../../src/verification/task-gate.ts";
import { RECORDS_SCHEMA_VERSION, type Attempt, type CheckDefinition, type Decision, type Evidence, type GitSha, type TaskId } from "../../../src/storage/records.ts";
import { PH, WF, checkFor, checkRelPath, type Stage5Fixture } from "./fixture.ts";

export function policyNone(fixture: Stage5Fixture, revision: GitSha, taskRevision: number): PolicyReviewResult {
  return {
    modelReview: false,
    humanApproval: false,
    changeClass: "code_change",
    policyVersion: "1",
    revision,
    taskRevision,
  };
}

function provenanceFor(path: string, revision: GitSha) {
  return { revision, path, range: null, retrievalMethod: "tool_output" as const, contentHash: "d".repeat(64) };
}

/** Run one task's own check for real and append the resulting evidence row. */
export async function runAndStoreCheck(
  fixture: Stage5Fixture,
  taskId: TaskId,
  attempt: Attempt,
): Promise<{ readonly run: CheckRunResult; readonly evidence: Evidence | null }> {
  const check: CheckDefinition = checkFor(taskId);
  const run = await runCheck(check, {
    cwd: fixture.repo.path,
    subject: {
      workflowId: WF,
      taskId,
      taskRevision: fixture.store.tasks.require(taskId).revision,
      attemptId: attempt.id,
      requirementId: check.coversCriteria[0] ?? "ac1",
    },
    timeoutMs: 20_000,
    killGraceMs: 200,
  });
  if (run.evidence === null) return { run, evidence: null };
  const revision = run.revision ?? (fixture.head() as GitSha);
  const evidence = fixture.store.evidence.insert({
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
    schemaVersion: RECORDS_SCHEMA_VERSION,
    kind: "append_only",
    id: fixture.nextId("ev") as never,
    ...run.evidence,
    provenance: [provenanceFor(checkRelPath(taskId), revision)],
  } as Evidence);
  return { run, evidence };
}

function gateInput(fixture: Stage5Fixture, taskId: TaskId, policy: PolicyReviewResult, revision: GitSha): TaskGateInput {
  const task = fixture.store.tasks.require(taskId);
  return {
    workflow: fixture.store.workflows.require(WF),
    task,
    revision,
    evidence: fixture.store.evidence.findBy("taskId", taskId),
    decisions: fixture.store.decisions.findBy("workflowId", WF),
    approvals: fixture.store.approvals.findBy("workflowId", WF),
    attempts: fixture.store.attempts.forTask(taskId),
    unresolvedBlockers: fixture.store.blockers.unresolvedForSubject("task", taskId).map((b) => b.kind),
    policy,
    jev: { enabled: true, optional: false, confidenceThreshold: 0.8, questionVersion: "1" },
    now: fixture.now(),
  };
}

function stateHashFor(fixture: Stage5Fixture, taskId: TaskId, policy: PolicyReviewResult, revision: GitSha): string {
  const input = gateInput(fixture, taskId, policy, revision);
  const result = evaluateTaskGate(input);
  return gateStateHash({ task: input.task, revision, checkStates: result.checkStates, fresh: freshEvidence(input, revision) });
}

/** Record the C2 (evidence-gap) `Decision`, mapping-only (Jev disabled path — deterministic, no key). */
export async function recordC2(
  fixture: Stage5Fixture,
  taskId: TaskId,
  criterionId: string,
  goal: string,
  policy: PolicyReviewResult,
  revision: GitSha,
): Promise<Decision> {
  const evaluation: EvidenceGapEvaluation = {
    ...(await evaluateMappingOnly({
      taskId: taskId as string,
      taskGoal: goal,
      riskClass: "low",
      acceptanceCriteria: [{ id: criterionId, text: goal }],
      checks: [{ checkId: checkFor(taskId).id, command: checkFor(taskId).command, state: "pass", coversCriteria: [criterionId] }],
      tests: [],
      evidence: [
        {
          requirementId: criterionId,
          checkId: checkFor(taskId).id,
          command: checkFor(taskId).command,
          state: "pass",
          paths: [checkRelPath(taskId)],
          excerpt: "1 passing",
        },
      ],
      claim: "implemented and tested",
    })),
    confidence: 0.95,
  };
  return recordGateDecision(fixture.store.decisions, evaluation, {
    workflowId: WF,
    taskId,
    taskRevision: fixture.store.tasks.require(taskId).revision,
    revision,
    stateHash: stateHashFor(fixture, taskId, policy, revision),
    now: fixture.now(),
    newId: () => fixture.nextId("dc"),
    jevModelVersion: "jev-test",
  });
}

/** Move the task through `review` and run the real gate to `done`. */
export async function completeTaskThroughGate(
  fixture: Stage5Fixture,
  taskId: TaskId,
) {
  const revision = fixture.head() as GitSha;
  const task = fixture.store.tasks.require(taskId);
  const policy = policyNone(fixture, revision, task.revision);
  fixture.store.tasks.update(taskId, { status: "review" });
  return completeTask(fixture.store, taskId, {
    policy,
    jev: { enabled: true, optional: false, confidenceThreshold: 0.8, questionVersion: "1" },
    now: fixture.now(),
    newId: () => fixture.nextId("rc"),
    worktreePath: fixture.repo.path,
    actor: { kind: "engine", identity: "engine" },
    evidenceRefs: ["ev:checks", "ev:gap", "ev:policy"],
  });
}

export { PH };
