/**
 * `src/workflow/run.ts` (issue #74; PLAN §2.1, §2.6).
 *
 * AC1 "Unapproved phase → refused with reason" and AC3 "Estimate output
 * distinguishes known/estimated/unknown" are exercised here at the
 * `estimateRun`/`startRun` layer; the confirm/decline/cap-refusal wiring
 * lives in `test/unit/extension/run-command.test.ts`. AC2 "Estimate over cap
 * → refused unless approved" and the resumable-stop requirement are
 * exercised in both files.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { estimateRun, startRun, stopRun } from "../../../src/workflow/run.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

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

function freshStore(): Store {
  const dir = makeTempDir("korwf-run-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `a-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF, planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, gateStatus: "pending" }));
  return store;
}

const actor = { kind: "user", identity: "owner" } as const;
const now = () => AT;
function newId(): string {
  return `id-${(counter += 1)}`;
}
