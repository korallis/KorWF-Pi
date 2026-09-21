/**
 * Pi extension entry point for KorWF-Pi (issue #19 Scope).
 *
 * This is the only module that imports `@earendil-works/pi-coding-agent`
 * (docs/adr/0002-source-layout.md). It registers the `/korwf` command
 * namespace with a single subcommand so far: `version`. Later issues add
 * `plan`, `run`, `status`, and the rest of the surface described in
 * README.md "Planned user interface".
 *
 * Every command, tool, and storage path this package registers is
 * namespaced `korwf` (PLAN §3.J; AGENTS.md constraint).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { versionMessage } from "./commands/version.ts";

const SUBCOMMANDS = ["version"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export default function korwfExtension(pi: ExtensionAPI): void {
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
      }
    },
  });
}
