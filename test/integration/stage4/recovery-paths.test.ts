/**
 * Stage 4 exit criterion, part 5 — **failures produce bounded recovery or a
 * clear stop** (issue #55; PLAN §3.G; #52, #53).
 *
 * Three Scope items, each an end-to-end sequence over the real store:
 *
 *  - "Persistent failure → after max attempts, `stop` with a concise failure
 *    report."
 *  - "Budget exhausted mid-recovery → hard stop, state resumable."
 *  - "Cancellation during recovery → no orphan processes, task `cancelled`,
 *    worktree intact."
 *
 * The adversarial framing still applies: each test also asserts that the
 * bound cannot be talked around — not by a config, not by a stall signal, not
 * by re-running the same decision after a restart.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chooseRecovery,
  describeRecovery,
  projectRecovery,
  recoverFromFailure,
  usageFromLog,
  maxAttemptsFor,
  isTerminalResponse,
  type RecoveryInput,
} from "../../../src/workflow/recovery.ts";
import { classifyFailure } from "../../../src/workflow/failure.ts";
import { defaultConfig } from "../../../src/config/load.ts";
import { validateConfig } from "../../../src/config/validate.ts";
import { runCheck } from "../../../src/verification/checks.ts";
import { transitionTask, TransitionRejected } from "../../../src/workflow/state.ts";
import { Ledger, BudgetExceededError } from "../../../src/telemetry/ledger.ts";
import { budgetsWith, knownUsage } from "../../helpers/ledger.ts";
import type { CheckDefinition } from "../../../src/storage/records.ts";
import {
  AT,
  CHK1,
  TK,
  WF,
  PH,
  claimAttempt,
  commitFiles,
  createFixture,
  type Stage4Fixture,
} from "./fixture.ts";
import { ROUTE_WITHOUT_VALIDATION, TEST_FAILS } from "./patches.ts";

const CONFIG = defaultConfig().recovery;
const open: Stage4Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

/** A repository whose test genuinely fails: the criterion is unimplemented. */
function failingFixture(): Stage4Fixture {
  const fixture = createFixture({ checks: [CHK1], taskStatus: "running" });
  open.push(fixture);
  commitFiles(
    fixture,
    { "src/routes/orders.js": ROUTE_WITHOUT_VALIDATION, "test/routes/orders.test.js": TEST_FAILS },
    "unimplemented",
  );
  return fixture;
}

/** The #52 classification of a genuinely failing check run. */
function classifyRun(stderr: string) {
  return classifyFailure({ stderr, exitCode: 1, command: CHK1.command, checkStatus: "fail" });
}

describe("AC6 persistent failure ends in a bounded stop with a concise report", () => {
  it("the same check fails every time, and recovery terminates within the attempt ceiling", async () => {
    const fixture = failingFixture();
    const max = maxAttemptsFor("task", CONFIG);
    const decisions: string[] = [];
    let terminalAt: number | null = null;

    for (let attempt = 1; attempt <= max && terminalAt === null; attempt += 1) {
      claimAttempt(fixture, { id: `at-${attempt}` as never, outcome: "failed" });
      const run = await runCheck(CHK1, {
        cwd: fixture.repo.path,
        subject: { workflowId: WF, taskId: TK, taskRevision: 1, attemptId: null, requirementId: "ac1" },
        timeoutMs: 20_000,
      });
      // The failure is real: a real command really exited non-zero.
      expect(run.status).toBe("fail");

      const recorded = recoverFromFailure({
        store: fixture.store,
        workflowId: WF,
        subjectKind: "task",
        subjectId: TK,
        classification: classifyRun(run.stderr.text),
        attemptsUsed: attempt,
        config: CONFIG,
        now: () => AT,
        newId: () => fixture.nextId("rv"),
      });
      decisions.push(recorded.decision.response);
      // Whatever the response is, an undiagnosed failure is never answered
      // with a blind repeat of the step that just failed.
      expect(recorded.decision.response).not.toBe("retry");
      if (recorded.decision.terminal) terminalAt = attempt;
    }

    // It stopped, inside the ceiling, and named the rule that stopped it.
    expect(terminalAt).not.toBeNull();
    expect(terminalAt as number).toBeLessThanOrEqual(max);

    const rows = fixture.store.recoveries.forSubject("task", TK);
    expect(rows).toHaveLength(terminalAt as number);
    const last = rows.at(-1);
    expect(last?.terminal).toBe(true);
    expect(["bound:max-attempts", "evidence:exhausted"]).toContain(last?.policyRule);
    expect(isTerminalResponse(last?.response as never)).toBe(true);
    // The "concise failure report" is reconstructed from rows, never from a
    // log line: every row carries its rule, its reason and the ceiling.
    expect(rows.every((r) => r.failureRule.length > 0 && r.reason.length > 0)).toBe(true);
    expect(rows.every((r) => r.maxAttempts === max)).toBe(true);
    expect(decisions.length).toBe(terminalAt);
  }, 40_000);

  it("the ceiling cannot be talked around: no stall signal or classification produces another retry", () => {
    const max = maxAttemptsFor("task", CONFIG);
    const base: RecoveryInput = {
      classification: classifyFailure({ stderr: "AssertionError: expected 201 to equal 400", exitCode: 1, checkStatus: "fail" }),
      attemptsUsed: max,
      subjectKind: "task",
    };
    for (const stalls of [
      [],
      [{ kind: "repeated_failure" as const, taskId: TK as string, attemptId: "at-1", count: 3, threshold: 3, detail: "same failure", attemptIds: ["at-1"] }],
      [{ kind: "no_progress" as const, taskId: TK as string, attemptId: "at-1", count: 3, threshold: 3, detail: "no writes", attemptIds: ["at-1"] }],
    ]) {
      const decision = chooseRecovery({ ...base, stalls }, CONFIG);
      expect(decision.terminal).toBe(true);
      expect(decision.policyRule).toBe("bound:max-attempts");
      expect(decision.attemptsRemaining).toBe(0);
      expect(describeRecovery(decision)).toContain(`${max}/${max}`);
    }
  });

  it("the projected ladder terminates, so the user can be told what happens if it keeps failing", () => {
    const projection = projectRecovery(
      {
        classification: classifyFailure({ stderr: "AssertionError: expected 201 to equal 400", exitCode: 1, checkStatus: "fail" }),
        attemptsUsed: 1,
        subjectKind: "task",
      },
      CONFIG,
    );
    expect(projection.length).toBeGreaterThan(0);
    expect(projection.length).toBeLessThanOrEqual(maxAttemptsFor("task", CONFIG) + 1);
    expect(projection.at(-1)?.terminal).toBe(true);
  });

  it("a config cannot raise the ceiling above the schema maximum", () => {
    const attempt = validateConfig({
      ...defaultConfig(),
      recovery: { ...CONFIG, maxAttemptsPerTask: 99 },
    } as never);
    expect(attempt.errors.length).toBeGreaterThan(0);
    expect(attempt.errors.some((e) => e.path.includes("maxAttemptsPerTask"))).toBe(true);
  });
});

describe("AC7 a budget exhausted mid-recovery is a hard stop, and the state is resumable", () => {
  it("the ledger refuses the next call, writes nothing, and the spend already recorded survives", async () => {
    const fixture = failingFixture();
    const ledger = new Ledger(fixture.store, {
      budgets: budgetsWith({ task: { maxSpendUsd: 1 } }),
      now: () => AT,
      newId: () => fixture.nextId("res"),
      sessionId: "stage4",
    });
    const attempt = claimAttempt(fixture, { outcome: "failed" });
    const scope = { workflowId: WF, phaseId: PH, taskId: TK, attemptId: attempt.id };

    // First recovery attempt spends most of the task budget.
    const first = ledger.reserve({ scope, estimate: knownUsage(0.9) });
    ledger.settle(first, knownUsage(0.9));

    // The second one cannot be afforded. The refusal is thrown *before*
    // anything is written, so the stop is clean.
    const before = fixture.store.ledger.list().length;
    expect(() => ledger.reserve({ scope, estimate: knownUsage(0.9) })).toThrow(BudgetExceededError);
    expect(fixture.store.ledger.list().length).toBe(before);

    // And the recorded spend is still there for a later session to read: the
    // cap survives a restart because it is recomputed from the rows.
    const status = ledger.status(scope);
    const taskScope = status.scopes.find((s) => s.scope === "task");
    expect(taskScope?.spendUsd.used).toBeCloseTo(0.9, 6);
    expect(taskScope?.spendUsd.remaining).toBeCloseTo(0.1, 6);
  }, 30_000);

  it("the per-response caps survive a resumed session, because they are read from the log", () => {
    const fixture = failingFixture();
    // Spend the single permitted `gather_evidence` on an unknown failure.
    const unknown = classifyFailure({ stderr: "something nobody has a rule for", exitCode: 1 });
    const first = recoverFromFailure({
      store: fixture.store,
      workflowId: WF,
      subjectKind: "task",
      subjectId: TK,
      classification: unknown,
      attemptsUsed: 1,
      config: CONFIG,
      now: () => AT,
      newId: () => fixture.nextId("rv"),
    });
    expect(first.decision.response).toBe("gather_evidence");

    // A "resumed session" passes no usage: it must be reconstructed.
    expect(usageFromLog(fixture.store, "task", TK).gather_evidence).toBe(1);
    const second = recoverFromFailure({
      store: fixture.store,
      workflowId: WF,
      subjectKind: "task",
      subjectId: TK,
      classification: unknown,
      attemptsUsed: 2,
      config: CONFIG,
      now: () => AT,
      newId: () => fixture.nextId("rv"),
    });
    expect(second.decision.terminal).toBe(true);
    expect(second.decision.policyRule).toBe("evidence:exhausted");
  });

  it("a hard stop leaves the task where it was: nothing partial, nothing done", () => {
    const fixture = failingFixture();
    claimAttempt(fixture, { outcome: "failed" });
    const result = transitionTask({
      store: fixture.store,
      taskId: TK,
      to: "failed",
      trigger: "non_cap_failure",
      actor: { kind: "engine", identity: "engine" },
      guards: { failure_observed: () => true },
      evidenceRefs: ["failure:implementation", "recovery:bound:max-attempts"],
      gitRevision: fixture.head(),
      now: () => AT,
      newId: () => fixture.nextId("e"),
    });
    expect(result.subject.status).toBe("failed");
    // `failed` is not terminal: the task can be made ready again, which is
    // what "resumable" means here.
    const back = transitionTask({
      store: fixture.store,
      taskId: TK,
      to: "ready",
      trigger: "readiness_validated",
      actor: { kind: "engine", identity: "engine" },
      guards: {
        checks_registered: () => true,
        readiness_valid: () => true,
        authorization_current: () => true,
        recovery_authorized: () => true,
      },
      evidenceRefs: ["recovery:authorized"],
      now: () => AT,
      newId: () => fixture.nextId("e"),
    });
    expect(back.subject.status).toBe("ready");
    expect(fixture.store.tasks.require(TK).status).not.toBe("done");
  });
});

describe("AC8 cancellation during recovery: no orphan processes, task cancelled, worktree intact", () => {
  it("an aborted check leaves no descendant alive and is recorded as timed out, never pass", async () => {
    const fixture = failingFixture();
    const marker = `korwf-stage4-${process.pid}-${Date.now()}`;
    const pidFile = join(fixture.scratch, "pids.txt");
    // A three-level tree, so killing only the direct child leaves survivors.
    const command =
      `sh -c 'sleep 120 & echo $! >> ${pidFile}; ` +
      `sh -c "sleep 120 & echo \\$! >> ${pidFile}; sleep 120" & echo $! >> ${pidFile}; ` +
      `echo ${marker}; exit 1'`;
    const check: CheckDefinition = { ...CHK1, id: "chk-slow", command };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const run = await runCheck(check, {
      cwd: fixture.repo.path,
      subject: { workflowId: WF, taskId: TK, taskRevision: 1, attemptId: null, requirementId: "ac1" },
      signal: controller.signal,
      killGraceMs: 150,
    });

    expect(run.status).toBe("timeout");
    expect(run.status).not.toBe("pass");

    await new Promise((r) => setTimeout(r, 500));
    const pids = readFileSync(pidFile, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
    expect(pids.length).toBeGreaterThan(0);
    expect(pids.filter(alive)).toEqual([]);
    const stray = execFileSync("sh", ["-c", `ps -eo args= | grep -F ${marker} | grep -v grep || true`], {
      encoding: "utf8",
    }).trim();
    expect(stray).toBe("");
  }, 40_000);

  it("the task goes to cancelled, the worktree keeps the user's uncommitted work, and no further edge exists", async () => {
    const fixture = failingFixture();
    claimAttempt(fixture, { outcome: "failed" });
    // The user was editing something when they cancelled.
    fixture.repo.writeDirty("src/routes/orders.js", ROUTE_WITHOUT_VALIDATION + "\n// user edit in progress\n");

    const cancelled = transitionTask({
      store: fixture.store,
      taskId: TK,
      to: "cancelled",
      trigger: "cancel",
      actor: { kind: "user", identity: "owner" },
      guards: { cancellation_requested: () => true },
      evidenceRefs: ["user:cancel", "children:terminated"],
      gitRevision: fixture.head(),
      now: () => AT,
      newId: () => fixture.nextId("e"),
    });
    expect(cancelled.subject.status).toBe("cancelled");

    // The worktree is intact and still dirty: cancellation never discards
    // user work (transitions.ts `task-cancel`: "retain worktrees and user
    // changes").
    expect(existsSync(join(fixture.repo.path, "src/routes/orders.js"))).toBe(true);
    expect(readFileSync(join(fixture.repo.path, "src/routes/orders.js"), "utf8")).toContain("user edit in progress");
    expect(fixture.repo.git("status", "--porcelain")).toContain("src/routes/orders.js");

    // `cancelled` is terminal: the partial result can never become a success.
    let error: TransitionRejected | undefined;
    try {
      transitionTask({
        store: fixture.store,
        taskId: TK,
        to: "ready",
        trigger: "readiness_validated",
        actor: { kind: "engine", identity: "engine" },
        guards: {
          checks_registered: () => true,
          readiness_valid: () => true,
          authorization_current: () => true,
          recovery_authorized: () => true,
        },
        evidenceRefs: ["ev:1"],
        now: () => AT,
        newId: () => fixture.nextId("e"),
      });
    } catch (caught) {
      error = caught as TransitionRejected;
    }
    expect(error?.code).toBe("terminal_subject");
    expect(fixture.store.tasks.require(TK).status).toBe("cancelled");
  }, 30_000);
});

/** Is this pid still running? `kill -0` without sending a signal. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
