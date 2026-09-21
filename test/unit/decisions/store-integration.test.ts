/**
 * Decisions are persisted through the real store (issue #27 × #23).
 *
 * The unit tests for `ask` use an in-memory sink; this one uses the actual
 * SQLite `DecisionRepository`, so the record `ask` assembles is proved to
 * satisfy the store's schema, its foreign keys, and its append-only rule —
 * not just a structural interface.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import { ask, askAll, type AskContext, type AskItem } from "../../../src/decisions/ask.ts";
import { DecisionRecorder } from "../../../src/decisions/record.ts";
import { classifyQuestion, echoQuestion } from "../../../src/decisions/examples.ts";
import { DisabledJevTransport } from "../../../src/jev/disabled.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { SystemOneRequest, JevEvaluateResult } from "../../../src/jev/transport.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";
import type { TaskId, WorkflowId } from "../../../src/storage/records.ts";

const MODEL = "jev-test";
const open: { dir: TempDir; store: Store }[] = [];

function freshStore(): Store {
  const dir = makeTempDir("korwf-decisions-");
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

function recorderFor(store: Store): DecisionRecorder {
  let n = 0;
  return new DecisionRecorder({
    sink: store.decisions,
    workflowId: "wf-1" as WorkflowId,
    revision: "a".repeat(40),
    subject: { taskId: "tk-1" as TaskId, taskRevision: 1 },
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => `dc-${(n += 1)}`,
  });
}

function okResponder(noul: number): (r: SystemOneRequest) => JevEvaluateResult {
  return (request) => ({
    kind: "ok",
    response: {
      model: MODEL,
      answers: Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: "noul", noul }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: "req",
    attempts: 1,
    elapsedMs: 1,
  });
}

describe("AC: every ask writes a Decision record, through the real store", () => {
  it("a disabled-mode ask persists a row with rule 'fallback'", async () => {
    const store = freshStore();
    const ctx: AskContext = {
      transport: new DisabledJevTransport("no key configured"),
      recorder: recorderFor(store),
      model: MODEL,
    };
    await ask(ctx, echoQuestion, { text: "hello" });

    const rows = store.decisions.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.policyRule).toBe("fallback");
    expect(rows[0]!.subject).toEqual({ taskId: "tk-1", taskRevision: 1 });
    expect(rows[0]!.freshness.revision).toBe("a".repeat(40));
  });

  it("the persisted row is queryable by question id and state hash", async () => {
    const store = freshStore();
    const ctx: AskContext = { transport: new DisabledJevTransport("x"), recorder: recorderFor(store), model: MODEL };
    const result = await ask(ctx, echoQuestion, { text: "hello" });
    const found = store.decisions.byStateHash("example.echo", result.stateHash);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(result.decisionId);
  });

  it("a persisted decision cannot be updated (append-only)", async () => {
    const store = freshStore();
    const ctx: AskContext = { transport: new DisabledJevTransport("x"), recorder: recorderFor(store), model: MODEL };
    const result = await ask(ctx, echoQuestion, { text: "hello" });
    expect(() =>
      store.connection.prepare("UPDATE decision SET questionId = ? WHERE id = ?").run("forged", result.decisionId),
    ).toThrow(/append-only/);
  });

  it("the raw distribution survives the round trip unchanged", async () => {
    const store = freshStore();
    const ctx: AskContext = {
      transport: new MockJevTransport({ responder: okResponder(0.75) }),
      recorder: recorderFor(store),
      model: MODEL,
    };
    const result = await ask(ctx, echoQuestion, { text: "" });
    const row = store.decisions.list()[0]!;
    expect(row.rawDistribution).toEqual(result.distribution);
    expect(row.rawDistribution["true"]).toBe(0.75);
    expect(row.jevModelVersion).toBe(MODEL);
  });

  it("a batch persists one row per question and every row is audited", async () => {
    const store = freshStore();
    const ctx: AskContext = {
      transport: new MockJevTransport({ responder: okResponder(0.9) }),
      recorder: recorderFor(store),
      model: MODEL,
    };
    const items = [
      { question: echoQuestion, input: { text: "is it?" } },
      { question: classifyQuestion, input: { text: "is it?" } },
    ] as unknown as AskItem<unknown, unknown>[];
    await askAll(ctx, items);

    expect(store.decisions.count()).toBe(2);
    const audited = store.audit.list().filter((row) => row.table === "decision");
    expect(audited).toHaveLength(2);
    expect(audited.every((row) => row.operation === "insert")).toBe(true);
  });

  it("reuse replays the stored decision instead of calling Jev again", async () => {
    const store = freshStore();
    const transport = new MockJevTransport({ responder: okResponder(0.9) });
    const ctx: AskContext = { transport, recorder: recorderFor(store), model: MODEL };
    const first = await ask(ctx, echoQuestion, { text: "hello" }, { reuse: true });
    const second = await ask(ctx, echoQuestion, { text: "hello" }, { reuse: true });

    expect(second.reused).toBe(true);
    expect(second.decisionId).toBe(first.decisionId);
    expect(transport.calls).toHaveLength(1);
    expect(store.decisions.count()).toBe(1);
  });
});
