/**
 * Pi extension entry point for KorWF-Pi (issue #19 Scope).
 *
 * This is the only module that imports `@earendil-works/pi-coding-agent`
 * (docs/adr/0002-source-layout.md). It registers the `/korwf` command
 * namespace with `version`, the route-aware `models` and `status`
 * listings from issue #125, and `plan` (issue #33, intake). Later issues
 * add `run` and the rest of the surface described in README.md "Planned
 * user interface".
 *
 * Every command, tool, and storage path this package registers is
 * namespaced `korwf` (PLAN §3.J; AGENTS.md constraint).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { versionMessage } from "./commands/version.ts";
import { modelsMessage } from "./commands/models.ts";
import { statusReportMessage } from "./commands/status.ts";
import { parsePinArgs, parseUnpinArgs, pinModel, unpinModel } from "./commands/models-pin.ts";
import { configMessage, disclosureMessage, loadForProject } from "./commands/config.ts";
import { createFileDisclosureStore, ensureDisclosureAccepted } from "./disclosure.ts";
import { getPackageVersion } from "./commands/version.ts";
import { RouteAvailabilityTable } from "../models/availability.ts";
import { guardHandler, redactedUi } from "./redacted-ui.ts";
import { jevStatusMessage } from "./commands/jev-status.ts";
import { purgeMessage, whyMessage } from "./commands/why.ts";
import { runPlanIntake } from "./commands/plan.ts";
import { tasksMessage, parseTasksArgs } from "./commands/tasks.ts";
import { phasesMessage, parsePhasesArgs } from "./commands/phases.ts";
import { approvalsMessage, parseApprovalsArgs } from "./commands/approvals.ts";
import { runExport, parseExportArgs } from "./commands/export.ts";
import { openStore, resolveStorageRoot } from "../storage/index.ts";
import { resolveDatabasePath } from "../storage/paths.ts";
import { existsSync } from "node:fs";
import { readLiveRepoState } from "../git/revision.ts";
import { registerSessionHooks } from "./session-hooks.ts";
import { registerCatalogRefresh } from "./catalog-refresh.ts";
import type { CatalogConfig } from "../models/catalog.ts";
import { registerMainSessionRouting } from "./main-session-routing.ts";
import { runAvailability, runRefusalMessage } from "./commands/run.ts";
import { pauseMessage, parseWorkerCommandArgs } from "./commands/pause.ts";
import { resumeMessage } from "./commands/resume.ts";
import { cancelMessage } from "./commands/cancel.ts";
import { WorkerRegistry } from "../workers/lifecycle.ts";
import { buildTaskBoard } from "../workflow/boards.ts";
import { openLedger } from "../telemetry/ledger.ts";
import { resolveBoardWorkflow } from "./commands/workflow-select.ts";

/**
 * Recursion guard 2 (#68, ADR 0004): read the depth marker once, at load.
 * When this process is itself a worker, the spawn surface is not registered
 * at all — `run` is absent from the command list, its completion, and the
 * dispatch switch — so there is nothing to invoke rather than something that
 * refuses.
 */
const RUN_AVAILABILITY = runAvailability();

const SUBCOMMANDS = [
  "version",
  "models",
  "status",
  "config",
  "disclosure",
  "jev",
  "why",
  "purge",
  "plan",
  "tasks",
  "phases",
  "approvals",
  "export",
  "run",
  "pause",
  "resume",
  "cancel",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Subcommands actually offered by this process.
 *
 * `run` and the three worker-control commands are all part of the spawn
 * surface: recursion guard 2 (#68, ADR 0004) withholds them inside a worker,
 * because a worker that can pause or cancel workers is a worker that can
 * supervise them.
 */
const WORKER_SURFACE: readonly Subcommand[] = ["run", "pause", "resume", "cancel"];
const ACTIVE_SUBCOMMANDS: readonly Subcommand[] = SUBCOMMANDS.filter(
  (s) => !WORKER_SURFACE.includes(s) || RUN_AVAILABILITY.available,
);

function isSubcommand(value: string): value is Subcommand {
  return (ACTIVE_SUBCOMMANDS as readonly string[]).includes(value);
}

export default function korwfExtension(pi: ExtensionAPI): void {
  // In-memory until the SQLite store (#23) persists ModelAvailability rows.
  // Cap detection (#62) writes into this table; listings read from it.
  const availability = new RouteAvailabilityTable();

  // Live worker runs, so `/korwf pause|resume|cancel` can address one by id
  // (#71). Handles only: global concurrency is a budget cap enforced by the
  // ledger's atomic reservation, never by counting this map.
  const workers = new WorkerRegistry();

  // Session resume/reload/fork/tree reconciliation (#42). Registered before
  // any command so a rewound conversation is reconciled against live
  // repository state before it can ask for anything.
  registerSessionHooks(pi);

  // Model catalog (#56): rebuilt on the two real model-related events Pi
  // exposes (session_start, model_select) — see src/extension/catalog-refresh.ts
  // for why there is no true "registry changed" event and what "refresh"
  // means as a result. `getCatalog` always rebuilds from a fresh read, so a
  // caller (e.g. #57+ model-card consumers, /korwf models) never sees a
  // catalog stale enough to route to a model that no longer exists.
  registerCatalogRefresh(pi, (cwd): CatalogConfig | undefined => {
    const result = loadForProject(cwd);
    return result.ok ? result.config.models : undefined;
  });

  // Opt-in main-session routing (#67; PLAN §3.D "Main session"). Default
  // off (`models.routeMainSession: false`): `requestSwitch` refuses to
  // queue anything, so the user's own session is never re-routed without
  // opting in. When enabled, a queued switch is only ever applied on the
  // next `agent_settled` boundary — not mid-turn, not mid-tool-call, not
  // while another process holds the store lock (`src/storage/lock.ts`).
  registerMainSessionRouting(pi, (cwd) => {
    const result = loadForProject(cwd);
    return result.ok ? { routeMainSession: result.config.models.routeMainSession } : undefined;
  });

  pi.registerCommand("korwf", {
    description: `KorWF workflow commands: /korwf <${ACTIVE_SUBCOMMANDS.join("|")}>`,
    getArgumentCompletions: (prefix: string) => {
      const items = ACTIVE_SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      // Everything this handler says to the user goes through the redactor
      // (#22): a raw `ctx.ui` is never notified below this line, and
      // `guardHandler` redacts anything thrown before Pi sees it.
      const ui = redactedUi(ctx.ui);
      const [sub, ...rest] = args.trim().split(/\s+/);

      if (!sub || !isSubcommand(sub)) {
        // A worker typing `/korwf run` lands here; say why rather than
        // pretending the subcommand was a typo.
        if (sub !== undefined && (WORKER_SURFACE as readonly string[]).includes(sub) && !RUN_AVAILABILITY.available) {
          ui.notify(runRefusalMessage(RUN_AVAILABILITY), "error");
          return;
        }
        ui.notify(`Unknown subcommand. Use: ${ACTIVE_SUBCOMMANDS.join(", ")}`, "warning");
        return;
      }

      await guardHandler(ctx.ui, `/korwf ${sub}`, async (): Promise<void> => {
        switch (sub) {
          case "version": {
            ui.notify(versionMessage(), "info");
            return;
          }
          case "run": {
            // Reachable only when RUN_AVAILABILITY.available; the dispatcher
            // rejects `run` otherwise. Scheduling itself lands in #69+.
            ui.notify(
              "`/korwf run` is not implemented yet; single-worker execution lands with the scheduler.",
              "warning",
            );
            return;
          }
          case "models": {
            const [modelsSub, ...modelsRest] = rest;
            if (modelsSub === "pin") {
              const parsed = parsePinArgs(modelsRest);
              const outcome = parsed.ok ? pinModel(ctx.cwd, parsed.model, parsed.taskKind) : parsed;
              ui.notify(outcome.message, outcome.ok ? "info" : "error");
              return;
            }
            if (modelsSub === "unpin") {
              const parsed = parseUnpinArgs(modelsRest);
              const outcome = "taskKind" in parsed ? unpinModel(ctx.cwd, parsed.taskKind) : parsed;
              ui.notify(outcome.message, outcome.ok ? "info" : "error");
              return;
            }
            const models = ctx.modelRegistry.getAvailable();
            ui.notify(modelsMessage({ models, availability, now: new Date().toISOString() }), "info");
            return;
          }
          case "status": {
            const models = ctx.modelRegistry.getAvailable();
            const now = new Date().toISOString();
            const result = loadForProject(ctx.cwd);
            // No config, or a project that has never run `/korwf plan` (no
            // store file yet): route/cap section only — opening a read-only
            // SQLite handle on a path that does not exist throws, so this
            // checks existence first rather than opening and catching.
            const storageRoot = result.ok ? resolveStorageRoot(ctx.cwd, result.config.storage.path ?? undefined) : null;
            if (!result.ok || storageRoot === null || !existsSync(resolveDatabasePath(storageRoot))) {
              ui.notify(statusReportMessage({ models, availability, now }), "info");
              return;
            }
            const { store } = openStore({ storageRoot, writable: false });
            try {
              const resolved = resolveBoardWorkflow(store);
              const taskRows = resolved.ok ? buildTaskBoard(store, resolved.workflowId) : undefined;
              const ledgerStatus = resolved.ok
                ? openLedger(store, { budgets: result.config.budgets }).status({ workflowId: resolved.workflowId })
                : null;
              ui.notify(
                statusReportMessage({ models, availability, now, ...(taskRows !== undefined ? { taskRows } : {}), ledgerStatus }),
                "info",
              );
            } finally {
              store.close();
            }
            return;
          }
          case "config": {
            const result = loadForProject(ctx.cwd);
            ui.notify(configMessage(result), result.ok ? "info" : "error");
            return;
          }
          case "jev": {
            // Credential status: source, length and fingerprint — never a key.
            ui.notify(jevStatusMessage(loadForProject(ctx.cwd)), "info");
            return;
          }
          case "why":
          case "purge": {
            // Traces and their retention both live in the store (#23); this
            // opens it read-write for `purge` (deletion) and read-only for
            // `why`, so explaining a decision can never mutate anything.
            const result = loadForProject(ctx.cwd);
            if (!result.ok) {
              ui.notify(configMessage(result), "error");
              return;
            }
            const storageRoot = resolveStorageRoot(ctx.cwd, result.config.storage.path ?? undefined);
            const { store } = openStore({ storageRoot, writable: sub === "purge" });
            try {
              ui.notify(
                sub === "why"
                  ? whyMessage(store, rest.join(" "))
                  : purgeMessage(store, result.config, { all: rest.includes("--all") }),
                "info",
              );
            } finally {
              store.close();
            }
            return;
          }
          case "plan": {
            const result = await runPlanIntake(rest.join(" "), {
              cwd: ctx.cwd,
              ui: { input: ctx.ui.input, hasUI: ctx.hasUI },
              sessionId: ctx.sessionManager.getSessionId(),
            });
            ui.notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "tasks":
          case "phases":
          case "approvals":
          case "export": {
            const result = loadForProject(ctx.cwd);
            if (!result.ok) {
              ui.notify(configMessage(result), "error");
              return;
            }
            const storageRoot = resolveStorageRoot(ctx.cwd, result.config.storage.path ?? undefined);
            const { store } = openStore({ storageRoot, writable: false });
            try {
              if (sub === "tasks") {
                const live = readLiveRepoState(ctx.cwd);
                const currentSha = live.kind === "repo" ? live.head : null;
                const outcome = tasksMessage(store, { ...parseTasksArgs(rest), currentSha });
                ui.notify(outcome.message, outcome.ok ? "info" : "error");
              } else if (sub === "phases") {
                const outcome = phasesMessage(store, parsePhasesArgs(rest));
                ui.notify(outcome.message, outcome.ok ? "info" : "error");
              } else if (sub === "approvals") {
                // Read-only: the queue is a view. Answering a question is a
                // separate, explicit act (#49).
                const outcome = approvalsMessage(store, parseApprovalsArgs(rest, new Date().toISOString()));
                ui.notify(outcome.message, outcome.ok ? "info" : "error");
              } else {
                const parsed = parseExportArgs(rest);
                if (!parsed.ok) {
                  ui.notify(parsed.message, "error");
                } else {
                  const outcome = runExport(store, parsed);
                  ui.notify(outcome.message, outcome.ok ? "info" : "error");
                }
              }
            } finally {
              store.close();
            }
            return;
          }
          case "pause":
          case "resume":
          case "cancel": {
            // The registry is per-process and holds only *live* runs; there
            // is nothing to pause before the scheduler (#72) starts one, so
            // this reports "no active workers" rather than pretending.
            const parsed = parseWorkerCommandArgs(rest);
            const outcome =
              sub === "pause"
                ? pauseMessage(workers, parsed)
                : sub === "resume"
                  ? resumeMessage(workers, parsed)
                  : await cancelMessage(workers, parsed);
            ui.notify(outcome.message, outcome.ok ? "info" : "warning");
            return;
          }
          case "disclosure": {
            const result = loadForProject(ctx.cwd);
            if (!result.ok) {
              ui.notify(configMessage(result), "error");
              return;
            }
            const store = createFileDisclosureStore(result.config);
            ui.notify(disclosureMessage(result.config, ctx.cwd, store), "info");
            await ensureDisclosureAccepted(result.config, ctx.cwd, store, ctx.ui, {
              packageVersion: getPackageVersion(),
            });
            return;
          }
        }
      });
    },
  });
}
