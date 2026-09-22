/**
 * `src/workflow/invalidation.ts` (issue #41): "Task `revision` increments on
 * any change to goal/criteria/checks/ownership; approvals for the old
 * revision are invalidated (Stage 1 rule)", and docs/state-machine.md §5's
 * event → state-effect table applied at runtime.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { ApprovalId, EvidenceId, PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { APPROVAL_INVALIDATION_EVENTS } from "../../../src/workflow/transitions.ts";
import {
  applyInvalidation,
  evidenceForCurrentRevision,
  excludedEvidence,
  invalidationContract,
  reviseTask,
} from "../../../src/workflow/invalidation.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makeEvidence, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-06-01T00:00:00.000Z";
const SHA = "a".repeat(40);
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function freshStore(): Store {
  const dir = makeTempDir("korwf-inval-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  return store;
}

function base(store: Store) {
  return {
    store,
    workflowId: WF,
    actor: { kind: "engine", identity: "engine" } as const,
    now: () => AT,
    newId: () => `id-${(counter += 1)}`,
  };
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("every enumerated invalidation event maps to a state effect", () => {
  // Walks the contract rather than a hand-written list, so a new event added
  // to `transitions.ts` fails here until this module handles it.
  for (const contract of APPROVAL_INVALIDATION_EVENTS) {
    it(`applies "${contract.event}": task ${contract.taskEffect}, phase ${contract.phaseEffect}`, () => {
      const store = freshStore();
      store.tasks.insert(makeTask({ status: "running" }));
      store.approvals.insert(
        makeApproval({
          id: "ap-1" as ApprovalId,
          expiresAt: contract.event === "expired" ? AT : null,
        }),
      );
      const effect = applyInvalidation({
        ...base(store),
        reason: contract.event,
        detail: "test",
        ...(contract.event === "task_revision_changed" ? { taskId: TK } : {}),
      });

      expect(invalidationContract(contract.event)).toBe(contract);
      expect(effect.invalidatedApprovals).toEqual(["ap-1"]);
      expect(store.approvals.require("ap-1").invalidation?.reason).toBe(contract.event);

      if (contract.taskEffect === "blocked") {
        expect(store.tasks.require(TK).status).toBe("blocked");
        expect(effect.blockedTasks).toEqual([TK]);
      } else {
        expect(store.tasks.require(TK).status).toBe("running");
        expect(effect.blockedTasks).toEqual([]);
      }

      const phase = store.phases.require(PH);
      if (contract.phaseEffect === "paused" || contract.phaseEffect === "by_approval_class") {
        // `by_approval_class` defaults to stop_phase, the restrictive choice.
        expect(phase.gateStatus).toBe("paused_approval");
        expect(effect.pausedPhases).toEqual([PH]);
      } else {
        expect(phase.gateStatus).toBe("running");
        expect(effect.pausedPhases).toEqual([]);
      }
    });
  }

  it("rejects an unknown invalidation reason rather than ignoring it", () => {
    // @ts-expect-error deliberately outside the union
    expect(() => invalidationContract("made_up")).toThrow(/no invalidation contract/);
  });
});

describe("by_approval_class: queue-and-continue versus stop-the-phase", () => {
  it("queue-and-continue blocks the task and leaves the phase running", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "running" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    const effect = applyInvalidation({
      ...base(store),
      reason: "revoked",
      detail: "user withdrew",
      phaseDisposition: "queue_and_continue",
    });
    expect(effect.blockedTasks).toEqual([TK]);
    expect(effect.pausedPhases).toEqual([]);
    expect(store.phases.require(PH).gateStatus).toBe("running");
  });

  it("stop-the-phase pauses it as paused_approval", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "running" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    applyInvalidation({
      ...base(store),
      reason: "revoked",
      detail: "user withdrew",
      phaseDisposition: "stop_phase",
    });
    expect(store.phases.require(PH).gateStatus).toBe("paused_approval");
  });

  it("consumed changes no state: the receipt stands", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "running" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    const effect = applyInvalidation({ ...base(store), reason: "consumed", detail: "action performed" });
    expect(effect.blockedTasks).toEqual([]);
    expect(effect.pausedPhases).toEqual([]);
    expect(store.tasks.require(TK).status).toBe("running");
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("consumed");
  });

  it("a terminal task is left alone but its approval is still invalidated", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "done" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    const effect = applyInvalidation({
      ...base(store),
      reason: "task_revision_changed",
      detail: "content changed",
      taskId: TK,
    });
    expect(store.tasks.require(TK).status).toBe("done");
    expect(effect.unchangedTerminal).toEqual([TK]);
    expect(store.approvals.require("ap-1").invalidation).not.toBeNull();
  });

  it("an unrelated task keeps its state on a task-scoped event", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "running" }));
    store.tasks.insert(makeTask({ id: "tk-2" as TaskId, status: "running" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    applyInvalidation({ ...base(store), reason: "task_revision_changed", detail: "x", taskId: TK });
    expect(store.tasks.require(TK).status).toBe("blocked");
    expect(store.tasks.require("tk-2").status).toBe("running");
  });

  it("an already blocked task accumulates the reason and stays blocked", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "blocked", blocker: "dependency" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    applyInvalidation({ ...base(store), reason: "mode_changed", detail: "supervised -> advisory" });
    expect(store.tasks.require(TK).status).toBe("blocked");
    expect(store.blockers.unresolvedForSubject("task", TK).map((b) => b.kind)).toContain("approval_invalidated");
  });

  it("an already invalidated approval is not re-invalidated", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "running" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId }));
    applyInvalidation({ ...base(store), reason: "revoked", detail: "first" });
    const second = applyInvalidation({ ...base(store), reason: "mode_changed", detail: "second" });
    expect(second.invalidatedApprovals).toEqual([]);
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("revoked");
  });

  it("expired only touches approvals whose expiry has passed", () => {
    const store = freshStore();
    store.tasks.insert(makeTask({ status: "running" }));
    store.approvals.insert(makeApproval({ id: "ap-1" as ApprovalId, expiresAt: AT }));
    store.approvals.insert(makeApproval({ id: "ap-2" as ApprovalId, expiresAt: LATER }));
    const effect = applyInvalidation({ ...base(store), reason: "expired", detail: "timer" });
    expect(effect.invalidatedApprovals).toEqual(["ap-1"]);
    expect(store.approvals.require("ap-2").invalidation).toBeNull();
  });
});
