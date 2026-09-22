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
import { modelsMessage, statusMessage } from "./commands/models.ts";
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
import { readLiveRepoState } from "../git/revision.ts";
import { registerSessionHooks } from "./session-hooks.ts";
import { registerCatalogRefresh } from "./catalog-refresh.ts";
import type { CatalogConfig } from "../models/catalog.ts";

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
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export default function korwfExtension(pi: ExtensionAPI): void {
  // In-memory until the SQLite store (#23) persists ModelAvailability rows.
  // Cap detection (#62) writes into this table; listings read from it.
  const availability = new RouteAvailabilityTable();

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

  pi.registerCommand("korwf", {
    description: `KorWF workflow commands: /korwf <${SUBCOMMANDS.join("|")}>`,
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      // Everything this handler says to the user goes through the redactor
      // (#22): a raw `ctx.ui` is never notified below this line, and
      // `guardHandler` redacts anything thrown before Pi sees it.
      const ui = redactedUi(ctx.ui);
      const [sub, ...rest] = args.trim().split(/\s+/);

      if (!sub || !isSubcommand(sub)) {
        ui.notify(`Unknown subcommand. Use: ${SUBCOMMANDS.join(", ")}`, "warning");
        return;
      }

      await guardHandler(ctx.ui, `/korwf ${sub}`, async (): Promise<void> => {
        switch (sub) {
          case "version": {
            ui.notify(versionMessage(), "info");
            return;
          }
          case "models": {
            const models = ctx.modelRegistry.getAvailable();
            ui.notify(modelsMessage({ models, availability, now: new Date().toISOString() }), "info");
            return;
          }
          case "status": {
            const models = ctx.modelRegistry.getAvailable();
            ui.notify(statusMessage({ models, availability, now: new Date().toISOString() }), "info");
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
