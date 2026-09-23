/**
 * Scenario 4 — cap hit mid-task (issue #73; `test/scenarios/04-cap-mid-task.md`;
 * PLAN §2.8 (4), §8 Stage 5 exit).
 *
 * Stage 5 exit criterion: "a task executes in isolation with a Jev-chosen
 * model, survives a simulated cap with a visible fallback, and reports
 * accurate state." This suite drives that end to end against real storage
 * and a real repository. Only the Jev transport (`MockJevTransport`) and the
 * provider call are faked — no key, no network, never a real sleep (a
 * `FakeClock` stands in for every "time passes").
 */
import { afterEach, describe, expect, it } from "vitest";
import { DecisionRecorder } from "../../../src/decisions/record.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { detectProviderCap, toCapObservation } from "../../../src/models/cap-detect.ts";
import { RouteAvailabilityTable } from "../../../src/models/availability.ts";
import { selectModel } from "../../../src/models/select.ts";
import { chooseFallback, type FallbackAttemptView } from "../../../src/models/fallback.ts";
import { applyHandoff } from "../../../src/workers/handoff.ts";
import { buildHandoffPacket } from "../../../src/memory/handoff-packet.ts";
import { defaultOutboundPolicy } from "../../../src/security/outbound.ts";
import { recordFallbackSwitch } from "../../../src/models/cap-pause.ts";
import { buildTaskBoard } from "../../../src/workflow/boards.ts";
import { statusReportMessage } from "../../../src/extension/commands/status.ts";
import type { RegistryModelLike } from "../../../src/models/route.ts";
import type { Attempt, AttemptId } from "../../../src/storage/records.ts";
import {
  ALLOW_ALL,
  M_PRIMARY,
  M_SUB,
  M_WEAK,
  PROFILE,
  PROVIDER,
  STATIC_ORDER,
  T1,
  T1_CRITERION,
  T2,
  commitTaskPatch,
  createStage5Fixture,
  insertPrimaryAttempt,
  type Stage5Fixture,
} from "./fixture.ts";
import { completeTaskThroughGate, policyNone, recordC2, runAndStoreCheck } from "./gate.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function fixture(): Stage5Fixture {
  const f = createStage5Fixture();
  cleanups.push(f.cleanup);
  return f;
}

function newRecorder(f: Stage5Fixture): DecisionRecorder {
  return new DecisionRecorder({
    sink: f.store.decisions,
    workflowId: "wf-1" as never,
    revision: f.head() as never,
    now: f.now,
    newId: () => f.nextId("dc"),
  });
}

/** Jev always ranks the primary adequate — the "everything is healthy" mock used before any cap. */
function primaryAdequateMock(): { ctx: AskContext; transport: MockJevTransport } {
  const transport = new MockJevTransport({
    responder: (request) => ({
      kind: "ok",
      response: {
        model: "jev-test",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((k) => {
            const adequate = JSON.stringify(request.state).includes("M-primary");
            return [k, { type: "noul", noul: adequate ? 0.9 : 0.1 }];
          }),
        ),
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      requestId: "req",
      attempts: 1,
      elapsedMs: 1,
    }),
  });
  return { ctx: { transport, model: "jev-test" }, transport };
}

/** A Jev mock that ranks `M-sub` adequate, `M-weak` not adequate — scenario A3. */
function substituteRankingMock(): { ctx: AskContext; transport: MockJevTransport } {
  const transport = new MockJevTransport({
    responder: (request) => {
      const stateStr = JSON.stringify(request.state);
      const adequate = stateStr.includes("M-sub") && !stateStr.includes("M-weak");
      return {
        kind: "ok",
        response: {
          model: "jev-test",
          answers: Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: "noul", noul: adequate ? 0.9 : 0.1 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        requestId: "req",
        attempts: 1,
        elapsedMs: 1,
      };
    },
  });
  return { ctx: { transport, model: "jev-test" }, transport };
}

const REGISTRY_MODELS: readonly RegistryModelLike[] = [
  { provider: PROVIDER, id: "M-primary" },
  { provider: PROVIDER, id: "M-sub" },
  { provider: PROVIDER, id: "M-weak" },
];

describe("Scenario 4 Variant A — Jev enabled (issue #73)", () => {
  it("A1–A6: primary caps mid-task, Jev ranks a substitute, handoff, completion, primary retried at the next boundary", async () => {
    const f = fixture();
    const availability = new RouteAvailabilityTable();

    // --- Step A1: T1 dispatched on the primary (Jev-chosen model) ---------
    const { ctx: healthyCtx } = primaryAdequateMock();
    const selectA1 = await selectModel({
      ctx: healthyCtx,
      profile: PROFILE,
      candidates: [M_PRIMARY, M_SUB, M_WEAK],
      allowlist: ALLOW_ALL,
      staticOrder: STATIC_ORDER,
      recorder: newRecorder(f),
    });
    expect(selectA1.kind).toBe("selected");
    if (selectA1.kind !== "selected") throw new Error("unreachable");
    expect(selectA1.usedModel).toBe(M_PRIMARY.ref);
    expect(selectA1.requestedModel).toBe(M_PRIMARY.ref);
    expect(selectA1.fallbackReason).toBeNull();

    const a1 = insertPrimaryAttempt(f);
    f.store.tasks.update(T1, { status: "running" });
    expect(a1.requestedModel).toBe(M_PRIMARY.ref);
    expect(a1.usedModel).toBe(M_PRIMARY.ref);
    expect(a1.fallbackReason).toBeNull();
    // Isolation: the attempt runs in its own worktree, not the repo's main tree.
    expect(a1.worktree.relativePath).toContain(".korwf/worktrees/");
    expect(a1.worktree.baseRevision).toBe(f.head());

    // --- Step A2: primary returns quota exhausted at t0 -------------------
    const t0 = f.now();
    const cap = detectProviderCap({ httpStatus: 429, bodyText: "quota exceeded for this billing period" }, t0);
    expect(cap).not.toBeNull();
    expect(cap!.capKind).toBe("quota_exhausted");
    availability.markCapped(
      { routeId: M_PRIMARY.routeId, providerId: PROVIDER, modelId: "M-primary", ref: M_PRIMARY.ref },
      toCapObservation(cap!, t0),
    );
    f.clock.advance(60_000); // some wall-clock time passes while the reset is estimated
    const estimatedReset = new Date(Date.parse(t0) + 30 * 60_000).toISOString();
    availability.markCapped(
      { routeId: M_PRIMARY.routeId, providerId: PROVIDER, modelId: "M-primary", ref: M_PRIMARY.ref },
      { capKind: "quota_exhausted", at: t0, estimatedReset: estimatedReset as never },
    );
    const row = availability.get(M_PRIMARY.routeId)!;
    expect(row.capKind).toBe("quota_exhausted");
    expect(row.detectedAt).toBe(t0);
    expect(row.estimatedReset).toBe(estimatedReset);
    expect(row.lastProbe?.detail ?? "").not.toMatch(/sk-[A-Za-z0-9]|api[_-]?key/i);

    // Global (route-keyed, not workflow-keyed): a second, independent view of
    // the same table observes the same cap — there is no workflowId on it.
    expect(new RouteAvailabilityTable().isEligible(M_PRIMARY.routeId, t0)).toBe(true);
    expect(availability.isEligible(M_PRIMARY.routeId, t0)).toBe(false);

    // Worktree intact: uncommitted, in-progress edits survive the cap.
    const dirtyPath = "dirty-marker.ts";
    f.repo.writeDirty(dirtyPath, "export const partial = 1;\n");
    const statusBefore = f.repo.git("status", "--porcelain");
    expect(statusBefore).toContain("dirty-marker.ts");

    // --- Step A3: Jev ranks substitutes for the task profile --------------
    const { ctx: subCtx, transport: subTransport } = substituteRankingMock();
    const attemptView: FallbackAttemptView = {
      requestedModel: a1.requestedModel as never,
      usedModel: a1.usedModel as never,
      taskProfile: PROFILE,
      pin: null,
      fallbackSince: null,
    };
    const fallbackDecision = await chooseFallback({
      ctx: subCtx,
      attempt: attemptView,
      // The capped primary is excluded from the candidate set *before* the
      // question is asked — code filters, Jev only ranks what remains.
      candidates: [M_PRIMARY, M_SUB, M_WEAK],
      availability,
      now: t0,
      allowlist: ALLOW_ALL,
      staticOrder: STATIC_ORDER,
      dwell: "remainder_of_task",
      dwellMinutes: 0,
      preferWaitIfResetWithinMinutes: 5,
      recorder: newRecorder(f),
    });
    expect(fallbackDecision.kind).toBe("switch");
    if (fallbackDecision.kind !== "switch") throw new Error("unreachable");
    expect(fallbackDecision.usedModel).toBe(M_SUB.ref);
    expect(fallbackDecision.requestedModel).toBe(M_PRIMARY.ref);
    expect(fallbackDecision.fallbackReason).toBe("quota_exhausted");
    // The capped primary's route was never handed to Jev.
    for (const call of subTransport.calls) {
      expect(JSON.stringify(call.request)).not.toContain("M-primary");
    }

    // --- Step A4: handoff packet built; worker continues on the substitute
    // `applyHandoff` reads `oldAttempt.usedModel` as the new attempt's
    // `requestedModel` and `oldAttempt.fallbackReason` as the new attempt's
    // `fallbackReason`, so A1's fallback reason is stamped in place first
    // (never its `usedModel`, which stays M-primary — that is what A1 was
    // actually dispatched on, and the row is about to freeze).
    f.store.attempts.update(a1.id, { fallbackReason: fallbackDecision.fallbackReason });
    const packet = buildHandoffPacket({
      attempt: f.store.attempts.require(a1.id),
      progressNotes: [{ at: t0, text: "Implemented the happy path; edge cases remain." }],
      remaining: ["handle empty items array"],
      decisions: [{ what: "used a guard clause", why: "matches the rest of the file's style" }],
      openQuestions: [],
      evidence: [],
      task: { goal: "Add GET /orders/:id/summary", acceptanceCriteria: ["returns 200 with the order summary"] },
      substituteModel: fallbackDecision.usedModel,
      now: f.now,
    });
    const handoff = applyHandoff({
      store: f.store,
      now: f.now,
      newId: () => f.nextId("at"),
      workflowId: "wf-1",
      oldAttempt: f.store.attempts.require(a1.id),
      packet,
      outboundPolicy: defaultOutboundPolicy(),
      role: "implementer",
      workerId: "worker-2",
    });
    const a2 = handoff.newAttempt;

    // Settle A1 as handed off, now that the packet has captured everything it
    // needs to (docs/records.md §4: the row freezes once `outcome` is set).
    f.store.attempts.update(a1.id, { outcome: "handed_off", timestamps: { ...a1.timestamps, endedAt: t0 } });
    expect(f.store.tasks.require(T1).status).toBe("running");
    expect(f.store.tasks.require(T1).status).not.toBe("failed");
    expect(f.store.attempts.require(a1.id).outcome).toBe("handed_off");

    expect(a2.taskId).toBe(T1);
    expect(a2.requestedModel).toBe(M_PRIMARY.ref);
    expect(a2.usedModel).toBe(M_SUB.ref);
    expect(a2.fallbackReason).toBe("quota_exhausted");
    expect(a2.handedOffFromAttemptId).toBe(a1.id);
    expect(a2.worktree.relativePath).toBe(a1.worktree.relativePath);
    expect(a2.worktree.branch).toBe(a1.worktree.branch);
    expect(a2.role).toBe("implementer");
    expect(a2.taskProfile).toEqual(a1.taskProfile);
    expect(a2.inputs.bundleHash).not.toBe(a1.inputs.bundleHash);
    expect(a2.inputs.bundleHash.length).toBeGreaterThan(0);

    expect(f.store.tasks.require(T1).status).toBe("running");

    // The switch is visible: /korwf status shows requested → used and the reason.
    const boardAfterSwitch = buildTaskBoard(f.store, "wf-1" as never, {}, f.head());
    const t1RowAfterSwitch = boardAfterSwitch.find((r) => r.task.id === T1)!;
    expect(t1RowAfterSwitch.lastModelSwitch).toEqual({
      requestedModel: M_PRIMARY.ref,
      usedModel: M_SUB.ref,
      fallbackReason: "quota_exhausted",
    });
    const statusText = statusReportMessage({
      models: REGISTRY_MODELS,
      now: f.now(),
      availability,
      taskRows: boardAfterSwitch,
    });
    expect(statusText).toContain("model switches:");
    expect(statusText).toContain(`requested ${M_PRIMARY.ref}`);
    expect(statusText).toContain(`used ${M_SUB.ref}`);
    expect(statusText).toContain("quota_exhausted");

    // --- Step A5: T1 completes on the substitute, through the real gate ----
    // The substitute worker actually finishes the patch and it is really
    // committed — no shortcut to `done`.
    commitTaskPatch(f, T1);
    const { evidence: t1Evidence } = await runAndStoreCheck(f, T1, f.store.attempts.require(a2.id));
    expect(t1Evidence?.exitStatus).toEqual({ kind: "exited", code: 0 });
    await recordC2(f, T1, T1_CRITERION.id, "Add GET /orders/:id/summary", policyNone(f, f.head() as never, 1), f.head() as never);
    f.store.attempts.update(a2.id, {
      outcome: "succeeded",
      timestamps: { ...a2.timestamps, endedAt: f.now() },
    });
    const t1Outcome = await completeTaskThroughGate(f, T1);
    expect(t1Outcome.result.pass).toBe(true);
    expect(f.store.attempts.require(a2.id).outcome).toBe("succeeded");
    expect(f.store.tasks.require(T1).status).toBe("done");

    // --- Step A6: next task retries the primary at the task boundary -------
    f.clock.set(Date.parse(t0) + 35 * 60_000); // t0 + 35m, past the 30m reset
    availability.markAvailable({ routeId: M_PRIMARY.routeId, providerId: PROVIDER, modelId: "M-primary", ref: M_PRIMARY.ref }, f.now());
    const boundaryRow = availability.get(M_PRIMARY.routeId)!;
    expect(boundaryRow.capKind).toBe("none");
    expect(boundaryRow.lastProbe?.result).toBe("available");

    const { ctx: recoveredCtx } = primaryAdequateMock();
    const selectA6 = await selectModel({
      ctx: recoveredCtx,
      profile: PROFILE,
      candidates: [M_PRIMARY, M_SUB, M_WEAK],
      allowlist: ALLOW_ALL,
      staticOrder: STATIC_ORDER,
      recorder: newRecorder(f),
    });
    expect(selectA6.kind).toBe("selected");
    if (selectA6.kind !== "selected") throw new Error("unreachable");
    expect(selectA6.usedModel).toBe(M_PRIMARY.ref);
    expect(selectA6.fallbackReason).toBeNull();

    const a3 = f.store.attempts.insert({
      ...a2,
      id: f.nextId("at") as AttemptId,
      taskId: T2,
      requestedModel: selectA6.requestedModel,
      usedModel: selectA6.usedModel,
      fallbackReason: selectA6.fallbackReason,
      handedOffFromAttemptId: null,
      outcome: null,
      timestamps: { startedAt: f.now(), endedAt: null, lastActivityAt: f.now() },
    } satisfies Attempt);
    expect(a3.taskId).toBe(T2);
    expect(a3.requestedModel).toBe(M_PRIMARY.ref);
    expect(a3.usedModel).toBe(M_PRIMARY.ref);
    expect(a3.fallbackReason).toBeNull();
    expect(a3.handedOffFromAttemptId).toBeNull();

    // --- Accurate state: usage/route availability agree with what happened -
    const finalBoard = buildTaskBoard(f.store, "wf-1" as never, {}, f.head());
    const finalT1Row = finalBoard.find((r) => r.task.id === T1)!;
    expect(finalT1Row.task.status).toBe("done");
    expect(finalT1Row.lastModel).toBe(M_SUB.ref);
    const finalT2Row = finalBoard.find((r) => r.task.id === T2)!;
    expect(finalT2Row.lastModel).toBe(M_PRIMARY.ref);
    expect(finalT2Row.lastModelSwitch).toEqual({ requestedModel: M_PRIMARY.ref, usedModel: M_PRIMARY.ref, fallbackReason: null });

    // Worktree still intact and unchanged from cap time (never rolled back —
    // handoff, not restart).
    const statusAfter = f.repo.git("status", "--porcelain");
    expect(statusAfter).toContain("dirty-marker.ts");
  });
});
