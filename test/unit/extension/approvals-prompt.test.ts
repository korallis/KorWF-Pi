/**
 * The approval prompt (issue #49; PLAN §2.6).
 *
 * AC3: "Non-TTY run never blocks waiting for input (test with a timeout)."
 *
 * Each no-UI test is wrapped in its own wall-clock deadline: a regression that
 * made the prompt await a never-resolving dialog would fail here rather than
 * hang the suite, which is the failure mode the criterion is about.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import {
  buildApprovalPrompt,
  promptForApproval,
  renderApprovalQueueLine,
  resolveApprovalInteractively,
  type ApprovalPromptUI,
} from "../../../src/extension/ui/approval-prompt.ts";
import { requestApproval } from "../../../src/workflow/approvals.ts";
import { approvalsMessage, parseApprovalsArgs } from "../../../src/extension/commands/approvals.ts";
import type { ApprovalRequest } from "../../../src/storage/approval-requests.ts";
import type { TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const TK = "tk-1" as TaskId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

const newId = () => `id-${(counter += 1)}`;

function freshStore(): Store {
  const dir = makeTempDir("korwf-approval-prompt-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ status: "running", mode: "bounded_autonomous", policyVersion: "2026.1" }));
  store.phases.insert(makePhase({ gateStatus: "running" }));
  store.tasks.insert(makeTask({ status: "review", revision: 1 }));
  return store;
}

function queue(store: Store): ApprovalRequest {
  const result = requestApproval({
    store,
    workflowId: WF,
    classId: "publishing",
    scope: { kind: "task", taskId: TK },
    permittedAction: "publish:v1.2.0",
    summary: "publish release v1.2.0 to the registry",
    taskRevision: 1,
    now: AT,
    newId,
  });
  if (result.request === null) throw new Error("expected a queued request");
  return result.request;
}

/** Fail rather than hang if a promise outlives its budget. */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A UI whose dialog never resolves — the hang this criterion guards against. */
function neverAnswersUI(overrides: Partial<ApprovalPromptUI> = {}): ApprovalPromptUI & { calls: number } {
  const ui = {
    calls: 0,
    confirm: () => {
      ui.calls += 1;
      return new Promise<boolean>(() => {});
    },
    ...overrides,
  };
  return ui as ApprovalPromptUI & { calls: number };
}

describe("AC3: a non-TTY run never blocks waiting for input", () => {
  it("hasUI === false returns `queued` without ever calling confirm", async () => {
    const store = freshStore();
    const request = queue(store);
    const ui = neverAnswersUI({ hasUI: false });
    const result = await withDeadline(promptForApproval({ request, ui }), 1000, "promptForApproval(no UI)");
    expect(result.outcome).toBe("queued");
    expect(result.skippedReason).toBe("no_ui");
    expect(ui.calls).toBe(0);
  });

  it("hasUI === false writes nothing: the request stays pending and no Approval exists", async () => {
    const store = freshStore();
    const request = queue(store);
    const result = await withDeadline(
      resolveApprovalInteractively({
        store,
        request,
        ui: neverAnswersUI({ hasUI: false }),
        actor: { kind: "user", identity: "owner" },
        now: AT,
        newId,
      }),
      1000,
      "resolveApprovalInteractively(no UI)",
    );
    expect(result.prompt.outcome).toBe("queued");
    expect(result.grant).toBeNull();
    expect(store.approvalRequests.find(request.requestId)?.status).toBe("pending");
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
  });

  it("a UI that never answers times out and leaves the request queued", async () => {
    const store = freshStore();
    const request = queue(store);
    const result = await withDeadline(
      promptForApproval({ request, ui: neverAnswersUI({ hasUI: true }), timeoutMs: 20 }),
      1000,
      "promptForApproval(timeout)",
    );
    expect(result.outcome).toBe("queued");
    expect(result.skippedReason).toBe("timeout");
    expect(store.approvalRequests.find(request.requestId)?.status).toBe("pending");
  });

  it("a timed-out prompt grants nothing through resolveApprovalInteractively", async () => {
    const store = freshStore();
    const request = queue(store);
    const result = await withDeadline(
      resolveApprovalInteractively({
        store,
        request,
        ui: neverAnswersUI({ hasUI: true }),
        actor: { kind: "user", identity: "owner" },
        now: AT,
        newId,
        timeoutMs: 20,
      }),
      1000,
      "resolveApprovalInteractively(timeout)",
    );
    expect(result.grant).toBeNull();
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
  });

  it("a prompt that throws is a refusal, not consent", async () => {
    const store = freshStore();
    const request = queue(store);
    const result = await withDeadline(
      promptForApproval({
        request,
        ui: {
          hasUI: true,
          confirm: () => {
            throw new Error("no terminal");
          },
        },
      }),
      1000,
      "promptForApproval(throws)",
    );
    expect(result.outcome).toBe("queued");
    expect(result.skippedReason).toBe("prompt_failed");
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
  });
});

describe("AC1: only an explicit affirmative from a user produces an Approval", () => {
  const notTrue: { label: string; value: unknown }[] = [
    { label: "false", value: false },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "the string 'yes'", value: "yes" },
    { label: "a truthy object", value: { approved: true } },
    { label: "the number 1", value: 1 },
  ];
  for (const { label, value } of notTrue) {
    it(`confirm returning ${label} denies rather than approves`, async () => {
      const store = freshStore();
      const request = queue(store);
      const result = await resolveApprovalInteractively({
        store,
        request,
        ui: { hasUI: true, confirm: () => value as boolean },
        actor: { kind: "user", identity: "owner" },
        now: AT,
        newId,
      });
      expect(result.prompt.outcome).toBe("denied");
      expect(result.grant).toBeNull();
      expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
      expect(store.approvalRequests.find(request.requestId)?.status).toBe("denied");
    });
  }

  it("confirm returning exactly true records a user-granted Approval", async () => {
    const store = freshStore();
    const request = queue(store);
    const result = await resolveApprovalInteractively({
      store,
      request,
      ui: { hasUI: true, confirm: () => true },
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    expect(result.prompt.outcome).toBe("approved");
    expect(result.grant?.granted).toBe(true);
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(1);
  });

  it("approving a question the world outran still grants nothing (AC2)", async () => {
    const store = freshStore();
    const request = queue(store);
    // The task changes while the dialog is open.
    const task = store.tasks.require(TK);
    store.tasks.update(TK, { revision: task.revision + 1, goal: `${task.goal} (edited)` });
    const result = await resolveApprovalInteractively({
      store,
      request,
      ui: { hasUI: true, confirm: () => true },
      actor: { kind: "user", identity: "owner" },
      now: AT,
      newId,
    });
    expect(result.prompt.outcome).toBe("approved");
    expect(result.grant?.granted).toBe(false);
    expect(store.approvals.findBy("workflowId", WF)).toHaveLength(0);
  });

  it("an already-resolved request is not re-asked", async () => {
    const store = freshStore();
    const request = queue(store);
    const ui = neverAnswersUI({ hasUI: true });
    const answered = { ...request, status: "granted" as const };
    const result = await withDeadline(promptForApproval({ request: answered, ui }), 1000, "promptForApproval(resolved)");
    expect(result.outcome).toBe("queued");
    expect(ui.calls).toBe(0);
  });
});

describe("the prompt text describes what is being approved", () => {
  it("names the class, act, scope, revisions and the high-risk pin", () => {
    const store = freshStore();
    const text = buildApprovalPrompt(queue(store));
    const body = text.lines.join("\n");
    expect(text.title).toContain("publishing");
    expect(body).toContain("publish:v1.2.0");
    expect(body).toContain("task tk-1 (revision 1)");
    expect(body).toContain("plan revision 1");
    expect(body).toContain("stops the phase");
    expect(body).toContain("cannot be configured to auto");
  });

  it("redacts a summary assembled from repository content", () => {
    const store = freshStore();
    const request = {
      ...queue(store),
      // A credential-shaped string that reached the summary via a file. check-secrets:allow
      summary: "deploy with AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEKEY0",
    };
    const body = buildApprovalPrompt(request).lines.join("\n");
    expect(body).not.toContain("AKIAIOSFODNN7EXAMPLEKEY0");
  });

  it("renders one greppable queue line per request", () => {
    const store = freshStore();
    const line = renderApprovalQueueLine(queue(store));
    expect(line.startsWith("HIGH-RISK")).toBe(true);
    expect(line).toContain("publishing");
    expect(line).toContain("tk-1");
  });
});

describe("/korwf approvals shows the queue and never mutates it", () => {
  it("lists a pending high-risk request as HIGH-RISK/STOP", () => {
    const store = freshStore();
    const request = queue(store);
    const outcome = approvalsMessage(store, parseApprovalsArgs([], AT));
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("HIGH-RISK/STOP");
    expect(outcome.message).toContain(request.requestId);
    expect(outcome.message).toContain("publish:v1.2.0");
    expect(store.approvalRequests.find(request.requestId)?.status).toBe("pending");
  });

  it("marks a request the world outran as STALE and says it cannot be granted", () => {
    const store = freshStore();
    queue(store);
    const task = store.tasks.require(TK);
    store.tasks.update(TK, { revision: task.revision + 1, goal: `${task.goal} (edited)` });
    const outcome = approvalsMessage(store, parseApprovalsArgs([], AT));
    expect(outcome.message).toContain("STALE:task_revision_changed");
    expect(outcome.message).toContain("cannot be granted");
  });

  it("--high-risk filters to the PLAN \u00a77 classes", () => {
    const store = freshStore();
    queue(store);
    requestApproval({
      store,
      workflowId: WF,
      classId: "add_dependency",
      scope: { kind: "task", taskId: TK },
      permittedAction: "add_dependency:left-pad",
      summary: "add a dependency",
      taskRevision: 1,
      now: AT,
      newId,
    });
    const all = approvalsMessage(store, parseApprovalsArgs([], AT));
    expect(all.message).toContain("add_dependency");
    const filtered = approvalsMessage(store, parseApprovalsArgs(["--high-risk"], AT));
    expect(filtered.message).not.toContain("add_dependency");
    expect(filtered.message).toContain("publishing");
  });

  it("says so plainly when nothing is waiting", () => {
    const store = freshStore();
    const outcome = approvalsMessage(store, parseApprovalsArgs([], AT));
    expect(outcome.message).toContain("Nothing is waiting on a human.");
  });
});
