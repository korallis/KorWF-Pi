/**
 * Pi extension entry point for KorWF-Pi (issue #19 Scope).
 *
 * This is the only module that imports `@earendil-works/pi-coding-agent`
 * (docs/adr/0002-source-layout.md). It registers the `/korwf` command
 * namespace with `version`, and the route-aware `models` and `status`
 * listings from issue #125. Later issues add `plan`, `run`, and the rest
 * of the surface described in README.md "Planned user interface".
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

const SUBCOMMANDS = ["version", "models", "status", "config", "disclosure"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export default function korwfExtension(pi: ExtensionAPI): void {
  // In-memory until the SQLite store (#23) persists ModelAvailability rows.
  // Cap detection (#62) writes into this table; listings read from it.
  const availability = new RouteAvailabilityTable();

  pi.registerCommand("korwf", {
    description: `KorWF workflow commands: /korwf <${SUBCOMMANDS.join("|")}>`,
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [sub] = args.trim().split(/\s+/);

      if (!sub || !isSubcommand(sub)) {
        ctx.ui.notify(`Unknown subcommand. Use: ${SUBCOMMANDS.join(", ")}`, "warning");
        return;
      }

      switch (sub) {
        case "version": {
          ctx.ui.notify(versionMessage(), "info");
          return;
        }
        case "models": {
          const models = ctx.modelRegistry.getAvailable();
          ctx.ui.notify(modelsMessage({ models, availability, now: new Date().toISOString() }), "info");
          return;
        }
        case "status": {
          const models = ctx.modelRegistry.getAvailable();
          ctx.ui.notify(statusMessage({ models, availability, now: new Date().toISOString() }), "info");
          return;
        }
        case "config": {
          const result = loadForProject(ctx.cwd);
          ctx.ui.notify(configMessage(result), result.ok ? "info" : "error");
          return;
        }
        case "disclosure": {
          const result = loadForProject(ctx.cwd);
          if (!result.ok) {
            ctx.ui.notify(configMessage(result), "error");
            return;
          }
          const store = createFileDisclosureStore(result.config);
          ctx.ui.notify(disclosureMessage(result.config, ctx.cwd, store), "info");
          await ensureDisclosureAccepted(result.config, ctx.cwd, store, ctx.ui, {
            packageVersion: getPackageVersion(),
          });
          return;
        }
      }
    },
  });
}
