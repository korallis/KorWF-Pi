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
