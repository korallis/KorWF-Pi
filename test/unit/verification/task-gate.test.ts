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
    attemptId: "at-author" as Attempt["id"],
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

// ---------------------------------------------------------------------------
// 2. Per-predicate rejections (gates.spec.md §2)
// ---------------------------------------------------------------------------

describe("T2.C0: the gate is entered from review, unblocked, with a claim on record", () => {
  it("T2.C0.notInReview", () => {
    const result = evaluateWithNoGap({ task: taskInReview({ status: "running" }) });
    expect(codes(result)).toContain("not_in_review");
    expect(result.pass).toBe(false);
  });

  it("T2.C0.blocked — an unresolved blocker refuses the gate", () => {
    const result = evaluateWithNoGap({ unresolvedBlockers: ["dependency"] });
    expect(codes(result)).toContain("blocker_present");
  });

  it("T2.C0.noClaim — a completion claim must exist, but only as existence", () => {
    const result = evaluateWithNoGap({ attempts: [] });
    expect(codes(result)).toContain("no_completion_claim");
  });

  it("T2.C0.claimAtAnotherRevision — a claim about an older task revision is not a claim", () => {
    const result = evaluateWithNoGap({ attempts: [authorAttempt({ taskRevision: 2 })] });
    expect(codes(result)).toContain("no_completion_claim");
  });
});

describe("T2.C1: deterministic checks at the exact revision", () => {
  it("T2.C1.noChecks", () => {
    const result = evaluateWithNoGap({ task: taskInReview({ checks: [], acceptanceCriteria: [] }) });
    expect(codes(result)).toContain("no_checks");
  });

  it("T2.C1.criterionUncovered — detail names the criterion", () => {
    const task = taskInReview({ checks: [CHK1, { ...CHK2, coversCriteria: [] }] });
    const result = evaluateWithNoGap({ task });
    const rejection = result.reasons.find((r) => r.reasonCode === "criterion_uncovered");
    expect(rejection?.detail).toBe("ac2");
  });

  const nonPassStates: { state: string; exitStatus: EvidenceExitStatus; code: string }[] = [
    { state: "fail", exitStatus: { kind: "exited", code: 1 }, code: "check_fail" },
    { state: "flaky", exitStatus: { kind: "flaky", runs: [0, 1] }, code: "check_flaky" },
    { state: "missing", exitStatus: { kind: "missing" }, code: "check_missing" },
    { state: "unavailable", exitStatus: { kind: "unavailable", reason: "command_not_found" }, code: "check_unavailable" },
    { state: "timeout", exitStatus: { kind: "timed_out" }, code: "check_timeout" },
  ];

  for (const { state, exitStatus, code } of nonPassStates) {
    it(`T2.C1.eachNonPassState[${state}] — reported verbatim, never collapsed to fail`, () => {
      const result = evaluateWithNoGap({ evidence: [passEvidence(CHK1), stateEvidence(CHK2, exitStatus)] });
      expect(codes(result)).toContain(code);
      const rejection = result.reasons.find((r) => r.reasonCode === code);
      expect(rejection?.detail).toContain(`"${state}"`);
      expect(result.checkStates).toContainEqual({ checkId: "chk2", state });
    });
  }

  it("T2.C1.noEvidenceAtAll — a check with no run is missing, never pass", () => {
    const result = evaluateWithNoGap({ evidence: [passEvidence(CHK1)] });
    expect(codes(result)).toContain("check_missing");
  });

  it("T2.C1.superseded — a superseded pass contributes nothing", () => {
    const pass = passEvidence(CHK2);
    const later = passEvidence(CHK2, {
      exitStatus: { kind: "exited", code: 1 },
      supersedesId: pass.id,
      createdAt: "2026-01-01T00:00:09.000Z",
    });
    const result = evaluateWithNoGap({ evidence: [passEvidence(CHK1), pass, later] });
    expect(codes(result)).toContain("check_fail");
    // The superseded row is invisible: it is not the "latest fresh result".
    const fresh = freshEvidence(buildInput({ evidence: [pass, later] }), SHA);
    expect(fresh.map((e) => e.id)).not.toContain(pass.id);
  });

  it("T2.C1.latestResultTie — same createdAt ties break on the greater id, deterministically", () => {
    const a = passEvidence(CHK2, { id: "ev-aa" as Evidence["id"], createdAt: AT, exitStatus: { kind: "exited", code: 1 } });
    const b = passEvidence(CHK2, { id: "ev-bb" as Evidence["id"], createdAt: AT });
    const first = evaluateWithNoGap({ evidence: [passEvidence(CHK1), a, b] });
    const second = evaluateWithNoGap({ evidence: [passEvidence(CHK1), b, a] });
    expect(codes(first)).toEqual(codes(second));
    expect(first.pass).toBe(true);
  });
});

describe("T2.C2: condition 2 is a disjunction of two recorded outcomes", () => {
  it("T2.C2.gap — a recorded gap rejects", () => {
    const input = buildInput();
    const result = evaluateTaskGate({
      ...input,
      decisions: [noGapDecision(input, { action: "gap", confidence: 0.99 })],
    });
    expect(codes(result)).toContain("jev_gap");
  });

  it("T2.C2.belowThreshold — no_gap under θ is a gap", () => {
    const input = buildInput();
    const result = evaluateTaskGate({ ...input, decisions: [noGapDecision(input, { confidence: 0.5 })] });
    expect(codes(result)).toContain("jev_gap");
  });

  it("T2.C2.staleHash — a decision made before a check was rerun is not fresh", () => {
    const input = buildInput();
    const decision = noGapDecision(input, { stateHash: "f".repeat(64) });
    const result = evaluateTaskGate({ ...input, decisions: [decision] });
    expect(codes(result)).toContain("jev_decision_missing");
  });

  it("T2.C2.staleRevision — a decision at another SHA is not fresh", () => {
    const input = buildInput();
    const decision = noGapDecision(input, { freshness: { revision: OLD_SHA, decidedAt: AT, expiresAt: null } });
    expect(codes(evaluateTaskGate({ ...input, decisions: [decision] }))).toContain("jev_decision_missing");
  });

  it("T2.C2.questionVersionPinned — an unpinned question version does not answer C2", () => {
    const input = buildInput();
    const decision = noGapDecision(input, { questionVersion: "0.9.0" });
    expect(codes(evaluateTaskGate({ ...input, decisions: [decision] }))).toContain("jev_decision_missing");
  });

  it("T2.C2.errorIsNotDisabled — an error with jev.optional=false waits in review", () => {
    const input = buildInput();
    const decision = noGapDecision(input, { action: "error", confidence: null });
    const result = evaluateTaskGate({ ...input, decisions: [decision] });
    expect(codes(result)).toContain("jev_unavailable");
    expect(result.c2Branch).toBeNull();
  });

  it("T2.C2.unavailableFallbackRefusedWhenNotOptional — degrading is never implicit (D2)", () => {
    const input = buildInput();
    const result = evaluateTaskGate({ ...input, decisions: [fallbackDecision(input, "jev_unavailable")] });
    expect(codes(result)).toEqual(["jev_unavailable"]);
  });
});

describe("T2.C3: policy-required review", () => {
  it("T2.C3.reviewMissing", () => {
    const result = evaluateWithNoGap({ policy: policyNone({ modelReview: true }) });
    expect(codes(result)).toContain("review_missing");
  });

  it("T2.C3.approvalMissing — a high-risk task needs a user approval", () => {
    const result = evaluateWithNoGap({ task: taskInReview({ riskClass: "high" }) });
    expect(codes(result)).toContain("approval_missing");
  });

  it("T2.C3.highRiskCannotUnsetHumanApproval", () => {
    const result = evaluateWithNoGap({
      task: taskInReview({ riskClass: "high" }),
      policy: policyNone({ humanApproval: false }),
    });
    expect(codes(result)).toContain("approval_missing");
  });

  it("T2.C3.policyResultMissing — an unrecorded policy result is not 'no review needed'", () => {
    const result = evaluateWithNoGap({ policy: null });
    expect(codes(result)).toContain("policy_result_missing");
  });

  it("T2.C3.policyResultStale — a result computed at another revision does not count", () => {
    const result = evaluateWithNoGap({ policy: policyNone({ revision: OLD_SHA }) });
    expect(codes(result)).toContain("policy_result_missing");
  });

  it("T2.C3.passesWithAValidApprovalAndIndependentReview", () => {
    const reviewer = makeAttempt({ id: "at-reviewer" as Attempt["id"], taskId: TK, taskRevision: 3, role: "reviewer", outcome: "succeeded" });
    const review = passEvidence(CHK1, {
      checkId: null,
      requirementId: "ac1",
      commandIdentity: null,
      reviewer: { kind: "model", model: "example-provider/example-model", attemptId: reviewer.id },
    });
    const approval: Approval = makeApproval({
      scope: { kind: "task", taskId: TK },
      taskRevision: 3,
      planRevision: 1,
      permittedAction: "complete_task",
      riskClass: "high",
      actor: { kind: "user", identity: "owner" },
    });
    const result = evaluateWithNoGap({
      task: taskInReview({ riskClass: "high" }),
      evidence: [passEvidence(CHK1), passEvidence(CHK2), review],
      attempts: [authorAttempt(), reviewer],
      approvals: [approval],
      policy: policyNone({ modelReview: true, humanApproval: true }),
    });
    expect(codes(result)).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Bypass scenarios (docs/gates.md §8) — every one is refused
// ---------------------------------------------------------------------------

describe("AC1/AC2/AC3: bypass attempts are refused with a reason code", () => {
  it("B2 — Jev 'no gap' cannot substitute for a failing check", () => {
    const result = evaluateWithNoGap({
      evidence: [passEvidence(CHK1), stateEvidence(CHK2, { kind: "exited", code: 1 })],
    });
    expect(result.pass).toBe(false);
    expect(codes(result)).toContain("check_fail");
    // C2 really was satisfied; it simply has no authority over C1.
    expect(result.conditions.find((c) => c.id === "C2")?.satisfied).toBe(true);
    expect(result.conditions.find((c) => c.id === "C1")?.satisfied).toBe(false);
  });

  it("B3 — evidence recorded at a previous SHA is invisible", () => {
    const result = evaluateWithNoGap({
      evidence: [passEvidence(CHK1, { revision: OLD_SHA }), passEvidence(CHK2, { revision: OLD_SHA })],
    });
    expect(codes(result)).toContain("check_missing");
    const detail = result.reasons.find((r) => r.reasonCode === "check_missing")?.detail ?? "";
    expect(detail).toContain("evidence_stale_revision");
  });

  it("B4 — evidence at the right SHA but an older task revision is stale", () => {
    const result = evaluateWithNoGap({
      evidence: [passEvidence(CHK1, { taskRevision: 2 }), passEvidence(CHK2, { taskRevision: 2 })],
    });
    const detail = result.reasons.find((r) => r.reasonCode === "check_missing")?.detail ?? "";
    expect(detail).toContain("evidence_stale_task_revision");
  });

  const trivialCommands = ["true", "exit 0", ":", "/bin/true", "echo ok", "cd x && true", "npm test || true"];
  for (const command of trivialCommands) {
    it(`B5 — a check that cannot fail is not a registered check: ${JSON.stringify(command)}`, () => {
      const task = taskInReview({ checks: [CHK1, { ...CHK2, command }] });
      const result = evaluateWithNoGap({ task, evidence: [passEvidence(CHK1), passEvidence({ ...CHK2, command })] });
      expect(codes(result)).toContain("check_trivial");
      // And it covers nothing, so ac2 is uncovered as well.
      expect(codes(result)).toContain("criterion_uncovered");
    });
  }

  it("B6 — evidence produced by a different command than the registered one", () => {
    const forged = passEvidence(CHK2, { commandIdentity: { command: "true", cwd: ".", environmentHash: HASH } });
    const result = evaluateWithNoGap({ evidence: [passEvidence(CHK1), forged] });
    expect(codes(result)).toContain("command_identity_mismatch");
    expect(result.checkStates).toContainEqual({ checkId: "chk2", state: "fail" });
  });

  it("B6.cwd — the same command run somewhere else is not the registered check", () => {
    const forged = passEvidence(CHK2, {
      commandIdentity: { command: CHK2.command, cwd: "vendor", environmentHash: HASH },
    });
    const result = evaluateWithNoGap({ evidence: [passEvidence(CHK1), forged] });
    expect(codes(result)).toContain("command_identity_mismatch");
  });

  it("B7 — a review from the authoring attempt is not independent", () => {
    const author = authorAttempt();
    const review = passEvidence(CHK1, {
      checkId: null,
      commandIdentity: null,
      reviewer: { kind: "model", model: "example-provider/example-model", attemptId: author.id },
    });
    const result = evaluateWithNoGap({
      evidence: [passEvidence(CHK1), passEvidence(CHK2), review],
      attempts: [author],
      policy: policyNone({ modelReview: true }),
    });
    expect(codes(result)).toContain("review_not_independent");
  });

  it("B7.handoffChain — nor is a handoff of the authoring attempt", () => {
    const author = authorAttempt();
    const handoff = makeAttempt({
      id: "at-handoff" as Attempt["id"],
      taskId: TK,
      taskRevision: 3,
      role: "reviewer",
      outcome: "succeeded",
      handedOffFromAttemptId: author.id,
    });
    const review = passEvidence(CHK1, {
      checkId: null,
      commandIdentity: null,
      reviewer: { kind: "model", model: "example-provider/example-model", attemptId: handoff.id },
    });
    const result = evaluateWithNoGap({
      evidence: [passEvidence(CHK1), passEvidence(CHK2), review],
      attempts: [author, handoff],
      policy: policyNone({ modelReview: true }),
    });
    expect(codes(result)).toContain("review_not_independent");
  });

  it("B8 — a policy actor cannot supply a high-risk human approval", () => {
    const approval = makeApproval({
      actor: { kind: "policy", identity: "unattended-policy" },
      scope: { kind: "task", taskId: TK },
      taskRevision: 3,
      planRevision: 1,
      permittedAction: "complete_task",
      riskClass: "high",
    });
    const result = evaluateWithNoGap({ task: taskInReview({ riskClass: "high" }), approvals: [approval] });
    expect(codes(result)).toContain("approval_actor_not_user");
  });

  it("B8.scope — an approval scoped to another task does not count", () => {
    const approval = makeApproval({
      scope: { kind: "task", taskId: "tk-other" as TaskId },
      taskRevision: 3,
      planRevision: 1,
      permittedAction: "complete_task",
      riskClass: "high",
    });
    const result = evaluateWithNoGap({ task: taskInReview({ riskClass: "high" }), approvals: [approval] });
    expect(codes(result)).toContain("approval_missing");
  });

  it("B8.planRevision — an approval from an older plan revision is invalid", () => {
    const approval = makeApproval({
      scope: { kind: "task", taskId: TK },
      taskRevision: 3,
      planRevision: 0,
      permittedAction: "complete_task",
      riskClass: "high",
    });
    const result = evaluateWithNoGap({ task: taskInReview({ riskClass: "high" }), approvals: [approval] });
    expect(codes(result)).toContain("approval_invalid:plan_revision_changed");
  });

  it("B8.expired — an expired approval is invalid", () => {
    const approval = makeApproval({
      scope: { kind: "task", taskId: TK },
      taskRevision: 3,
      planRevision: 1,
      permittedAction: "complete_task",
      riskClass: "high",
      expiresAt: "2025-01-01T00:00:00.000Z",
    });
    const result = evaluateWithNoGap({ task: taskInReview({ riskClass: "high" }), approvals: [approval] });
    expect(codes(result)).toContain("approval_invalid:expired");
  });

  it("B8.consumed — a single-use approval cannot certify a second completion", () => {
    const approval = makeApproval({
      scope: { kind: "task", taskId: TK },
      taskRevision: 3,
      planRevision: 1,
      permittedAction: "complete_task",
      riskClass: "high",
      invalidation: { reason: "consumed", at: AT, detail: null },
    });
    const result = evaluateWithNoGap({ task: taskInReview({ riskClass: "high" }), approvals: [approval] });
    expect(codes(result)).toContain("approval_invalid:consumed");
  });

  it("B9 — required=false is reporting only, never an exemption", () => {
    const task = taskInReview({ checks: [CHK1, { ...CHK2, required: false }] });
    const result = evaluateWithNoGap({ task, evidence: [passEvidence(CHK1)] });
    expect(codes(result)).toContain("check_missing");
  });

  it("B10 — Jev disabled with no decision row at all: absence is not a state", () => {
    const input = buildInput({ jev: JEV_DISABLED });
    const result = evaluateTaskGate({ ...input, decisions: [] });
    expect(codes(result)).toEqual(["jev_decision_missing"]);
    expect(result.pass).toBe(false);
  });

  it("B11 — fallback row present but a criterion has no passing evidence row", () => {
    const input = buildInput({
      jev: JEV_DISABLED,
      evidence: [passEvidence(CHK1), passEvidence(CHK2, { requirementId: "ac1" })],
    });
    const result = evaluateTaskGate({ ...input, decisions: [fallbackDecision(input, "jev_disabled")] });
    expect(codes(result)).toContain("fallback_coverage_gap");
  });

  it("B11.provenance — a check whose provenance touches no owned path fails DET_COVERAGE", () => {
    const outside = passEvidence(CHK2, {
      provenance: [
        { revision: SHA, path: "vendor/other.ts", range: null, retrievalMethod: "explicit", contentHash: HASH },
      ],
    });
    const input = buildInput({ jev: JEV_DISABLED, evidence: [passEvidence(CHK1), outside] });
    const result = evaluateTaskGate({ ...input, decisions: [fallbackDecision(input, "jev_disabled")] });
    const gap = result.reasons.find((r) => r.reasonCode === "fallback_coverage_gap");
    expect(gap?.detail).toContain("ownership");
  });

  const presentedAsSuccess: { label: string; exitStatus: EvidenceExitStatus; code: string }[] = [
    { label: "flaky", exitStatus: { kind: "flaky", runs: [0, 1] }, code: "check_flaky" },
    { label: "timeout", exitStatus: { kind: "timed_out" }, code: "check_timeout" },
    { label: "unavailable", exitStatus: { kind: "unavailable", reason: "command_not_found" }, code: "check_unavailable" },
  ];
  for (const { label, exitStatus, code } of presentedAsSuccess) {
    it(`B12 — a ${label} result reported as "all green" is still refused`, () => {
      const result = evaluateWithNoGap({ evidence: [passEvidence(CHK1), stateEvidence(CHK2, exitStatus)] });
      expect(codes(result)).toContain(code);
      expect(result.pass).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. B1 and the store: `done` is unreachable except through a receipt
// ---------------------------------------------------------------------------

/** Seed a store with the fixture workflow/phase/task and the given rows. */
function seed(
  store: Store,
  args: {
    readonly task?: ReturnType<typeof makeTask>;
    readonly evidence?: readonly Evidence[];
    readonly decisions?: readonly Decision[];
    readonly approvals?: readonly Approval[];
    readonly attempts?: readonly Attempt[];
  } = {},
): TaskGateInput {
  const workflow = makeWorkflow({ planRevision: 1, policyVersion: "2026.1", status: "running" });
  const task = args.task ?? taskInReview();
  // Materialise each list exactly once: the store and the in-memory input
  // must hold the *same* rows, or the state hash would differ for reasons
  // that have nothing to do with what is being tested.
  const evidence = args.evidence ?? [passEvidence(CHK1), passEvidence(CHK2)];
  const attempts = args.attempts ?? [authorAttempt()];
  const approvals = args.approvals ?? [];
  store.workflows.insert(workflow);
  store.phases.insert(makePhase());
  store.tasks.insert(task);
  for (const attempt of attempts) store.attempts.insert(attempt);
  for (const row of evidence) store.evidence.insert(row);
  for (const row of approvals) store.approvals.insert(row);
  const input = buildInput({ workflow, task, evidence, attempts, approvals });
  const decisions = args.decisions ?? [noGapDecision(input)];
  for (const row of decisions) store.decisions.insert(row);
  return { ...input, decisions };
}

const gateOptions = {
  policy: policyNone(),
  jev: JEV_ENABLED,
  now: AT,
  newId: () => `rc-${(counter += 1)}`,
  worktreePath: "/unused",
  resolveRevision: () => SHA,
};

describe("AC4/B1: nothing but a passing gate receipt can set Task.status = done", () => {
  it("B1.rawPatch — a direct store patch to done is refused as status_write_forbidden", () => {
    const store = freshStore();
    seed(store, { evidence: [] });
    expect(() => store.tasks.update(TK, { status: "done" })).toThrow(/status_write_forbidden/);
    expect(store.tasks.require(TK).status).toBe("review");
  });

  it("B1.workerTransition — a worker calling transition(…, 'done') is refused", () => {
    const store = freshStore();
    seed(store, { evidence: [] });
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "done",
        trigger: "task_gate_passed",
        actor: { kind: "worker", identity: "worker-1" },
        guards: {
          all_checks_pass_exact_revision: () => true,
          no_jev_gap_or_disabled: () => true,
          policy_review_satisfied: () => true,
        },
        evidenceRefs: ["ev:claim"],
        now: () => AT,
        newId: () => `e-${(counter += 1)}`,
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("unauthorized_actor");
    expect(store.tasks.require(TK).status).toBe("review");
  });

  it("B1.engineWithoutReceipt — even the engine with every guard true is refused", () => {
    const store = freshStore();
    seed(store, { evidence: [] });
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store,
        taskId: TK,
        to: "done",
        trigger: "task_gate_passed",
        actor: { kind: "engine", identity: "engine" },
        guards: {
          all_checks_pass_exact_revision: () => true,
          no_jev_gap_or_disabled: () => true,
          policy_review_satisfied: () => true,
          checks_registered: () => true,
        },
        evidenceRefs: ["ev:claim"],
        now: () => AT,
        newId: () => `e-${(counter += 1)}`,
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("status_write_forbidden");
    expect(store.tasks.require(TK).status).toBe("review");
    // The refusal is on the record, as a rejected transition event.
    const events = store.transitionLog.forSubject("task", TK);
    expect(events.at(-1)?.disposition).toBe("rejected");
  });

  it("B1.rejectionReceipt — a rejecting receipt cannot authorise the write", () => {
    const store = freshStore();
    seed(store, { evidence: [] });
    const { receipt, result } = runTaskGate(store, TK, gateOptions);
    expect(result.pass).toBe(false);
    expect(receipt.disposition).toBe("reject");
    expect(() => store.tasks.authoriseDone(receipt.receiptId)).toThrow(/status_write_forbidden/);
  });

  it("B1.singleUse — a passing receipt authorises exactly one completion", () => {
    const store = freshStore();
    seed(store);
    const { receipt, result } = runTaskGate(store, TK, gateOptions);
    expect(result.pass).toBe(true);
    expect(store.tasks.authoriseDone(receipt.receiptId)).toBe(receipt.receiptId);
    expect(() => store.tasks.authoriseDone(receipt.receiptId)).toThrow(/already used/);
  });

  it("B1.revisionPinned — a receipt stops authorising once the task revision moves", () => {
    const store = freshStore();
    seed(store);
    const { receipt } = runTaskGate(store, TK, gateOptions);
    store.tasks.update(TK, { revision: 4, goal: "Write a different thing" });
    expect(() => store.tasks.authoriseDone(receipt.receiptId)).toThrow(/status_write_forbidden/);
  });

  it("completeTask is the route that works: gate, receipt, transition, done", () => {
    const store = freshStore();
    seed(store);
    const outcome = completeTask(store, TK, {
      ...gateOptions,
      actor: { kind: "engine", identity: "engine" },
      evidenceRefs: ["ev:checks", "ev:gap", "ev:policy"],
    });
    expect(outcome.result.pass).toBe(true);
    expect(outcome.transition?.subject.status).toBe("done");
    expect(store.tasks.require(TK).status).toBe("done");
    expect(store.gateReceipts.find(outcome.receipt.receiptId)?.consumedAt).toBe(AT);
  });

  it("completeTask leaves the task in review and writes no partial state when it refuses", () => {
    const store = freshStore();
    seed(store, { evidence: [passEvidence(CHK1)] });
    const outcome = completeTask(store, TK, {
      ...gateOptions,
      actor: { kind: "engine", identity: "engine" },
      evidenceRefs: ["ev:checks"],
    });
    expect(outcome.transition).toBeNull();
    expect(store.tasks.require(TK).status).toBe("review");
    expect(outcome.receipt.disposition).toBe("reject");
    expect(outcome.receipt.consumedAt).toBeNull();
  });
});
