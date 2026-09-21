#!/usr/bin/env node
// Creates GitHub issues from the m*.mjs definition files, in dependency order.
// Idempotent: created.json records key -> issue number; re-running skips existing keys.
// Second pass appends "Blocks:" back-links once all numbers are known.
//
// Usage: node scripts/issues/run.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "korallis/KorWF-Pi";
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, "created.json");
const DRY = process.argv.includes("--dry-run");

const MILESTONES = {
  M0: {
    title: "M0 — Approvals and decisions",
    exit: "Human decisions recorded for authorization, key mechanism, pilot repo, budgets, mode, and sandbox (PLAN §11).",
  },
  M1: {
    title: "M1 — Discovery and contracts",
    exit: "Interfaces and boundaries reviewable; config schema drafted; reuse decisions made.",
  },
  M2: {
    title: "M2 — Package and adapter foundation",
    exit: "Loads in an isolated Pi session; offline tests pass; works with no Jev key; failures cannot hang Pi or leak credentials.",
  },
  M3: {
    title: "M3 — Context, planning, phases, durable tasks",
    exit: "A phased plan with checks can be created, revised, resumed, and inspected.",
  },
  M4: {
    title: "M4 — Verification, review, recovery",
    exit: "Unsupported completion is rejected; failures produce bounded recovery or a clear stop.",
  },
  M5: {
    title: "M5 — Model catalog, selection, fallback, single-worker execution",
    exit: "A task executes in isolation with a Jev-chosen model, survives a simulated cap with a visible fallback, and reports accurate state.",
  },
  M6: {
    title: "M6 — Parallel orchestration, integration, unattended operation",
    exit: "Independent tasks run concurrently, integrate safely, and a full phase completes unattended within budget.",
  },
  M7: {
    title: "M7 — Memory, compaction, handoffs, adaptive improvements",
    exit: "Resumed and handed-off work preserves commitments; routing improves from outcomes; policy changes are reversible.",
  },
  M8: {
    title: "M8 — Evaluation, hardening, release",
    exit: "PLAN §10 release criteria satisfied.",
  },
};

const FOOTER = `
---
## Constraints that apply to every issue (AGENTS.md §4)
- No credentials, user-specific paths, or provider names hardcoded in shipped code. Secrets come from env vars or Pi's secrets facility. \`.env*\` stays git-ignored.
- Deterministic checks cannot be waived by Jev, by a worker's claim, or by any tool path. No "test-only" bypasses.
- The product must work with **no Jev key**; every Jev-assisted decision has a deterministic fallback.
- The system never weakens its own permission, allowlist, or spending policy.
- Mocked tests never authorise live requests. Live Jev or model calls need a budget approved on this issue by Lee.
- Development-time model use goes through the \`mac-mini\` provider only, via the product's own allowlist config (PLAN §11) — never hardcoded.

## If your context was compacted
Re-read \`AGENTS.md\`, this issue in full, and the PLAN.md sections quoted above. **This issue is the requirement, not chat history.** Comment \`Starting — <plan>\` before you begin and post progress before any long step. Close via a PR using the template in AGENTS.md §6 with verification output pasted in.
`;

function list(items) {
  return items.map((s) => `- ${s}`).join("\n");
}
function checks(items) {
  return items.map((s) => `- [ ] ${s}`).join("\n");
}

function render(issue, depNums, blockNums) {
  const ms = MILESTONES[issue.milestone];
  const deps = depNums.length ? depNums.map((n) => `#${n}`).join(", ") : "none — this issue is ready to start";
  const blocks = blockNums.length ? blockNums.map((n) => `#${n}`).join(", ") : "none";
  return `**Milestone:** ${ms.title}
**Stage exit criterion:** ${ms.exit}
**Design authority:** \`PLAN.md\` ${issue.planRef} · **Checklist item:** \`TODO.md\` ${issue.todoRef}

## Context
${issue.context.trim()}

## Governing design (quoted from PLAN.md so this issue stands alone)
${issue.plan.trim()}

## Scope
${list(issue.scope)}

## Out of scope
${list(issue.outOfScope ?? ["Anything not listed under Scope. Open a new issue with full context for adjacent work."])}

## Deliverables
${list(issue.deliverables)}

## Acceptance criteria
${checks(issue.acceptance)}

## Verification (run these; paste output in the PR)
${list(issue.verification)}

## Files / modules expected
${list(issue.files)}

## Dependencies
- **Blocked by:** ${deps}
- **Blocks:** ${blocks}
${issue.notes ? `\n## Notes for the implementing agent\n${issue.notes.trim()}\n` : ""}${FOOTER}`;
}

function gh(args) {
  if (DRY) {
    console.log("  gh", args.join(" "));
    return "https://github.com/x/y/issues/0";
  }
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const files = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
  const all = [];
  for (const f of files) {
    const mod = await import(`./${f}.mjs`);
    all.push(...mod.default);
  }

  // Validate
  const keys = new Set();
  for (const i of all) {
    if (keys.has(i.key)) throw new Error(`duplicate key ${i.key}`);
    keys.add(i.key);
    for (const d of i.deps ?? []) {
      if (!keys.has(d)) throw new Error(`${i.key}: dependency ${d} missing or defined later`);
    }
    for (const k of ["title", "milestone", "labels", "planRef", "todoRef", "context", "plan", "scope", "deliverables", "acceptance", "verification", "files"]) {
      if (i[k] === undefined) throw new Error(`${i.key}: missing ${k}`);
    }
    if (!MILESTONES[i.milestone]) throw new Error(`${i.key}: bad milestone`);
  }
  console.log(`${all.length} issue definitions validated`);

  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const tmp = mkdtempSync(join(tmpdir(), "korwf-issues-"));

  // Pass 1: create
  for (const issue of all) {
    if (state[issue.key]) continue;
    const depNums = (issue.deps ?? []).map((k) => state[k]);
    const labels = [...issue.labels, depNums.length ? "blocked" : "agent-ready"];
    const bodyFile = join(tmp, `${issue.key}.md`);
    writeFileSync(bodyFile, render(issue, depNums, []));
    const url = gh([
      "issue", "create", "-R", REPO,
      "-t", issue.title,
      "-F", bodyFile,
      "-m", MILESTONES[issue.milestone].title,
      ...labels.flatMap((l) => ["-l", l]),
    ]);
    const num = Number(url.split("/").pop());
    state[issue.key] = num;
    if (!DRY) writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
    console.log(`#${num}  ${issue.title}`);
    await sleep(1200);
  }

  // Pass 2: back-links
  const blocks = {};
  for (const i of all) for (const d of i.deps ?? []) (blocks[d] ??= []).push(state[i.key]);
  for (const issue of all) {
    const b = blocks[issue.key] ?? [];
    if (!b.length) continue;
    const depNums = (issue.deps ?? []).map((k) => state[k]);
    const bodyFile = join(tmp, `${issue.key}.edit.md`);
    writeFileSync(bodyFile, render(issue, depNums, b));
    gh(["issue", "edit", String(state[issue.key]), "-R", REPO, "-F", bodyFile]);
    console.log(`#${state[issue.key]}  blocks ${b.map((n) => "#" + n).join(", ")}`);
    await sleep(800);
  }
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
