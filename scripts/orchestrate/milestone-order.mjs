// Read-only: ask Jev whether the orchestrator is allowed to work a milestone while an
// EARLIER milestone still has open issues. AGENTS.md §2 says "lowest open milestone
// first", and readyIssues() enforces that only among issues it considers candidates —
// M0 is filtered out beforehand (all its issues are needs-human), so the rule silently
// resolves to M1 without ever asking whether M0 actually gates the later work.
// Usage: node scripts/orchestrate/milestone-order.mjs

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Jev, noul, choice } from "./jev.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "scripts/orchestrate/config.json"), "utf8"));
const gh = (a) => execFileSync("gh", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

const all = JSON.parse(gh(["issue", "list", "--state", "all", "--json", "number,title,state,labels,milestone", "--limit", "300"]));
const byMs = {};
for (const i of all) {
  const m = i.milestone?.title ?? "(none)";
  (byMs[m] ??= []).push(i);
}
const m0 = (byMs[Object.keys(byMs).find((k) => k.startsWith("M0"))] ?? []).filter((i) => i.state === "OPEN");
const plan = readFileSync(join(ROOT, "PLAN.md"), "utf8");

const jev = new Jev({
  apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
  logPath: join(ROOT, ".orchestrate/probe-decisions.jsonl"),
  budgetTokens: CONFIG.budgets?.maxJevTokensPerSession ?? 400_000,
});

const state = {
  m0_open_issues: m0.map((i) => ({
    number: i.number, title: i.title, labels: i.labels.map((l) => l.name),
    body_excerpt: (all.find((x) => x.number === i.number)?.body ?? "").slice(0, 400),
  })),
  milestone_progress: Object.fromEntries(Object.entries(byMs).map(([k, v]) => [k, {
    open: v.filter((i) => i.state === "OPEN").length, closed: v.filter((i) => i.state === "CLOSED").length,
  }])),
  work_done_so_far: "M1 issues #7,#8,#9,#10,#12 are merged. All were documentation/specification work: " +
    "reading Pi and TypeSafe docs, writing ADRs, defining record schemas and a model-registry field set. " +
    "No product code, no live API calls, no spending, no credentials were involved.",
  plan_excerpt: plan.slice(0, 6000),
  agents_rule: "AGENTS.md §2: only take issues labelled agent-ready in the LOWEST open milestone. " +
    "Stages are ordered by dependency; do not start Stage N+1 while Stage N has open issues unless the " +
    "issue explicitly says it is independent.",
};

const a = await jev.ask("milestone-order", state, {
  m0_is_human_only: noul(
    "Are ALL of `m0_open_issues` things that only the repo owner can resolve (approvals, budgets, credentials, authorisation), " +
    "such that no agent could close them by doing work?", {
      true: "Every open M0 issue needs the owner's decision, not agent work",
      false: "At least one M0 issue could be progressed by an agent",
    }),
  m0_blocks_m1: noul(
    "Given `plan_excerpt`, did the M1 documentation work described in `work_done_so_far` actually REQUIRE the M0 approvals to be granted first?", {
      true: "That M1 work should not have happened before M0 was approved",
      false: "The M1 work was safe and useful to do while M0 approvals were pending",
    }),
  violated_rule: noul(
    "Did doing that M1 work violate `agents_rule`?", {
      true: "It broke the lowest-open-milestone rule in substance, not just on paper",
      false: "It is consistent with the rule's intent, because the open M0 items are human approval gates rather than engineering dependencies",
    }),
  m0_blocks_m2: noul(
    "Does the NEXT stage of work (M2: package and adapter foundation — writing actual product code, dependencies, and a package skeleton) " +
    "require the M0 approvals (authorisation to implement, sandbox/dependency permissions, operating mode) to be granted first?", {
      true: "M2 implementation work needs those approvals before it can legitimately start",
      false: "M2 can proceed without them",
    }),
  recommendation: choice("What should the orchestrator do now?", {
    proceed_m2: "Continue autonomously into M2 implementation work; M0 does not gate it",
    stop_and_ask_owner: "Stop and get the owner's M0 approvals before writing product code",
    m1_docs_only: "Only continue with remaining documentation/specification work, not implementation",
  }),
}, { probe: "milestone-order" });

if (!a) { console.log("jev unavailable"); process.exit(1); }
console.log(`M0 open: ${m0.map((i) => "#" + i.number).join(" ")}\n`);
for (const [k, v] of Object.entries(a)) {
  console.log(`  ${k.padEnd(20)} ${v.noul !== undefined ? v.noul.toFixed(2) : v.choice}`);
}
console.log(`\njev usage: ${JSON.stringify(jev.usage)}`);
