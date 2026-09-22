/**
 * The human side of a high-risk approval (issue #49; PLAN §2.4 (3), §2.6, §7).
 *
 * This module shows a queued `ApprovalRequest` to a person and records what
 * they said. Three rules shape all of it:
 *
 * 1. **It never blocks without a human.** Pi reports `ctx.hasUI === false` in
 *    print/RPC mode and in a non-TTY run. In that case nothing is awaited: the
 *    request stays `pending`, the function returns `queued`, and the run
 *    continues with other ready work (PLAN §2.6 "queue and continue"). Issue
 *    #49 AC3 is a *timeout* test, so the no-UI path must not even construct a
 *    promise that could hang. A wall-clock cap is available for a UI that
 *    stops answering, and its expiry leaves the request pending rather than
 *    approving anything.
 * 2. **The prompt cannot approve anything by itself.** It returns an intent;
 *    the record is written by `grantApproval` in `src/workflow/approvals.ts`,
 *    which re-checks revisions, mode and policy version before minting an
 *    `Approval`. A UI that answered "yes" to a question the world has already
 *    outrun therefore still grants nothing.
 * 3. **Only an explicit affirmative counts.** `confirm` returning anything
 *    that is not exactly `true` is a refusal. Undefined, null, a closed dialog
 *    and a thrown error all mean "not approved" — never "assume yes".
 */
import type { Store } from "../../storage/db.ts";
import type { ApprovalRequest } from "../../storage/approval-requests.ts";
import type { IsoTimestamp } from "../../storage/records.ts";
import {
  denyApproval,
  grantApproval,
  type ApprovalActor,
  type GrantApprovalResult,
} from "../../workflow/approvals.ts";
import { redactString } from "../../security/index.ts";

/**
 * The slice of Pi's `ctx.ui` this module needs, declared structurally so the
 * module stays independent of the Pi API surface (ADR 0002) and is testable
 * without it — the same shape `src/extension/disclosure.ts` uses.
 */
export interface ApprovalPromptUI {
  readonly confirm: (title: string, body: string) => Promise<boolean> | boolean;
  readonly notify?: (message: string, level?: "info" | "warning" | "error") => void;
  /** `false` in print/RPC mode and any non-TTY run: nobody is there to answer. */
  readonly hasUI?: boolean;
}

/** What the prompt concluded. `queued` means nobody was asked. */
export type ApprovalPromptOutcome = "approved" | "denied" | "queued";

/** Why a prompt produced `queued` rather than an answer. */
export type ApprovalPromptSkipReason = "no_ui" | "timeout" | "prompt_failed";

export interface ApprovalPromptResult {
  readonly outcome: ApprovalPromptOutcome;
  /** `null` exactly when the outcome is `approved` or `denied`. */
  readonly skippedReason: ApprovalPromptSkipReason | null;
  readonly requestId: string;
}

/** Title and body of the dialog, rendered from the request row alone. */
export interface ApprovalPromptText {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * Render the question.
 *
 * Everything shown comes from the persisted request, redacted on the way out
 * (`src/security/redact.ts`), so a summary assembled from repository content
 * cannot put a credential on screen. The text names the class, the exact act,
 * and the revisions the answer will be pinned to, because an approval the user
 * cannot scope is not informed consent.
 */
export function buildApprovalPrompt(request: ApprovalRequest): ApprovalPromptText {
  const scope =
    request.scope.kind === "task"
      ? `task ${request.scope.taskId} (revision ${String(request.taskRevision)})`
      : request.scope.kind === "phase"
        ? `phase ${request.scope.phaseId}`
        : request.scope.kind;
  const lines = [
    redactString(request.summary),
    "",
    `Class:    ${request.classId} (${request.tier === "high_risk" ? "high risk \u2014 PLAN \u00a77" : request.tier})`,
    `Action:   ${redactString(request.permittedAction)}`,
    `Scope:    ${scope}`,
    `Mode:     ${request.mode} \u2192 ${request.decision === "stop" ? "stops the phase" : "queues and continues"}`,
    `Pinned:   plan revision ${String(request.planRevision)}, policy ${request.policyVersion}`,
    request.expiresAt === null ? "Expires:  never" : `Expires:  ${request.expiresAt}`,
    "",
    "Approving records a single-use approval pinned to the revisions above.",
    "Any change to the task or plan revision invalidates it.",
  ];
  if (request.tier === "high_risk") {
    lines.push("This class cannot be pre-approved in any mode and cannot be configured to auto.");
  }
  return {
    title: `KorWF-Pi approval required: ${request.classId}`,
    lines,
  };
}

/** One line per queued request, for a non-interactive listing or notification. */
export function renderApprovalQueueLine(request: ApprovalRequest): string {
  const marker = request.tier === "high_risk" ? "HIGH-RISK" : request.decision === "stop" ? "STOP" : "QUEUED";
  const subject =
    request.scope.kind === "task"
      ? request.scope.taskId
      : request.scope.kind === "phase"
        ? request.scope.phaseId
        : request.scope.kind;
  return `${marker}  ${request.requestId}  ${request.classId}  ${subject}  ${redactString(request.summary)}`;
}

export interface PromptForApprovalOptions {
  readonly request: ApprovalRequest;
  readonly ui: ApprovalPromptUI;
  /**
   * Wall-clock cap on waiting for the dialog. `null` waits as long as the UI
   * does — legitimate when a human is demonstrably present. Timing out leaves
   * the request pending; it never approves.
   */
  readonly timeoutMs?: number | null;
  /** Injectable timer, so tests need no real clock. */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Ask the human, if there is one.
 *
 * With `hasUI === false` this returns `queued` **synchronously-shaped**: no
 * `confirm` is called, nothing is awaited on the UI, and the caller is free to
 * carry on with other ready tasks. That is the property issue #49 AC3 tests
 * with a timeout, and it is why `hasUI` is checked before anything else.
 */
export async function promptForApproval(options: PromptForApprovalOptions): Promise<ApprovalPromptResult> {
  const { request, ui } = options;
  const requestId = request.requestId;

  if (ui.hasUI === false) {
    ui.notify?.(
      `KorWF-Pi queued an approval request (${request.classId}); run /korwf approvals to review it.`,
      "warning",
    );
    return { outcome: "queued", skippedReason: "no_ui", requestId };
  }
  if (request.status !== "pending") {
    // Nothing to ask: the question is already answered or stale. Treat it as
    // "nobody was asked" rather than inventing an answer.
    return { outcome: "queued", skippedReason: "no_ui", requestId };
  }

  const text = buildApprovalPrompt(request);
  let answer: unknown;
  try {
    answer = await withTimeout(
      Promise.resolve(ui.confirm(text.title, text.lines.join("\n"))),
      options.timeoutMs ?? null,
      options.setTimeoutFn ?? setTimeout,
      options.clearTimeoutFn ?? clearTimeout,
    );
  } catch (error) {
    // A broken prompt is not consent. The request stays pending.
    ui.notify?.(
      `KorWF-Pi could not show the approval prompt for ${request.classId}; it stays queued.`,
      "error",
    );
    void error;
    return { outcome: "queued", skippedReason: "prompt_failed", requestId };
  }

  if (answer === TIMED_OUT) {
    ui.notify?.(`KorWF-Pi approval prompt for ${request.classId} timed out; it stays queued.`, "warning");
    return { outcome: "queued", skippedReason: "timeout", requestId };
  }
  // Only an exact `true` approves. Anything else — false, null, undefined, a
  // string, a truthy object — is a refusal.
  if (answer === true) return { outcome: "approved", skippedReason: null, requestId };
  return { outcome: "denied", skippedReason: null, requestId };
}

/** Sentinel for an expired wait. Not exported: it must not leak into a result. */
const TIMED_OUT = Symbol("korwf.approval.timeout");

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
): Promise<T | typeof TIMED_OUT> {
  if (timeoutMs === null) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeoutFn(() => resolve(TIMED_OUT), timeoutMs);
    // Never hold the process open for a dialog nobody is watching.
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    if (timer !== undefined) clearTimeoutFn(timer);
  }
}

/** Prompting plus recording, in one call. */
export interface ResolveApprovalResult {
  readonly prompt: ApprovalPromptResult;
  /** `null` unless the user approved *and* `grantApproval` accepted. */
  readonly grant: GrantApprovalResult | null;
}

/**
 * Ask, then record.
 *
 * The prompt is advisory and the store is authoritative: a "yes" is handed to
 * `grantApproval`, which re-validates the request against the live workflow
 * and task before writing an `Approval`. So a user who approves a question
 * whose task revision moved while the dialog was open gets a refusal with
 * `task_revision_changed`, not a grant.
 *
 * With no UI nothing is written at all and the request stays queued, so an
 * unattended `run` reaches this function and moves straight past it.
 */
export async function resolveApprovalInteractively(options: {
  readonly store: Store;
  readonly request: ApprovalRequest;
  readonly ui: ApprovalPromptUI;
  readonly actor: ApprovalActor;
  readonly now: IsoTimestamp;
  readonly newId: () => string;
  readonly timeoutMs?: number | null;
  /** Lifetime of the resulting approval; `null` = no expiry. */
  readonly approvalTtlMs?: number | null;
}): Promise<ResolveApprovalResult> {
  const prompt = await promptForApproval({
    request: options.request,
    ui: options.ui,
    timeoutMs: options.timeoutMs ?? null,
  });
  if (prompt.outcome === "queued") return { prompt, grant: null };
  if (prompt.outcome === "denied") {
    denyApproval({
      store: options.store,
      requestId: options.request.requestId,
      actor: options.actor,
      now: options.now,
      detail: "declined at the approval prompt",
    });
    return { prompt, grant: null };
  }
  const grant = grantApproval({
    store: options.store,
    requestId: options.request.requestId,
    actor: options.actor,
    now: options.now,
    newId: options.newId,
    ttlMs: options.approvalTtlMs ?? null,
  });
  return { prompt, grant };
}
