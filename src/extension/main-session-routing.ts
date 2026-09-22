/**
 * Opt-in main-session routing at safe boundaries only (issue #67; PLAN §3.D
 * "Main session": "Stable by default; opt-in routing of the main session
 * only at safe boundaries, with visible switch and explicit context
 * handoff.").
 *
 * This module does not itself decide *which* model to switch to — that is
 * #60's `selectModel` / the fallback policy. It is the gate a caller (e.g.
 * a cap-fallback handler) goes through to actually move the user's own
 * session:
 *
 *   1. Default off (`models.routeMainSession === false`): `requestSwitch`
 *      is a documented no-op, verified by spy in tests. The user's own
 *      session is never re-routed without opting in.
 *   2. Opt-in: a request is only *applied* at a safe boundary — Pi's
 *      `agent_settled` event (docs/pi-integration-map.md S7: "the only
 *      'nothing more will run automatically' signal", i.e. not mid-turn,
 *      not mid-tool-call) — and only when this session does not currently
 *      hold, and is not blocked by another process holding, the store
 *      write lock (`src/storage/lock.ts`, ADR 0006 rule 1).
 *   3. The switch is visible: a notice through `ctx.ui.notify` naming both
 *      models, and a session entry (`pi.appendEntry`) carrying the
 *      explicit handoff summary — an artefact a resumed/forked session can
 *      read back, per S13/S8.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isProcessAlive, readLockfile } from "../storage/lock.ts";
import { resolveLockfilePath, resolveStorageRoot } from "../storage/paths.ts";
import type { ModelRef } from "../config/types.ts";

export interface HandoffSummary {
  readonly reason: string;
  readonly fromModel: ModelRef | null;
  readonly toModel: ModelRef;
  readonly taskContext: string | null;
}

export interface SwitchRequest {
  readonly model: ModelRef;
  readonly handoff: HandoffSummary;
}

export type SwitchOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "queued" }
  | { readonly kind: "no_pending" }
  | { readonly kind: "blocked"; readonly why: "lock_held" | "not_idle" }
  | { readonly kind: "switch_failed" }
  | { readonly kind: "switched"; readonly entry: MainSessionSwitchEntry };

/** Custom session-entry payload recorded on every applied switch (S13). */
export interface MainSessionSwitchEntry {
  readonly at: string;
  readonly fromModel: ModelRef | null;
  readonly toModel: ModelRef;
  readonly reason: string;
  readonly taskContext: string | null;
}

export const MAIN_SESSION_SWITCH_ENTRY_TYPE = "korwf/main-session-switch";

export interface MainSessionRoutingDeps {
  readonly isEnabled: () => boolean;
  readonly isIdle: () => boolean;
  readonly isLockHeldByOther: () => boolean;
  readonly currentModel: () => ModelRef | null;
  readonly setModel: (model: ModelRef) => Promise<boolean>;
  readonly notify: (message: string) => void;
  readonly recordEntry: (entry: MainSessionSwitchEntry) => void;
  readonly now: () => string;
}

/**
 * Holds at most one pending switch request and applies it the next time
 * `onSafeBoundary()` is called. Boundary and lock checks happen at *apply*
 * time, not at request time, so a request made mid-turn still only takes
 * effect once the turn has actually settled.
 */
export class MainSessionRouter {
  private pending: SwitchRequest | null = null;

  constructor(private readonly deps: MainSessionRoutingDeps) {}

  /**
   * Queue a switch. Returns `{kind:"disabled"}` immediately (and never
   * queues) when `models.routeMainSession` is off — the default-off
   * guarantee lives here, at the single entry point, not scattered across
   * callers.
   */
  requestSwitch(model: ModelRef, handoff: HandoffSummary): SwitchOutcome {
    if (!this.deps.isEnabled()) return { kind: "disabled" };
    this.pending = { model, handoff };
    return { kind: "queued" };
  }

  /** Whatever request is queued, unapplied. Exposed for tests/inspection only. */
  peekPending(): SwitchRequest | null {
    return this.pending;
  }

  /**
   * Called on a safe boundary (`agent_settled`). Applies the pending
   * request, if any and if safe; otherwise reports why not, and leaves the
   * request queued for the next boundary (never drops it silently) unless
   * disabled, in which case it is discarded — disabling routing mid-flight
   * must not leave a stale switch waiting to fire the moment it is
   * re-enabled with unrelated intent.
   */
  async onSafeBoundary(): Promise<SwitchOutcome> {
    if (!this.deps.isEnabled()) {
      this.pending = null;
      return { kind: "disabled" };
    }
    const request = this.pending;
    if (request === null) return { kind: "no_pending" };
    if (!this.deps.isIdle()) return { kind: "blocked", why: "not_idle" };
    if (this.deps.isLockHeldByOther()) return { kind: "blocked", why: "lock_held" };

    const from = this.deps.currentModel();
    const ok = await this.deps.setModel(request.model);
    if (!ok) return { kind: "switch_failed" };

    this.pending = null;
    const entry: MainSessionSwitchEntry = {
      at: this.deps.now(),
      fromModel: from,
      toModel: request.model,
      reason: request.handoff.reason,
      taskContext: request.handoff.taskContext,
    };
    // Visible switch (PLAN §3.D): the user always knows which model answers.
    this.deps.notify(
      `korwf: main session switched ${from ?? "(unknown)"} \u2192 ${request.model} \u2014 ${request.handoff.reason}`,
    );
    this.deps.recordEntry(entry);
    return { kind: "switched", entry };
  }
}

// ---------------------------------------------------------------------------
// Pi wiring
// ---------------------------------------------------------------------------

/** The `models` slice of config this module needs. Declared structurally (ADR 0002). */
export interface MainSessionRoutingConfig {
  readonly routeMainSession: boolean;
}

/**
 * Lock-aware "is another process writing to the store right now" check
 * (ADR 0006 rule 1). A missing or unreadable lockfile means nothing else
 * holds it. A lockfile whose pid is this process is *our own* hold, not a
 * conflict. Anything else with a live pid blocks a switch: PLAN §3.D 'not
 * while a worker holds the store lock'.
 */
export function isLockHeldByOtherProcess(storageRoot: string): boolean {
  const path = resolveLockfilePath(storageRoot);
  let contents;
  try {
    contents = readLockfile(path);
  } catch {
    return false;
  }
  if (contents.pid === process.pid) return false;
  return isProcessAlive(contents.pid);
}

export interface RegisterMainSessionRoutingOptions {
  readonly now?: () => string;
  readonly getStorageRoot?: (cwd: string) => string;
  readonly onOutcome?: (outcome: SwitchOutcome) => void;
}

/**
 * Register the safe-boundary handler on Pi's `agent_settled` event (S7: "the
 * only 'nothing more will run automatically' signal" — not mid-turn, not
 * mid-tool-call) and return `requestSwitch` for callers (e.g. the cap
 * fallback path) to queue a switch. Nothing is ever applied outside
 * `agent_settled`, and `router.requestSwitch` itself refuses to queue when
 * `models.routeMainSession` is off.
 */
export function registerMainSessionRouting(
  pi: Pick<ExtensionAPI, "on" | "appendEntry" | "setModel">,
  getConfigForCwd: (cwd: string) => MainSessionRoutingConfig | undefined,
  options: RegisterMainSessionRoutingOptions = {},
): { readonly router: MainSessionRouter; readonly requestSwitch: (cwd: string, model: ModelRef, handoff: HandoffSummary) => SwitchOutcome } {
  const now = options.now ?? (() => new Date().toISOString());
  const getStorageRoot = options.getStorageRoot ?? ((cwd: string) => resolveStorageRoot(cwd));
  const box: { ctx: ExtensionContext | null; cwd: string | null } = { ctx: null, cwd: null };

  const isEnabledFor = (cwd: string | null): boolean => {
    if (cwd === null) return false;
    return getConfigForCwd(cwd)?.routeMainSession ?? false;
  };

  const modelRefOf = (m: { readonly provider: string; readonly id: string } | undefined): ModelRef | null =>
    m === undefined ? null : (`${m.provider}/${m.id}` as ModelRef);

  const router = new MainSessionRouter({
    isEnabled: () => isEnabledFor(box.cwd),
    isIdle: () => box.ctx?.isIdle() ?? false,
    isLockHeldByOther: () => (box.cwd === null ? true : isLockHeldByOtherProcess(getStorageRoot(box.cwd))),
    currentModel: () => modelRefOf(box.ctx?.model),
    setModel: async (ref) => {
      if (box.ctx === null) return false;
      const slash = ref.indexOf("/");
      const provider = ref.slice(0, slash);
      const id = ref.slice(slash + 1);
      const model = box.ctx.modelRegistry.find(provider, id);
      if (model === undefined) return false;
      return pi.setModel(model);
    },
    notify: (message) => box.ctx?.ui.notify(message, "info"),
    recordEntry: (entry) => pi.appendEntry(MAIN_SESSION_SWITCH_ENTRY_TYPE, entry),
    now,
  });

  pi.on("agent_settled", async (_event, ctx) => {
    box.ctx = ctx;
    box.cwd = ctx.cwd;
    const outcome = await router.onSafeBoundary();
    options.onOutcome?.(outcome);
  });

  const requestSwitch = (cwd: string, model: ModelRef, handoff: HandoffSummary): SwitchOutcome => {
    box.cwd = cwd;
    return router.requestSwitch(model, handoff);
  };

  return { router, requestSwitch };
}
