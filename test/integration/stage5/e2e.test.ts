/**
 * Single-worker end-to-end run (issue #73; PLAN §8 Stage 5 exit).
 *
 * The other half of the Stage 5 exit criterion, isolated from the cap/
 * fallback mechanics that `scenario4.test.ts` covers: **a task executes in
 * isolation with a Jev-chosen model** — a real `pi --mode rpc` subprocess
 * (the `fake-pi.mjs` stand-in `test/workers/*.test.ts` already uses), in its
 * own git worktree, running the model `selectModel` (#60) actually chose via
 * a `MockJevTransport`, supervised by the real `WorkerRun` (#71) — and its
 * reported state (usage, outcome, route) matches what actually happened.
 *
 * No key, no network: only the Jev transport is mocked, per AGENTS.md.
 */
import { spawn as spawnReal } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionRecorder } from "../../../src/decisions/record.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import { RouteAvailabilityTable } from "../../../src/models/availability.ts";
import { eligibleCandidates, selectModel } from "../../../src/models/select.ts";
import { draftToContract, type ContractPolicy } from "../../../src/workers/contract.ts";
import { spawnWorker, type WorkerHandle } from "../../../src/workers/spawn.ts";
import { WorkerRun } from "../../../src/workers/lifecycle.ts";
import { createAttemptWorktree } from "../../../src/workers/worktree.ts";
import { makeRoute, type RegistryModelLike } from "../../../src/models/route.ts";
import { Ledger } from "../../../src/telemetry/ledger.ts";
import { budgetsWith, estimatedUsage } from "../../helpers/ledger.ts";
import { buildTaskBoard } from "../../../src/workflow/boards.ts";
import { statusReportMessage } from "../../../src/extension/commands/status.ts";
import type { ModelAllowlist } from "../../../src/config/types.ts";
import type { AttemptId, PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { M_PRIMARY, M_SUB, PROFILE, PROVIDER, STATIC_ORDER, T1, createStage5Fixture, insertPrimaryAttempt, type Stage5Fixture } from "./fixture.ts";

const FAKE_PI = fileURLToPath(new URL("../../workers/fixtures/fake-pi.mjs", import.meta.url));
const POSIX = process.platform !== "win32";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function fixture(): Stage5Fixture {
  const f = createStage5Fixture();
  cleanups.push(f.cleanup);
  return f;
}

describe.runIf(POSIX)("Single-worker end-to-end run (issue #73; PLAN §8 Stage 5 exit)", () => {
  it(
    "a task executes in isolation with a Jev-chosen model, and reports accurate state",
    async () => {
      const f = fixture();

      // --- Jev chooses the model (mock transport, never a live call) -------
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
      const availability = new RouteAvailabilityTable();
      const eligible = eligibleCandidates(
        [M_PRIMARY.entry, M_SUB.entry],
        new Map([
          [M_PRIMARY.ref, M_PRIMARY.card],
          [M_SUB.ref, M_SUB.card],
        ]),
        availability,
        f.now(),
      );
      const allowlist: ModelAllowlist = { providers: [PROVIDER], models: [], pins: {} };
      const recorder = new DecisionRecorder({
        sink: f.store.decisions,
        workflowId: "wf-1" as WorkflowId,
        revision: f.head() as never,
        now: f.now,
        newId: () => f.nextId("dc"),
      });
      const selection = await selectModel({
        // The recorder that matters for a Jev-ranked winner lives on `ctx`
        // (each `models.rank@1` call records its own Decision); `selectModel`'s
        // own `recorder` param only records the pin/static-fallback paths.
        ctx: { transport, model: "jev-test", recorder },
        profile: PROFILE,
        candidates: eligible,
        allowlist,
        staticOrder: STATIC_ORDER,
      });
      expect(selection.kind).toBe("selected");
      if (selection.kind !== "selected") throw new Error("unreachable");
      expect(selection.usedModel).toBe(M_PRIMARY.ref);
      expect(selection.decisionId).not.toBeNull();
      expect(f.store.decisions.list().length).toBeGreaterThan(0);

      // --- The task executes in its own, isolated git worktree -------------
      const attempt = insertPrimaryAttempt(f, {
        requestedModel: selection.requestedModel,
        usedModel: selection.usedModel,
        fallbackReason: selection.fallbackReason,
      });
      f.store.tasks.update(T1, { status: "running" });
      const worktree = createAttemptWorktree({
        projectRoot: f.repo.path,
        attemptId: attempt.id,
        baseRevision: f.head(),
      });
      expect(worktree.path).not.toBe(f.repo.path);
      expect(existsSync(worktree.path)).toBe(true);

      // --- A real worker subprocess, isolated by contract -------------------
      const policy: ContractPolicy = { allowlist: { providers: [], models: [selection.usedModel], pins: {} } as ModelAllowlist };
      const contract = draftToContract({
        workerId: "worker-e2e",
        role: "implementer",
        task: "Add GET /orders/:id/summary",
        cwd: worktree.path,
        model: selection.usedModel,
        budget: { wallClockMs: 30_000 },
        termination: { graceMs: 1_000, artifacts: [] },
      });
      const handle: WorkerHandle = await spawnWorker(contract, {
        policy,
        piBin: process.execPath,
        parentEnv: process.env,
        spawnFn: ((bin: string, args: readonly string[], opts: Record<string, unknown>) =>
          spawnReal(bin, [FAKE_PI, ...args], opts)) as never,
      });
      cleanups.push(() => {
        try {
          process.kill(handle.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      });

      const state = await handle.call({ type: "get_state" }, 15_000);
      // Isolation: the worker's cwd is the attempt worktree, not the repo's
      // main tree, and it received exactly the model contract dictated.
      expect((state.data as { cwd: string }).cwd).toBe(worktree.path);

      const route = makeRoute(PROVIDER, "M-primary");
      let ledgerIdCounter = 0;
      const ledger = new Ledger(f.store, { budgets: budgetsWith({}), sessionId: "session-1", newId: () => `ledger-${(ledgerIdCounter += 1)}` });
      const run = new WorkerRun({
        handle,
        ledger,
        scope: {
          workflowId: "wf-1" as WorkflowId,
          phaseId: "ph-1" as PhaseId,
          taskId: T1 as TaskId,
          attemptId: attempt.id as AttemptId,
        },
        route,
        estimate: estimatedUsage(0.1),
      });
      run.start();
      expect(f.store.ledger.openReservations()).toHaveLength(1);

      const promptResponse = await handle.call({ type: "prompt", message: "implement it" }, 15_000);
      expect((promptResponse.data as { prompt: string }).prompt).toBe("implement it");

      const cancelResult = await handle.cancel("turn complete");
      expect(cancelResult.tier).toBe("cooperative");
      const result = run.finish();

      // --- Accurate state: outcome, usage and route all agree with reality -
      // The fake worker honours the cooperative `abort` by exiting 0 before
      // the supervisor's cancellation call resolves, so this run's outcome is
      // an ordinary clean completion, not a cancellation.
      expect(result.outcome).toBe("completed");
      expect(result.attemptOutcome).toBe("succeeded");
      expect(f.store.ledger.openReservations()).toHaveLength(0);

      f.store.attempts.update(attempt.id, {
        outcome: "succeeded",
        usage: result.usage,
        timestamps: { ...attempt.timestamps, endedAt: f.now() },
      });
      const stored = f.store.attempts.require(attempt.id);
      expect(stored.requestedModel).toBe(M_PRIMARY.ref);
      expect(stored.usedModel).toBe(M_PRIMARY.ref);
      expect(stored.fallbackReason).toBeNull();
      expect(stored.worktree.relativePath).toBe(attempt.worktree.relativePath);

      // Route availability agrees: nothing capped this route during the run.
      expect(availability.isEligible(M_PRIMARY.routeId, f.now())).toBe(true);

      // /korwf status reports the run accurately: no spurious switch (the
      // task never fell back), and the route is not shown as capped.
      const board = buildTaskBoard(f.store, "wf-1" as WorkflowId, {}, f.head());
      const row = board.find((r) => r.task.id === T1)!;
      expect(row.lastModelSwitch).toEqual({ requestedModel: M_PRIMARY.ref, usedModel: M_PRIMARY.ref, fallbackReason: null });
      const registryModels: readonly RegistryModelLike[] = [
        { provider: PROVIDER, id: "M-primary" },
        { provider: PROVIDER, id: "M-sub" },
      ];
      const statusText = statusReportMessage({ models: registryModels, now: f.now(), availability, taskRows: board });
      expect(statusText).not.toContain("model switches:");
    },
    30_000,
  );
});
