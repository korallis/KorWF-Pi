/**
 * Bounded recovery, store-backed half (issue #53; PLAN §3.G).
 *
 * AC2: "Flagged side-effect step is not retried without reconciliation (test
 *       with a spy)" — the spy is `runProbe`/`executeStep` below.
 * AC3: "Every recovery decision has an audit row with the rule applied."
 *
 * Reconciliation here goes through the #42 receipts in `store.actions`: this
 * issue does not re-derive "refuse a replay", it reads the log that already
 * refuses one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { actionIdFor } from "../../../src/storage/action-log.ts";
import { recordCompletedAction, guardAction } from "../../../src/workflow/reconcile.ts";
import {
  recoverFromFailure,
  usageFromLog,
  type RecoverableStep,
} from "../../../src/workflow/recovery.ts";
import { classifyFailure, type FailureCategory } from "../../../src/workflow/failure.ts";
import { defaultConfig } from "../../../src/config/load.ts";
import type { TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const TK = "tk-1" as TaskId;
const CONFIG = defaultConfig().recovery;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

function freshStore(): Store {
  const dir = makeTempDir("korwf-recovery-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `id-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "running" }));
  return store;
}

function classified(category: FailureCategory) {
  return {
    category,
    confidence: 1,
    rule: `rule:test-${category}`,
    source: "rule" as const,
    reason: "fixture",
    needsEvidence: false,
    evidenceRequests: [] as readonly string[],
  };
}

function recover(
  store: Store,
  over: {
    category?: FailureCategory;
    attemptsUsed?: number;
    step?: RecoverableStep;
    runProbe?: Parameters<typeof recoverFromFailure>[0]["runProbe"];
  } = {},
) {
  return recoverFromFailure({
    store,
    workflowId: WF,
    subjectKind: "task",
    subjectId: TK,
    classification: classified(over.category ?? "implementation"),
    attemptsUsed: over.attemptsUsed ?? 1,
    config: CONFIG,
    now: () => AT,
    newId: () => `rec-${(counter += 1)}`,
    ...(over.step === undefined ? {} : { step: over.step }),
    ...(over.runProbe === undefined ? {} : { runProbe: over.runProbe }),
  });
}

describe("AC3: every recovery decision has an audit row with the rule applied", () => {
  it("writes one row naming the policy rule, the failure category and the bound", () => {
    const store = freshStore();
    const { decision, rowId } = recover(store);
    const rows = store.recoveries.forSubject("task", TK);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.decisionRowId).toBe(rowId);
    expect(row.policyRule).toBe(decision.policyRule);
    expect(row.response).toBe(decision.response);
    expect(row.failureCategory).toBe("implementation");
    expect(row.failureRule).toBe("rule:test-implementation");
    expect(row.attemptsUsed).toBe(1);
    expect(row.maxAttempts).toBe(CONFIG.maxAttemptsPerTask);
    expect(row.reason.length).toBeGreaterThan(20);
  });

  it("records the terminal decisions too — a recovery that stopped is what needs explaining", () => {
    const store = freshStore();
    const { decision } = recover(store, { attemptsUsed: CONFIG.maxAttemptsPerTask });
    expect(decision.terminal).toBe(true);
    const row = store.recoveries.forSubject("task", TK)[0]!;
    expect(row.terminal).toBe(true);
    expect(row.policyRule).toBe("bound:max-attempts");
  });

  it("records the side-effect verdict and the action id it was established from", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_push", subjectId: TK });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "git_push",
      sessionId: "s-1",
      summary: "push to origin",
      externalEffect: true,
      now: () => AT,
    });
    recover(store, { step: { stepId: "push", sideEffect: true, actionId, externalEffect: true } });
    const row = store.recoveries.forSubject("task", TK)[0]!;
    expect(row.sideEffectStatus).toBe("already_applied");
    expect(row.actionId).toBe(actionId);
  });

  it("the log is append-only: a decision cannot be rewritten or deleted", () => {
    const store = freshStore();
    recover(store);
    expect(() => store.connection.exec("UPDATE recovery_decision SET response = 'retry'")).toThrow(/append-only/);
    expect(() => store.connection.exec("DELETE FROM recovery_decision")).toThrow(/append-only/);
  });

  it("the whole sequence of a failing task is readable afterwards, rung by rung", () => {
    const store = freshStore();
    const responses: string[] = [];
    for (let attempt = 1; attempt <= CONFIG.maxAttemptsPerTask + 2; attempt += 1) {
      const { decision } = recover(store, { attemptsUsed: attempt });
      responses.push(decision.response);
      if (decision.terminal) break;
    }
    const rows = store.recoveries.forWorkflow(WF);
    expect(rows.map((r) => r.response)).toEqual(responses);
    expect(rows[rows.length - 1]?.terminal).toBe(true);
    expect(rows.filter((r) => r.response === "retry").length).toBeLessThanOrEqual(CONFIG.maxAttemptsPerTask - 1);
  });
});

describe("AC1: the bound survives a restart, because it is read from the log", () => {
  it("usageFromLog counts each response already granted to this subject", () => {
    const store = freshStore();
    recover(store, { attemptsUsed: 1 });
    expect(usageFromLog(store, "task", TK)).toEqual({ retry: 1 });
    expect(store.recoveries.retriesGranted("task", TK)).toBe(1);
  });

  it("a caller that forgets its attempt counter still cannot exceed the per-response caps", () => {
    const store = freshStore();
    // Same attempt number every time — as a resumed session that lost its
    // counter would supply. The per-response caps still bound the ladder.
    for (let i = 0; i < 12; i += 1) recover(store, { category: "environment", attemptsUsed: 1 });
    const gathers = store.recoveries.forSubject("task", TK).filter((r) => r.response === "gather_evidence");
    expect(gathers.length).toBe(CONFIG.maxEvidenceGatherings);
    expect(store.recoveries.retriesGranted("task", TK)).toBe(0);
  });
});

describe("AC2: a flagged side-effect step is not retried without reconciliation (spy)", () => {
  const probe = { probeId: "probe:git-log", description: "look for the commit on HEAD" };

  it("runs the declared probe before deciding, and does not retry on an unknown verdict", () => {
    const store = freshStore();
    const runProbe = vi.fn(() => ({ applied: "unknown" as const, detail: "could not tell" }));
    const { decision } = recover(store, {
      step: { stepId: "commit", sideEffect: true, reconciliationProbe: probe },
      runProbe,
    });
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(decision.response).not.toBe("retry");
    expect(decision.terminal).toBe(true);
  });

  it("with no probe and no receipt, the step is never retried and the probe spy is never needed", () => {
    const store = freshStore();
    const runProbe = vi.fn(() => ({ applied: false as const, detail: "unused" }));
    const { decision, reconciliation } = recover(store, {
      step: { stepId: "publish", sideEffect: true },
      runProbe,
    });
    expect(runProbe).not.toHaveBeenCalled();
    expect(reconciliation?.status).toBe("unknown");
    expect(decision.response).toBe(CONFIG.unreconcilableSideEffect);
  });

  it("a probe proving the effect did not land unblocks exactly one retry", () => {
    const store = freshStore();
    const runProbe = vi.fn(() => ({ applied: false as const, detail: "no such commit" }));
    const { decision } = recover(store, {
      step: { stepId: "commit", sideEffect: true, reconciliationProbe: probe },
      runProbe,
    });
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(decision.response).toBe("retry");
  });

  it("#42's receipt outranks the probe: a completed action is never re-run", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_commit", subjectId: TK });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "git_commit",
      sessionId: "s-1",
      summary: "commit the fix",
      now: () => AT,
    });
    const runProbe = vi.fn(() => ({ applied: false as const, detail: "probe would say retry" }));
    const { decision, reconciliation } = recover(store, {
      step: { stepId: "commit", sideEffect: true, actionId, reconciliationProbe: probe },
      runProbe,
    });
    expect(runProbe).not.toHaveBeenCalled();
    expect(reconciliation?.source).toBe("action_receipt");
    expect(decision.response).not.toBe("retry");
  });

  it("if a caller ignored the decision and re-ran the action anyway, #42 refuses it", () => {
    const store = freshStore();
    const actionId = actionIdFor({ workflowId: WF, kind: "git_push", subjectId: TK });
    recordCompletedAction({
      store,
      workflowId: WF,
      actionId,
      kind: "git_push",
      sessionId: "s-1",
      summary: "push to origin",
      externalEffect: true,
      now: () => AT,
    });
    const verdict = guardAction({
      store,
      workflowId: WF,
      actionId,
      sessionId: "s-2",
      now: () => AT,
      newId: () => `rep-${(counter += 1)}`,
    });
    expect(verdict.kind).toBe("refused");
    expect(store.actions.replayAttempts(actionId)).toHaveLength(1);
  });

  it("a side-effect free step is retried with no probe run at all", () => {
    const store = freshStore();
    const runProbe = vi.fn(() => ({ applied: false as const, detail: "unused" }));
    const { decision, reconciliation } = recover(store, {
      step: { stepId: "npm-test", sideEffect: false, reconciliationProbe: probe },
      runProbe,
    });
    expect(runProbe).not.toHaveBeenCalled();
    expect(reconciliation?.status).toBe("none");
    expect(decision.response).toBe("retry");
  });
});

describe("an unknown failure is never acted on as a diagnosis (#52 boundary)", () => {
  it("records gather_evidence with the requests the classifier asked for", () => {
    const store = freshStore();
    const classification = classifyFailure({ stderr: "nothing matches any rule here" });
    expect(classification.category).toBe("unknown");
    const { decision } = recoverFromFailure({
      store,
      workflowId: WF,
      subjectKind: "task",
      subjectId: TK,
      classification,
      attemptsUsed: 1,
      config: CONFIG,
      now: () => AT,
      newId: () => `rec-${(counter += 1)}`,
    });
    expect(decision.response).toBe("gather_evidence");
    expect(decision.evidenceRequests.length).toBeGreaterThan(0);
    expect(store.recoveries.forSubject("task", TK)[0]?.policyRule).toBe("evidence:needs-evidence");
  });
});
