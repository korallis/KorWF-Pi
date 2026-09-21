#!/usr/bin/env node
// Guard: orchestration code must never carve panes out of the user's tab.
//
// Why this file exists. `herdrSurface()` in run.mjs used `herdr pane split --current`
// to give each headless worker a visible pane. `--current` is whichever pane the
// orchestrator was launched from — in practice the user's — so with
// `workers.concurrency > 1` every dispatch split his layout again. The rule had been
// written in the delegation skills for weeks and was still violated, because a skill
// governs the agent, not the automation the agent starts. Hence a check, not a
// paragraph.
//
// Run: node scripts/orchestrate/check-layout.mjs   (exit 0 = clean, 1 = violation)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// Directories whose code may run while the user is working in his own tab.
const SCAN_DIRS = ["scripts/orchestrate", "src/workers", "src/extension"];
const SCAN_EXT = /\.(mjs|js|ts|tsx|sh)$/;

const RULES = [
  {
    id: "pane-split-current",
    // `--current` resolves to the caller's pane. Any long-lived surface must instead
    // open the worker's own worktree Space (nesting is by git worktree identity).
    re: /pane[\s"',\]]+split[\s\S]{0,120}?--current/,
    msg: "`herdr pane split --current` splits the user's tab. Open the worker's worktree "
       + "Space instead (`herdr worktree open --path <dir>`), which nests under the project.",
  },
  {
    id: "tab-close",
    // Closing a tab kills every agent inside it, including ones we do not own.
    re: /["'\s]tab["'\s,\]]+.{0,20}["']close["']|herdr\s+tab\s+close/,
    msg: "Closing a tab kills every agent inside it. Close only a Space you created "
       + "(`workspace close`) or your own pane (`pane close`).",
  },
  {
    id: "server-stop",
    re: /herdr[\s"',\]]+server[\s"',\]]+stop/,
    msg: "`herdr server stop` kills every agent on the machine. Never scripted.",
  },
];

let violations = 0;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (SCAN_EXT.test(e)) yield p;
  }
}

const SELF = join(ROOT, "scripts/orchestrate/check-layout.mjs");

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    if (file === SELF) continue; // this file necessarily quotes the patterns it bans
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Comments are how we explain the rule; only flag executable code.
      const code = line.replace(/^\s*(\/\/|#|\*).*$/, "");
      for (const rule of RULES) {
        if (rule.re.test(code)) {
          console.error(`${rel}:${i + 1}: [${rule.id}] ${rule.msg}\n    ${line.trim()}`);
          violations++;
        }
      }
    });
  }
}

if (violations) {
  console.error(`\ncheck-layout: ${violations} violation(s). See docs/adr/0004-worker-interface.md `
    + `"Worker visibility" and ~/.pi/agent/skills/herdr-pi-delegation/SKILL.md §0 rules 8-9.`);
  process.exit(1);
}
console.log("check-layout: clean");
