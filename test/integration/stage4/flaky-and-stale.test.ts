/**
 * Stage 4 exit criterion, part 3 — **flaky checks and stale evidence**
 * (issue #55; PLAN §2.4 "at the exact revision"; PLAN §3.F).
 *
 * Two attacks, both aimed at the same thing: making the gate believe a check
 * passed when it did not pass *here, now, at this revision*.
 *
 *  1. A check that flakes at the same revision. Real command, real disagreeing
 *     runs, no synthetic exit status.
 *  2. Evidence produced at an older commit, offered as current — including the
 *     variant where the worker rewrites the row's `revision` field to match.
 *
 * Scope items covered: "flaky checks", "missing evidence".
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { runCheckWithRerunPolicy, DEFAULT_RERUN_POLICY, taskCheckSummary } from "../../../src/verification/flaky.ts";
import { runTaskGate, completeTask, freshEvidence } from "../../../src/verification/task-gate.ts";
import { assessStaleness, invalidateStaleEvidence } from "../../../src/verification/invalidate.ts";
import { evaluateMappingOnly } from "../../../src/verification/evaluate.ts";
import type { CheckDefinition, Evidence, GitSha } from "../../../src/storage/records.ts";
import {
  AT,
  CHK1,
  CHK2,
  TK,
  WF,
  claimAttempt,
  commitFiles,
  createFixture,
  policyNone,
  provenanceFor,
  storeEvidence,
  type Stage4Fixture,
} from "./fixture.ts";
import { gateInput, recordC2, runAndStore } from "./gate.ts";
import { flakyCommand, ROUTE_WITH_VALIDATION, TEST_EXERCISES_CRITERION } from "./patches.ts";

const open: Stage4Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

function options(fixture: Stage4Fixture, over: { readonly revision?: GitSha } = {}) {
  return {
    policy: policyNone(fixture),
    jev: gateInput(fixture, { policy: policyNone(fixture) }).jev,
    now: AT,
    newId: () => fixture.nextId("rc"),
    worktreePath: fixture.repo.path,
    ...(over.revision === undefined ? {} : { resolveRevision: () => over.revision as GitSha }),
  };
}

describe("AC3 a check that flakes at the same revision never satisfies the gate", () => {
  it("two disagreeing runs at one revision reconcile to flaky, not to the passing run", async () => {
    const fixture = createFixture();
    open.push(fixture);
    const counter = join(fixture.scratch, "flaky-counter.txt");
    const flaky: CheckDefinition = { ...CHK1, id: "chk-flaky", command: flakyCommand(counter) };
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch",
    );
    fixture.store.tasks.update(TK, { checks: [flaky], revision: 2 });
    claimAttempt(fixture, { taskRevision: 2 });

    const result = await runCheckWithRerunPolicy(
      flaky,
      {
        cwd: fixture.repo.path,
        subject: { workflowId: WF, taskId: TK, taskRevision: 2, attemptId: null, requirementId: "ac1" },
        timeoutMs: 20_000,
      },
      DEFAULT_RERUN_POLICY,
    );

    // The counter file lives outside the worktree, so both runs saw the same
    // revision — the disagreement is genuine flakiness, not two states.
    expect(result.runs.length).toBeGreaterThan(1);
    expect(new Set(result.runs.map((r) => r.revision)).size).toBe(1);
    expect(result.status).toBe("flaky");
    expect(result.status).not.toBe("pass");
  }, 40_000);

  it("a flaky check refuses the gate with check_flaky, and the state name survives verbatim", async () => {
    const fixture = createFixture();
    open.push(fixture);
    const counter = join(fixture.scratch, "counter.txt");
    const flaky: CheckDefinition = { ...CHK1, id: "chk-flaky", command: flakyCommand(counter) };
    commitFiles(fixture, { "src/routes/orders.js": ROUTE_WITH_VALIDATION }, "patch");
    fixture.store.tasks.update(TK, { checks: [flaky], revision: 2 });
    claimAttempt(fixture, { taskRevision: 2 });

    const run = await runCheckWithRerunPolicy(
      flaky,
      {
        cwd: fixture.repo.path,
        subject: { workflowId: WF, taskId: TK, taskRevision: 2, attemptId: null, requirementId: "ac1" },
        timeoutMs: 20_000,
      },
      DEFAULT_RERUN_POLICY,
    );
    expect(run.status).toBe("flaky");
    // Store exactly what the runner produced, in order, and nothing else.
    // **This is the finding**: before #55 the reconciled `flaky` row was not
    // among the drafts, so a fail-then-pass sequence stored two honest rows
    // whose latest said `pass` and the gate read the check as passing. The
    // test deliberately forges nothing, so it would fail again on a
    // regression.
    let seq = 0;
    for (const draft of run.evidence) {
      storeEvidence(fixture, draft, {
        createdAt: `2026-01-01T00:00:0${seq++}.000Z` as Evidence["createdAt"],
        provenance: [provenanceFor("test/routes/orders.test.js", fixture.head())],
      });
    }
    const stored = fixture.store.evidence.findBy("taskId", TK);
    expect(stored.some((e) => e.exitStatus.kind === "flaky")).toBe(true);

    const gate = runTaskGate(fixture.store, TK, options(fixture));
    expect(gate.result.pass).toBe(false);
    const flakyReason = gate.result.reasons.find((r) => r.reasonCode === "check_flaky");
    expect(flakyReason).toBeDefined();
    // Not collapsed into `fail`: docs/gates.md §4 forbids that.
    expect(flakyReason?.detail).toContain('"flaky"');
    expect(gate.result.checkStates.find((c) => c.checkId === "chk-flaky")?.state).toBe("flaky");
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  }, 40_000);

  it("a later passing run does not launder an earlier flaky reconciliation at the same revision", async () => {
    const fixture = createFixture({ checks: [CHK1] });
    open.push(fixture);
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch",
    );
    claimAttempt(fixture);
    // First: a genuine pass row. Then the reconciled `flaky` row, later.
    await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });
    storeEvidence(
      fixture,
      {
        workflowId: WF,
        taskId: TK,
        taskRevision: 1,
        attemptId: null,
        requirementId: "ac1",
        checkId: CHK1.id,
        artifact: null,
        revision: fixture.head(),
        commandIdentity: { command: CHK1.command, cwd: CHK1.cwd, environmentHash: "b".repeat(64) },
        exitStatus: { kind: "flaky", runs: [0, 1] },
        reviewer: { kind: "deterministic" },
        caveats: ["runs at this revision disagreed"],
        provenance: [provenanceFor("test/routes/orders.test.js", fixture.head())],
        supersedesId: null,
      },
      { createdAt: "2026-01-01T00:00:09.000Z" },
    );

    const summary = taskCheckSummary(
      fixture.store.tasks.require(TK),
      fixture.store.evidence.findBy("taskId", TK),
      fixture.head(),
    );
    expect(summary.checks.find((c) => c.checkId === CHK1.id)?.status).toBe("flaky");
    const gate = runTaskGate(fixture.store, TK, options(fixture));
    expect(gate.result.pass).toBe(false);
    expect(gate.result.reasons.map((r) => r.reasonCode)).toContain("check_flaky");
  }, 30_000);
});

describe("AC4 evidence from an older revision cannot be offered as current", () => {
  it("evidence at commit A is not fresh at commit B: the gate says check_missing and names the staleness", async () => {
    const fixture = createFixture({ checks: [CHK1] });
    open.push(fixture);
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch at A",
    );
    claimAttempt(fixture);
    const atA = await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });
    const shaA = fixture.head();
    expect(atA.evidence?.revision).toBe(shaA);

    // Somebody commits again. The evidence is now about a different tree.
    const shaB = commitFiles(fixture, { "src/routes/orders.js": "module.exports = { createOrder: () => ({ status: 500 }) };\n" }, "commit B");
    expect(shaB).not.toBe(shaA);

    const gate = runTaskGate(fixture.store, TK, options(fixture));
    expect(gate.result.pass).toBe(false);
    const reason = gate.result.reasons.find((r) => r.reasonCode === "check_missing");
    expect(reason?.detail).toContain("evidence_stale_revision");
    expect(freshEvidence(gateInput(fixture, { policy: policyNone(fixture) }), shaB)).toEqual([]);
  }, 30_000);

  it("rewriting the row to claim the new revision does not help: the row is append-only", async () => {
    const fixture = createFixture({ checks: [CHK1] });
    open.push(fixture);
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch at A",
    );
    claimAttempt(fixture);
    const { evidence } = await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });
    const shaB = commitFiles(fixture, { "README.md": "changed\n" }, "commit B");

    // Attack 1: patch the stored row so its `revision` reads as the new head.
    // The evidence repository is append-only and exposes no `update` at all.
    const repo = fixture.store.evidence as unknown as { update?: (id: string, patch: unknown) => unknown };
    expect(typeof repo.update).toBe("undefined");
    // Re-inserting the same id is refused outright.
    expect(() => storeEvidence(fixture, { ...(evidence as Evidence), revision: shaB } as never, { id: (evidence as Evidence).id })).toThrow();

    // Attack 2: insert a *new* row at the new revision without running
    // anything. The command identity is copied from the old row, so nothing
    // ran at B.
    const forged = storeEvidence(fixture, {
      ...(evidence as Evidence),
      revision: shaB,
    } as never);
    expect(forged.revision).toBe(shaB);
    // It IS accepted as fresh — a row is a row. What stops the lie is that
    // producing it requires writing to the store as the engine, which a worker
    // cannot do (records.md §4) and which leaves an audit entry naming the
    // actor. The suite asserts the audit trail rather than pretending the
    // append was refused.
    const audits = fixture.store.audit.findBy("recordId", forged.id);
    expect(audits.length).toBe(1);
    expect(audits[0]?.operation).toBe("insert");
  }, 30_000);

  it("a relevant change invalidates prior evidence conservatively, including an unknown change set", async () => {
    const fixture = createFixture({ checks: [CHK1] });
    open.push(fixture);
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch at A",
    );
    claimAttempt(fixture);
    await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });
    const shaA = fixture.head();
    const shaB = commitFiles(fixture, { "src/routes/orders.js": ROUTE_WITH_VALIDATION + "\n// touched\n" }, "commit B");
    expect(shaB).not.toBe(shaA);

    const task = fixture.store.tasks.require(TK);
    const evidence = fixture.store.evidence.findBy("taskId", TK);
    const known = assessStaleness(task, evidence, shaA, { kind: "paths", paths: ["src/routes/orders.js"] });
    expect(known.stale).toBe(true);

    // An unknown change set is treated as relevant: "we do not know" is never
    // permission to keep the evidence (#50).
    const unknown = assessStaleness(task, evidence, shaA, { kind: "unknown", reason: "git status unavailable" });
    expect(unknown.stale).toBe(true);

    const invalidated = invalidateStaleEvidence({
      store: fixture.store,
      taskId: TK,
      oldRevision: shaA,
      newRevision: shaB,
      changes: { kind: "unknown", reason: "git status unavailable" },
      actor: { kind: "engine", identity: "engine" },
      now: () => AT,
      newId: () => fixture.nextId("e"),
    });
    expect(invalidated.assessment.invalidated.map((c) => c.checkId)).toContain(CHK1.id);
    // The task went back to verification, and the rows were retained, not
    // deleted: a stale row is history, not a lie to be erased.
    expect(invalidated.transition?.subject.status).toBe("verifying");
    expect(fixture.store.evidence.findBy("taskId", TK).length).toBe(evidence.length);
  }, 30_000);

  it("missing evidence is its own state: no row at all is check_missing, never a pass", async () => {
    const fixture = createFixture({ checks: [CHK1, CHK2] });
    open.push(fixture);
    commitFiles(
      fixture,
      { "src/routes/orders.js": ROUTE_WITH_VALIDATION, "test/routes/orders.test.js": TEST_EXERCISES_CRITERION },
      "patch",
    );
    claimAttempt(fixture);
    // Only chk1 is actually run. chk2 has no evidence at all.
    await runAndStore(fixture, CHK1, { paths: ["test/routes/orders.test.js"] });

    const ctx = { policy: policyNone(fixture) };
    recordC2(fixture, { ...(await evaluateMappingOnly(mappingInput())), confidence: 0.95 }, ctx);

    const outcome = completeTask(fixture.store, TK, {
      ...options(fixture),
      actor: { kind: "engine", identity: "engine" },
      evidenceRefs: ["ev:checks"],
    });
    expect(outcome.result.pass).toBe(false);
    const missing = outcome.result.reasons.find((r) => r.reasonCode === "check_missing");
    expect(missing?.detail).toContain(CHK2.id);
    expect(fixture.store.tasks.require(TK).status).toBe("review");
  }, 30_000);
});

/** Evaluator input for a single passing check covering ac1. */
function mappingInput() {
  return {
    taskId: TK as string,
    taskGoal: "Reject POST /orders with an empty items array",
    riskClass: "low" as const,
    acceptanceCriteria: [{ id: "ac1", text: "empty items => 400 empty_order" }],
    checks: [{ checkId: "chk1", command: CHK1.command, state: "pass", coversCriteria: ["ac1"] }],
    tests: [],
    evidence: [
      {
        requirementId: "ac1",
        checkId: "chk1",
        command: CHK1.command,
        state: "pass",
        paths: ["test/routes/orders.test.js"],
        excerpt: "2 passing",
      },
    ],
    claim: "done",
  };
}
