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
