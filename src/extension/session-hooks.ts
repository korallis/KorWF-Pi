/**
 * Pi session lifecycle hooks (issue #42; PLAN §4 "session/tree/fork/resume/
 * reload" integration surfaces, PLAN §5 branching paragraph).
 *
 * Pi can start, reload, replace, fork and tree-navigate a session. All five
 * rewind or re-point the *conversation*; none of them touches the repository,
 * the SQLite store, or anything the workflow already did to the outside
 * world. This module is the seam: on each such event it re-reads live git
 * state, reconciles the persisted workflow against it, surfaces the drift,
 * and lets `src/workflow/reconcile.ts` mark approvals stale.
 *
 * Deliberate properties:
 *
 * - **It decides nothing itself.** Every judgment lives in
 *   `src/workflow/reconcile.ts`; this file opens the store, passes `ctx.cwd`
 *   and the session id, and renders the result. Domain rules are not
 *   duplicated in the extension layer (ADR 0002).
 * - **It never fails the session.** A missing store, an unreadable repository
 *   or a locked database produces a redacted notice, not an exception that
 *   takes Pi's startup down with it.
 * - **It opens the store read-only unless it must write.** Reconciliation
 *   only writes when there is something to invalidate, and a second Pi window
 *   holding the write lock must not stop the first from *reporting* drift.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { openStore, resolveDatabasePath, resolveStorageRoot, type Store } from "../storage/index.ts";
import {
  describeReconciliation,
  reconcileAllWorkflows,
  type ReconcileReport,
  type SessionEvent,
} from "../workflow/reconcile.ts";
import { loadForProject } from "./commands/config.ts";
import { guardHandler, redactedUi, type NotifyUI } from "./redacted-ui.ts";

/** Session-start reasons Pi emits, mapped onto KorWF's `SessionEvent`. */
export const PI_START_REASONS = ["startup", "reload", "new", "resume", "fork"] as const;
export type PiStartReason = (typeof PI_START_REASONS)[number];

/**
 * Every Pi session-start reason is a KorWF session event of the same name;
 * `/tree` navigation adds `"tree"`. Declared as a total mapping so a new Pi
 * reason fails to compile here rather than being silently ignored — an
 * unhandled rewind is exactly the bug this module exists to prevent.
 */
export const SESSION_EVENT_FOR_REASON: Record<PiStartReason, SessionEvent> = {
  startup: "startup",
  reload: "reload",
  new: "new",
  resume: "resume",
  fork: "fork",
};

/** The minimal session context these hooks need. Declared structurally (ADR 0002). */
export interface SessionHookContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly ui: NotifyUI;
}

/** What one hook invocation concluded; returned so tests need no Pi session. */
export interface SessionHookResult {
  readonly event: SessionEvent;
  readonly reports: readonly ReconcileReport[];
  /** The text surfaced to the user, already redacted. */
  readonly message: string;
  /** `true` when the store could not be consulted at all. */
  readonly degraded: boolean;
}

/**
 * Does this event need a writable store?
 *
 * `startup` and `new` only report; the rewinding events may have to mark
 * approvals stale, and a stale approval that is only *reported* is not marked
 * at all. When the write lock is unavailable the hook degrades to read-only
 * reporting and says so — it never proceeds as if the invalidation had
 * happened.
 */
export function needsWrite(event: SessionEvent): boolean {
  return event !== "startup" && event !== "new";
}

let hookIdCounter = 0;
function defaultNewId(): string {
  hookIdCounter += 1;
  return `rec-${Date.now().toString(36)}-${hookIdCounter.toString(36)}`;
}

/** Injection points so the whole hook is testable without Pi or a real clock. */
export interface RunReconciliationDeps {
  readonly now?: () => string;
  readonly newId?: () => string;
  /** Override store opening; the default resolves the project's `.korwf/`. */
  readonly openStoreFor?: (cwd: string, writable: boolean) => Store | null;
}

/**
 * Open the project's store, or `null` when there is nothing to open.
 *
 * A project with no `.korwf/` has no workflow, so there is nothing to
 * reconcile and nothing to warn about: silence is correct. An invalid config
 * or a held write lock returns `null` too, and the caller reports a degraded
 * reconciliation rather than pretending the state was checked.
 */
function defaultOpenStore(cwd: string, writable: boolean): Store | null {
  const result = loadForProject(cwd);
  if (!result.ok) return null;
  const storageRoot = resolveStorageRoot(cwd, result.config.storage.path ?? undefined);
  if (!existsSync(resolveDatabasePath(storageRoot))) return null;
  return openStore({ storageRoot, writable, reconcile: false }).store;
}

/**
 * Reconcile every active workflow for a session event and produce the notice.
 *
 * Pure with respect to Pi: takes a context and returns a result. The Pi hook
 * registration below is a thin wrapper that calls this and notifies.
 */
export function runReconciliation(
  event: SessionEvent,
  ctx: SessionHookContext,
  deps: RunReconciliationDeps = {},
): SessionHookResult {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? defaultNewId;
  const open = deps.openStoreFor ?? defaultOpenStore;

  let store: Store | null = null;
  try {
    store = open(ctx.cwd, needsWrite(event));
  } catch {
    store = null;
  }

  if (store === null) {
    // Either there is no workflow here, or the store could not be opened. The
    // first case is silent; the second cannot be distinguished without
    // guessing, so the message is written to be true in both: nothing was
    // reconciled, and no approval was treated as current on that basis.
    return {
      event,
      reports: [],
      message: "",
      degraded: true,
    };
  }

  try {
    const reports = reconcileAllWorkflows({
      store,
      event,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      now: () => now(),
      newId,
      dryRun: !store.writable,
    });
    const interesting = reports.filter((report) => report.findings.length > 0);
    return {
      event,
      reports,
      message: interesting.map(describeReconciliation).join("\n"),
      degraded: false,
    };
  } finally {
    store.close();
  }
}

/**
 * Register the session lifecycle hooks on Pi's extension API.
 *
 * `session_start` covers startup, reload, `/new`, `/resume` and `/fork`;
 * `session_tree` covers `/tree` navigation, which changes the conversation's
 * leaf without a session start at all and would otherwise be the one rewind
 * nobody reconciled.
 *
 * Both handlers are wrapped in `guardHandler`, so a reconciliation failure is
 * a redacted notice rather than a broken session (Stage 2 exit criterion:
 * "failures cannot hang Pi or leak credentials").
 */
export function registerSessionHooks(pi: ExtensionAPI, deps: RunReconciliationDeps = {}): void {
  pi.on("session_start", async (event, ctx) => {
    await guardHandler(ctx.ui, `session ${event.reason} reconciliation`, () => {
      notify(ctx, SESSION_EVENT_FOR_REASON[event.reason], deps);
    });
  });

  pi.on("session_tree", async (_event, ctx) => {
    await guardHandler(ctx.ui, "session tree reconciliation", () => {
      notify(ctx, "tree", deps);
    });
  });
}

/** The context slice the Pi handlers supply. */
interface PiHandlerContext {
  readonly cwd: string;
  readonly ui: NotifyUI;
  readonly sessionManager: { getSessionId: () => string };
}

function notify(ctx: PiHandlerContext, event: SessionEvent, deps: RunReconciliationDeps): void {
  const ui = redactedUi(ctx.ui);
  const result = runReconciliation(
    event,
    { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), ui },
    deps,
  );
  if (result.message !== "") ui.notify(result.message, "warning");
}
