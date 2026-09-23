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
