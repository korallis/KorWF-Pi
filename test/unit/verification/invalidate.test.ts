/**
 * Evidence invalidation after relevant changes (issue #50; PLAN §3.F;
 * `test/scenarios/02-existing-repo.md` steps A4/A5).
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { CheckDefinition, EvidenceId, TaskId } from "../../../src/storage/records.ts";
import {
  assessStaleness,
  checkInvalidations,
  invalidateStaleEvidence,
  isRelevantChange,
  pathIsRelevant,
  type WorktreeChangeSet,
} from "../../../src/verification/invalidate.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { AT, SHA, makeEvidence, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import { evaluateTaskGate, gateCheckState, freshEvidence, type JevGateConfig } from "../../../src/verification/task-gate.ts";

const TK = "tk-1" as TaskId;
const OLD_SHA = SHA;
const NEW_SHA = "c".repeat(40);

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function freshStore(): Store {
  const dir = makeTempDir("korwf-invalidate-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `n-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ planRevision: 1, status: "running" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

const CHK1: CheckDefinition = {
  id: "chk1",
  kind: "command",
  command: "npm test -- orders",
  cwd: ".",
  expectedExitCode: 0,
  coversCriteria: ["ac1"],
  required: true,
};

const PROJECT_CHK: CheckDefinition = {
  id: "project:test",
  kind: "command",
  command: "npm test",
  cwd: ".",
  expectedExitCode: 0,
  coversCriteria: [],
  required: true,
};

describe("pathIsRelevant", () => {
  it("is relevant for a path inside an owned directory", () => {
    expect(pathIsRelevant("src/db/repo.ts", { paths: ["src/db"] })).toBe(true);
  });

  it("is not relevant for a sibling path with a shared prefix", () => {
    expect(pathIsRelevant("src/database.ts", { paths: ["src/db"] })).toBe(false);
  });

  it("treats an empty ownership list as owning everything", () => {
    expect(pathIsRelevant("anything/at/all.ts", { paths: [] })).toBe(true);
  });
});

describe("isRelevantChange — acceptance: unrelated-file change does not invalidate, declared-input change does", () => {
  const ownership = { paths: ["src/routes/orders.ts", "src/db/repo.ts"] };

  it("an unrelated file change does not invalidate a task check with declared inputs", () => {
    const changes: WorktreeChangeSet = { kind: "paths", paths: ["docs/legacy-orders-migration.md"] };
    expect(isRelevantChange(CHK1, ownership, changes)).toBe(false);
  });

  it("a change inside declared ownership invalidates the check", () => {
    const changes: WorktreeChangeSet = { kind: "paths", paths: ["src/db/repo.ts"] };
    expect(isRelevantChange(CHK1, ownership, changes)).toBe(true);
  });

  it("an unknown change set is always relevant (conservative)", () => {
    const changes: WorktreeChangeSet = { kind: "unknown", reason: "git status failed" };
    expect(isRelevantChange(CHK1, ownership, changes)).toBe(true);
  });

  it("a project-wide check is invalidated by any change, including outside ownership", () => {
    const changes: WorktreeChangeSet = { kind: "paths", paths: ["docs/legacy-orders-migration.md"] };
    expect(isRelevantChange(PROJECT_CHK, ownership, changes)).toBe(true);
  });

  it("a project-wide check is not invalidated when nothing changed", () => {
    const changes: WorktreeChangeSet = { kind: "paths", paths: [] };
    expect(isRelevantChange(PROJECT_CHK, ownership, changes)).toBe(false);
  });
});

describe("checkInvalidations", () => {
  const task = makeTask({
    checks: [CHK1],
    ownership: { paths: ["src/routes/orders.ts", "src/db/repo.ts"], components: [] },
    revision: 1,
  });

  it("names the fresh evidence a relevant change excludes", () => {
    const evidence = [makeEvidence({ id: "ev-1" as EvidenceId, checkId: "chk1", taskRevision: 1, revision: OLD_SHA })];
    const result = checkInvalidations(
      task,
      evidence,
      OLD_SHA,
      { kind: "paths", paths: ["src/db/repo.ts"] },
    );
    expect(result).toEqual([{ checkId: "chk1", relevant: true, excludedEvidenceIds: ["ev-1"] }]);
  });

  it("reports no exclusions for an unrelated change", () => {
    const evidence = [makeEvidence({ id: "ev-1" as EvidenceId, checkId: "chk1", taskRevision: 1, revision: OLD_SHA })];
    const result = checkInvalidations(
      task,
      evidence,
      OLD_SHA,
      { kind: "paths", paths: ["docs/legacy-orders-migration.md"] },
    );
    expect(result).toEqual([{ checkId: "chk1", relevant: false, excludedEvidenceIds: [] }]);
  });
});

describe("assessStaleness — acceptance: only fires for review/verifying candidates", () => {
  const task = makeTask({
    checks: [CHK1],
    ownership: { paths: ["src/db/repo.ts"], components: [] },
    revision: 1,
    status: "review",
  });
  const evidence = [makeEvidence({ id: "ev-1" as EvidenceId, checkId: "chk1", taskRevision: 1, revision: OLD_SHA })];

  it("is stale when a relevant change lands while in review", () => {
    const result = assessStaleness(task, evidence, OLD_SHA, { kind: "paths", paths: ["src/db/repo.ts"] });
    expect(result.stale).toBe(true);
    expect(result.excludedEvidenceIds).toEqual(["ev-1"]);
  });

  it("is not stale when the change is unrelated", () => {
    const result = assessStaleness(task, evidence, OLD_SHA, { kind: "paths", paths: ["README.md"] });
    expect(result.stale).toBe(false);
  });

  it("never fires for a task that has not reached verifying/review", () => {
    const runningTask = { ...task, status: "running" as const };
    const result = assessStaleness(runningTask, evidence, OLD_SHA, { kind: "paths", paths: ["src/db/repo.ts"] });
    expect(result.stale).toBe(false);
    expect(result.invalidated).toEqual([]);
  });
});

describe("invalidateStaleEvidence — scenario 2 A4: a later edit sends `review` back to `verifying`", () => {
  function seeded(): Store {
    const store = freshStore();
    store.tasks.insert(
      makeTask({
        checks: [CHK1],
        ownership: { paths: ["src/routes/orders.ts", "src/db/repo.ts"], components: [] },
        revision: 1,
        status: "review",
      }),
    );
    store.evidence.insert(
      makeEvidence({
        id: "ev-1" as EvidenceId,
        checkId: "chk1",
        taskRevision: 1,
        revision: OLD_SHA,
        requirementId: "ac-1",
        attemptId: null,
      }),
    );
    return store;
  }

  function actorNow() {
    return { kind: "engine", identity: "engine" } as const;
  }

  it("fires task-stale-evidence and returns the task to verifying, retaining old evidence", () => {
    const store = seeded();
    const result = invalidateStaleEvidence({
      store,
      taskId: TK,
      oldRevision: OLD_SHA,
      newRevision: NEW_SHA,
      changes: { kind: "paths", paths: ["src/db/repo.ts"] },
      actor: actorNow(),
      now: () => AT,
      newId: () => `n-${(counter += 1)}`,
    });

    expect(result.assessment.stale).toBe(true);
    expect(result.transition?.subject.status).toBe("verifying");
    expect(store.tasks.require(TK).status).toBe("verifying");
    // Revision unchanged — no criteria/check change, records.md §5.1.
    expect(store.tasks.require(TK).revision).toBe(1);

    // Old evidence is retained, not deleted.
    const stillThere = store.evidence.findBy("taskId", TK).find((e) => e.id === "ev-1");
    expect(stillThere).toBeDefined();
    expect(stillThere?.revision).toBe(OLD_SHA);
    expect(stillThere?.updatedAt).toBe(stillThere?.createdAt);
  });

  it("does nothing when the change does not touch declared ownership", () => {
    const store = seeded();
    const result = invalidateStaleEvidence({
      store,
      taskId: TK,
      oldRevision: OLD_SHA,
      newRevision: NEW_SHA,
      changes: { kind: "paths", paths: ["docs/legacy-orders-migration.md"] },
      actor: actorNow(),
      now: () => AT,
      newId: () => `n-${(counter += 1)}`,
    });
    expect(result.assessment.stale).toBe(false);
    expect(result.transition).toBeNull();
    expect(store.tasks.require(TK).status).toBe("review");
  });
});

describe("acceptance: stale evidence is never counted by the gate", () => {
  it("evidence at the old revision does not satisfy C1 once SHA(T) has moved", () => {
    const task = makeTask({ checks: [CHK1], acceptanceCriteria: [{ id: "ac1", text: "count" }], revision: 1, status: "review" });
    const evidence = [
      makeEvidence({ id: "ev-1" as EvidenceId, checkId: "chk1", taskRevision: 1, revision: OLD_SHA, requirementId: "ac1", attemptId: null }),
    ];

    // gateCheckState/freshEvidence (#46) read the stale row as absent at NEW_SHA.
    const fresh = freshEvidence({ task, evidence }, NEW_SHA);
    expect(fresh).toEqual([]);
    expect(gateCheckState(CHK1, fresh).state).toBe("missing");

    const jev: JevGateConfig = { enabled: false, optional: true, confidenceThreshold: 0.8, questionVersion: "1" };
    const result = evaluateTaskGate({
      workflow: makeWorkflow(),
      task,
      revision: NEW_SHA,
      evidence,
      decisions: [],
      approvals: [],
      attempts: [],
      unresolvedBlockers: [],
      policy: { modelReview: false, humanApproval: false, changeClass: "backend", policyVersion: "1", revision: NEW_SHA, taskRevision: 1 },
      jev,
      now: AT,
    });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.condition === "C1" && r.reasonCode === "check_missing")).toBe(true);
  });
});
