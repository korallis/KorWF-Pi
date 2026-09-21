/**
 * Record rules enforced by the store (issue #23; docs/records.md §4, §5).
 *
 * These are the rules docs/records.md says "the store enforces": the task
 * revision rule, the frozen attempt, and the approval's single patchable
 * field.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { RecordRuleError } from "../../../src/storage/errors.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makeApproval, makeAttempt, makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): Store {
  const dir = makeTempDir("korwf-rules-");
  let counter = 0;
  const { store } = openStore({
    storageRoot: dir.path,
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `audit-${(counter += 1)}`,
  });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow());
  store.phases.insert(makePhase());
  store.tasks.insert(makeTask());
  return store;
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("task revision rule (docs/records.md §5.1)", () => {
  it("accepts a revisioned change that bumps revision by exactly one", () => {
    const store = freshStore();
    const updated = store.tasks.update("tk-1", { goal: "Write a better thing", revision: 2 });
    expect(updated.revision).toBe(2);
    expect(updated.goal).toBe("Write a better thing");
  });

  it("rejects a revisioned change with no revision bump", () => {
    const store = freshStore();
    expect(() => store.tasks.update("tk-1", { goal: "changed" })).toThrow(RecordRuleError);
    expect(store.tasks.require("tk-1").goal).toBe("Write the thing");
  });

  it("rejects a revision bump of more than one", () => {
    const store = freshStore();
    expect(() => store.tasks.update("tk-1", { checks: [], revision: 5 })).toThrow(/requires revision 2/);
  });

  it("rejects a revision change with no revisioned field touched", () => {
    const store = freshStore();
    expect(() => store.tasks.update("tk-1", { revision: 2 })).toThrow(/may only change together with/);
  });

  it("allows status and blocker changes without bumping the revision", () => {
    const store = freshStore();
    const updated = store.tasks.update("tk-1", { status: "blocked", blocker: "waiting on review" });
    expect(updated.revision).toBe(1);
    expect(updated.status).toBe("blocked");
  });

  it("rolls the whole transaction back when a rule rejects a patch", () => {
    const store = freshStore();
    expect(() =>
      store.write(() => {
        store.tasks.update("tk-1", { status: "running" });
        store.tasks.update("tk-1", { goal: "no bump" });
      }),
    ).toThrow(RecordRuleError);
    expect(store.tasks.require("tk-1").status).toBe("ready");
  });
});

describe("attempt is frozen once its outcome is set (docs/records.md §4)", () => {
  it("allows patches while the outcome is null", () => {
    const store = freshStore();
    store.attempts.insert(makeAttempt());
    const updated = store.attempts.update("at-1", {
      timestamps: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, lastActivityAt: "2026-01-01T00:05:00.000Z" },
    });
    expect(updated.timestamps.lastActivityAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("rejects any patch after the outcome is recorded", () => {
    const store = freshStore();
    store.attempts.insert(makeAttempt());
    store.attempts.update("at-1", { outcome: "succeeded" });
    expect(() => store.attempts.update("at-1", { outcome: "failed" })).toThrow(/frozen/);
    expect(store.attempts.require("at-1").outcome).toBe("succeeded");
  });
});

describe("approval: only `invalidation` is patchable, null → non-null (§4)", () => {
  it("accepts an invalidation", () => {
    const store = freshStore();
    store.approvals.insert(makeApproval());
    const invalidated = store.approvals.invalidate("ap-1", {
      reason: "task_revision_changed",
      at: "2026-01-02T00:00:00.000Z",
      detail: null,
    });
    expect(invalidated.invalidation?.reason).toBe("task_revision_changed");
  });

  it("rejects a patch to any other field", () => {
    const store = freshStore();
    store.approvals.insert(makeApproval());
    expect(() => store.approvals.update("ap-1", { riskClass: "high" })).toThrow(/only `invalidation` is patchable/);
  });

  it("never clears or rewrites an existing invalidation", () => {
    const store = freshStore();
    store.approvals.insert(makeApproval());
    store.approvals.invalidate("ap-1", { reason: "revoked", at: "2026-01-02T00:00:00.000Z", detail: null });
    expect(() =>
      store.approvals.invalidate("ap-1", { reason: "expired", at: "2026-01-03T00:00:00.000Z", detail: null }),
    ).toThrow(/already invalidated/);
    expect(store.approvals.require("ap-1").invalidation?.reason).toBe("revoked");
  });
});
