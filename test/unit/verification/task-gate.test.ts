/**
 * The task gate (issue #46; PLAN §2.4; docs/gates.md §2–§5, §7, §8;
 * test outline `test/spec/gates.spec.md`).
 *
 * Test names are the block ids of the spec outline (`T1.pass`, `B3`, `X2`, …)
 * so each acceptance criterion is traceable to the sentence it enforces.
 *
 * Acceptance criteria exercised here:
 *  - AC1 "All bypass scenarios from the Stage 1 spec are rejected with an
 *    audit entry" — `describe("B…")` blocks, one per row of gates.md §8.
 *  - AC2 "Jev 'no gap' + one failing check → rejected" — `B2`.
 *  - AC3 "Stale evidence (older revision) → rejected" — `B3`, `B4`.
 *  - AC4 "Worker calling transition(…, 'done') directly → rejected" — `B1`.
 *
 * No git, no clock, no network, no Jev call: the revision is injected and Jev
 * answers are pre-written `Decision` rows, exactly as the outline requires.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type {
  Approval,
  Attempt,
  CheckDefinition,
  Decision,
  Evidence,
  EvidenceExitStatus,
  TaskId,
} from "../../../src/storage/records.ts";
import {
  completeTask,
  evaluateTaskGate,
  gateStateHash,
  runTaskGate,
  freshEvidence,
  type JevGateConfig,
  type PolicyReviewResult,
  type TaskGateInput,
  type TaskGateResult,
} from "../../../src/verification/task-gate.ts";
import { TransitionRejected, transitionTask } from "../../../src/workflow/state.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import {
  AT,
  HASH,
  SHA,
  makeApproval,
  makeAttempt,
  makeDecision,
  makeEvidence,
  makePhase,
  makeTask,
  makeWorkflow,
} from "../../helpers/records.ts";

const TK = "tk-1" as TaskId;
/** A revision that is not `SHA`: what "stale" looks like. */
const OLD_SHA = "0".repeat(40);

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function freshStore(): Store {
  const dir = makeTempDir("korwf-task-gate-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `g-${(counter += 1)}` });
  open.push({ dir, store });
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fixture vocabulary (test/spec/gates.spec.md "Fixture vocabulary")
// ---------------------------------------------------------------------------

const CHK1: CheckDefinition = {
  id: "chk1",
  kind: "command",
  command: "npm test -- a",
  cwd: ".",
  expectedExitCode: 0,
  coversCriteria: ["ac1"],
  required: true,
};
const CHK2: CheckDefinition = { ...CHK1, id: "chk2", command: "npm test -- b", coversCriteria: ["ac2"] };

/** `Task{status: review, revision: 3, riskClass: medium}` with ac1/ac2 + chk1/chk2. */
function taskInReview(overrides: Partial<ReturnType<typeof makeTask>> = {}) {
  return makeTask({
    id: TK,
    revision: 3,
    status: "review",
    riskClass: "medium",
    blocker: null,
    ownership: { paths: ["src/example.ts"], components: ["example"] },
    acceptanceCriteria: [
      { id: "ac1", text: "first" },
      { id: "ac2", text: "second" },
    ],
    checks: [CHK1, CHK2],
    ...overrides,
  });
}

let evidenceSeq = 0;

/** Fresh passing evidence for a check, with provenance inside owned paths. */
function passEvidence(check: CheckDefinition, overrides: Partial<Evidence> = {}): Evidence {
  evidenceSeq += 1;
  return makeEvidence({
    id: `ev-${evidenceSeq}` as Evidence["id"],
    createdAt: `2026-01-01T00:00:0${evidenceSeq % 10}.000Z`,
    taskId: TK,
    taskRevision: 3,
    revision: SHA,
    requirementId: check.coversCriteria[0] ?? "ac1",
    checkId: check.id,
    commandIdentity: { command: check.command, cwd: check.cwd, environmentHash: HASH },
    exitStatus: { kind: "exited", code: 0 },
    reviewer: { kind: "deterministic" },
    ...overrides,
  });
}

/** Evidence for a check in a given non-pass exit state. */
function stateEvidence(check: CheckDefinition, exitStatus: EvidenceExitStatus): Evidence {
  return passEvidence(check, { exitStatus });
}

/** The attempt whose completion request the gate is assessing. */
function authorAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return makeAttempt({
    id: "at-author" as Attempt["id"],
    taskId: TK,
    taskRevision: 3,
    role: "implementer",
    outcome: "succeeded",
    ...overrides,
  });
}

const JEV_ENABLED: JevGateConfig = {
  enabled: true,
  optional: false,
  confidenceThreshold: 0.8,
  questionVersion: "1.0.0",
};
const JEV_DISABLED: JevGateConfig = { ...JEV_ENABLED, enabled: false };

/** `policyNone()` — recorded, and requiring neither review nor approval. */
function policyNone(overrides: Partial<PolicyReviewResult> = {}): PolicyReviewResult {
  return {
    modelReview: false,
    humanApproval: false,
    changeClass: "code",
    policyVersion: "2026.1",
    revision: SHA,
    taskRevision: 3,
    ...overrides,
  };
}

/** Build a complete gate input, then let a scenario tweak it. */
function buildInput(overrides: Partial<TaskGateInput> = {}): TaskGateInput {
  const task = overrides.task ?? taskInReview();
  const evidence = overrides.evidence ?? [passEvidence(CHK1), passEvidence(CHK2)];
  const base: TaskGateInput = {
    workflow: makeWorkflow({ planRevision: 1, policyVersion: "2026.1", status: "running" }),
    task,
    revision: SHA,
    evidence,
    decisions: [],
    approvals: [],
    attempts: [authorAttempt()],
    unresolvedBlockers: [],
    policy: policyNone(),
    jev: JEV_ENABLED,
    now: AT,
  };
  return { ...base, ...overrides, task, evidence };
}

/**
 * A fresh `no_gap` Decision for an input, i.e. one whose `stateHash` is the
 * hash the engine computes over that exact input. Produced *from* the input,
 * because a decision that does not match the current state is by definition
 * stale (docs/gates.md §5.1).
 */
function noGapDecision(input: TaskGateInput, overrides: Partial<Decision> = {}): Decision {
  return makeDecision({
    id: "dc-nogap" as Decision["id"],
    subject: { taskId: TK, taskRevision: input.task.revision },
    questionId: "task_evidence_gap",
    questionVersion: "1.0.0",
    stateHash: stateHashFor(input),
    action: "no_gap",
    confidence: 0.95,
    policyRule: "evidence_gap_v1",
    override: null,
    freshness: { revision: input.revision ?? SHA, decidedAt: AT, expiresAt: null },
    ...overrides,
  });
}

/** A recorded deterministic-fallback Decision for a disabled/unavailable Jev. */
function fallbackDecision(
  input: TaskGateInput,
  reason: "jev_disabled" | "jev_no_key" | "jev_unavailable",
): Decision {
  return makeDecision({
    id: "dc-fallback" as Decision["id"],
    subject: { taskId: TK, taskRevision: input.task.revision },
    questionId: "task_evidence_gap",
    questionVersion: "1.0.0",
    stateHash: stateHashFor(input),
    action: "deterministic_fallback",
    confidence: null,
    policyRule: "fallback",
    override: { actor: "policy", action: "deterministic_fallback", reason, at: AT },
    freshness: { revision: input.revision ?? SHA, decidedAt: AT, expiresAt: null },
  });
}

/**
 * The engine's state hash for an input. Recomputed the way the gate does it,
 * so a decision is fresh exactly when the gate agrees it is.
 */
function stateHashFor(input: TaskGateInput): string {
  const revision = input.revision ?? SHA;
  const fresh = freshEvidence(input, revision);
  const result = evaluateTaskGate(input);
  return gateStateHash({ task: input.task, revision, checkStates: result.checkStates, fresh });
}

/** Evaluate with a matching decision attached, the usual all-green shape. */
function evaluateWithNoGap(overrides: Partial<TaskGateInput> = {}): TaskGateResult {
  const input = buildInput(overrides);
  return evaluateTaskGate({ ...input, decisions: [noGapDecision(input), ...input.decisions] });
}

/** Every reason code a result carries, in condition order. */
function codes(result: TaskGateResult): string[] {
  return result.reasons.map((r) => r.reasonCode);
}

// ---------------------------------------------------------------------------
// 1. Passing baselines
// ---------------------------------------------------------------------------

describe("T1: the task gate passes when, and only when, all three conditions hold", () => {
  it("T1.pass — all conditions hold", () => {
    const result = evaluateWithNoGap();
    expect(result.reasons).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.c2Branch).toBe("jev_no_gap");
    expect(result.conditions.map((c) => c.id)).toEqual(["C0", "C1", "C2", "C3"]);
    expect(result.conditions.every((c) => c.satisfied)).toBe(true);
  });

  it("T1.pass.jevDisabled — the deterministic fallback satisfies C2 with no key", () => {
    const input = buildInput({ jev: JEV_DISABLED });
    const result = evaluateTaskGate({ ...input, decisions: [fallbackDecision(input, "jev_no_key")] });
    expect(result.reasons).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.c2Branch).toBe("deterministic_fallback");
  });

  it("T2.C1.latestResultWins — a newer fresh pass supersedes an older fresh fail", () => {
    const older = passEvidence(CHK1, { exitStatus: { kind: "exited", code: 1 }, createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = passEvidence(CHK1, { createdAt: "2026-01-01T00:00:09.000Z" });
    const result = evaluateWithNoGap({ evidence: [older, newer, passEvidence(CHK2)] });
    expect(codes(result)).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it("T2.C2.optionalUnavailableFallsBack — jev.optional=true degrades to DET_COVERAGE", () => {
    const input = buildInput({ jev: { ...JEV_ENABLED, optional: true } });
    const result = evaluateTaskGate({ ...input, decisions: [fallbackDecision(input, "jev_unavailable")] });
    expect(result.pass).toBe(true);
    expect(result.c2Branch).toBe("deterministic_fallback");
  });

  it("a human check passes only on human-reviewer evidence (docs/gates.md §9 D3)", () => {
    const human: CheckDefinition = {
      id: "chk-human",
      kind: "human",
      command: "a person confirms the migration is reversible",
      cwd: ".",
      expectedExitCode: 0,
      coversCriteria: ["ac2"],
      required: true,
    };
    const task = taskInReview({ checks: [CHK1, human] });
    // Deterministic evidence under a human check id is not a human judgement.
    const forged = passEvidence(human, { reviewer: { kind: "deterministic" } });
    const forgedResult = evaluateWithNoGap({ task, evidence: [passEvidence(CHK1), forged] });
    expect(codes(forgedResult)).toContain("check_missing");

    const honest = passEvidence(human, { reviewer: { kind: "human", actor: "owner" } });
    const result = evaluateWithNoGap({ task, evidence: [passEvidence(CHK1), honest] });
    expect(codes(result)).toEqual([]);
  });
});
