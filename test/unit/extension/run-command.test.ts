/**
 * `/korwf run <phase-id | all>` (issue #74).
 *
 * AC1 "Unapproved phase → refused with reason", AC2 "Estimate over cap →
 * refused unless approved", AC3 "Estimate output distinguishes
 * known/estimated/unknown" — plus the two absolute rules: the estimate is
 * shown before `confirm` is even called, and a decline starts nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { ApprovalId, PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import {
  runCommand,
  parseRunArgs,
  resolveRunTargets,
  planApproved,
} from "../../../src/extension/commands/run.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const e = open.pop();
    e?.store.close();
    e?.dir.cleanup();
  }
});

function freshStore(status: "planning" | "ready" = "ready"): Store {
  const dir = makeTempDir("korwf-run-cmd-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }));
  store.tasks.insert(makeTask({ id: "t1" as TaskId, workflowId: WF, phaseId: PH, status: "ready" }));
  return store;
}

const newId = () => `id-${(counter += 1)}`;

describe("parseRunArgs", () => {
  it("requires a target", () => {
    expect(parseRunArgs([]).ok).toBe(false);
  });
  it("accepts a phase id or `all`", () => {
    expect(parseRunArgs(["all"])).toEqual({ ok: true, target: "all", message: null });
    expect(parseRunArgs(["ph-1"])).toEqual({ ok: true, target: "ph-1", message: null });
  });
});

describe("resolveRunTargets", () => {
  it("resolves `all` to every non-terminal phase", () => {
    const store = freshStore();
    const result = resolveRunTargets(store, WF, "all");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phaseIds).toEqual([PH]);
  });
  it("refuses an unknown phase id", () => {
    const store = freshStore();
    const result = resolveRunTargets(store, WF, "no-such-phase");
    expect(result.ok).toBe(false);
  });
});

describe("AC1: unapproved phase refused with reason", () => {
  it("a workflow still in planning with no plan approval refuses", () => {
    const store = freshStore("planning");
    expect(planApproved(store, WF, AT)).toBe(false);
  });
  it("a granted plan approval at the current revision satisfies it", () => {
    const store = freshStore("planning");
    store.approvals.insert(
      makeApproval({
        id: "ap-1" as ApprovalId,
        workflowId: WF,
        scope: { kind: "plan" },
        taskRevision: null,
        planRevision: 1,
        permittedAction: "approve_plan",
      }),
    );
    expect(planApproved(store, WF, AT)).toBe(true);
  });
  it("runCommand refuses with a reason and never calls confirm", async () => {
    const store = freshStore("planning");
    let confirmCalled = false;
    const outcome = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => {
        confirmCalled = true;
        return true;
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/not approved/i);
    expect(confirmCalled).toBe(false);
    expect(store.phases.require(PH).gateStatus).toBe("pending");
  });
});

describe("the estimate is shown BEFORE work begins", () => {
  it("confirm receives the estimate text, and nothing starts until it answers", async () => {
    const store = freshStore("ready");
    let confirmBody = "";
    let phaseStatusWhenAsked: string | null = null;
    await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: (_title, body) => {
        confirmBody = body;
        phaseStatusWhenAsked = store.phases.require(PH).gateStatus;
        return true;
      },
    });
    expect(confirmBody).toMatch(/Cost estimate/);
    expect(phaseStatusWhenAsked).toBe("pending");
    expect(store.phases.require(PH).gateStatus).toBe("running");
  });

  it("declining starts nothing (a decline that spent something is worthless as a decline)", async () => {
    const store = freshStore("ready");
    const outcome = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => false,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/Declined/);
    expect(store.phases.require(PH).gateStatus).toBe("pending");
  });

  it("a confirm that throws is treated as a decline, not a hang or a grant", async () => {
    const store = freshStore("ready");
    const outcome = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => {
        throw new Error("dialog closed");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(store.phases.require(PH).gateStatus).toBe("pending");
  });
});

describe("AC2: estimate over cap refused unless approved", () => {
  it("refuses when the estimate exceeds the workflow's budget cap", async () => {
    const store = freshStore("ready");
    let confirmCalled = false;
    const outcome = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => {
        confirmCalled = true;
        return true;
      },
      maxSpendUsd: 1,
      tokensForTask: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      priceForTask: () => ({ inputPerToken: 0.00001, outputPerToken: 0.00001 }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/exceeds the/i);
    expect(confirmCalled).toBe(false);
    expect(store.phases.require(PH).gateStatus).toBe("pending");
  });

  it("a granted spend_over_estimate approval overrides the refusal", async () => {
    const store = freshStore("ready");
    store.approvals.insert(
      makeApproval({
        id: "ap-spend" as ApprovalId,
        workflowId: WF,
        scope: { kind: "workflow" },
        taskRevision: null,
        planRevision: 1,
        permittedAction: "spend_over_estimate",
      }),
    );
    const outcome = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => true,
      maxSpendUsd: 1,
      tokensForTask: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      priceForTask: () => ({ inputPerToken: 0.00001, outputPerToken: 0.00001 }),
    });
    expect(outcome.ok).toBe(true);
    expect(store.phases.require(PH).gateStatus).toBe("running");
  });
});

describe("the run id is printed, so the user can refer to the run afterwards", () => {
  it("a started run prints its id in the message and returns it", async () => {
    const store = freshStore("ready");
    const outcome = await runCommand({
      store,
      workflowId: WF,
      target: "all",
      now: () => AT,
      newId,
      confirm: () => true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.runId).toBeTruthy();
    expect(outcome.message).toContain(`Run id: ${outcome.runId}`);
    expect(store.runs.get(outcome.runId as string)?.runId).toBe(outcome.runId);
    expect(store.phases.require(PH).runId).toBe(outcome.runId);
  });

  it("a refused/declined run never reports a run id", async () => {
    const declined = await runCommand({ store: freshStore("ready"), workflowId: WF, target: "all", now: () => AT, newId, confirm: () => false });
    expect(declined.runId).toBeNull();

    const unapproved = await runCommand({ store: freshStore("planning"), workflowId: WF, target: "all", now: () => AT, newId, confirm: () => true });
    expect(unapproved.runId).toBeNull();
  });
});
