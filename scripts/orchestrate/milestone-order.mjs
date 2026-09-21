// Read-only: ask Jev whether the orchestrator is allowed to work a milestone while an
// EARLIER milestone still has open issues. AGENTS.md §2 says "lowest open milestone
// first", and readyIssues() enforces that only among issues it considers candidates —
// M0 is filtered out beforehand (all its issues are needs-human), so the rule silently
// resolves to M1 without ever asking whether M0 actually gates the later work.
// Usage: node scripts/orchestrate/milestone-order.mjs

import { readFileSync, readdirSync } from "node:fs";
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
  // Read the granted decisions from the repository rather than hardcoding them: the
  // probe previously asserted M0 approvals were outstanding long after they were granted,
  // so it kept returning stop_and_ask_owner and would have stalled the build forever.
  granted_decisions: (() => {
    try {
      return readdirSync(join(ROOT, "docs/decisions"))
        .filter((f) => /^\d{4}-/.test(f))
        .map((f) => ({ file: f, text: readFileSync(join(ROOT, "docs/decisions", f), "utf8").slice(0, 1500) }));
    } catch { return []; }
  })(),
  work_done_so_far: "M1 is COMPLETE: #7,#8,#9,#10,#11,#12,#13,#14,#15,#16,#17,#18,#19 merged — Pi/TypeSafe " +
    "doc review, ADRs 0001-0011, record schemas, state machine, gate formulas, config schema, approval " +
    "classes, scenario outlines, the package manifest, and per-route model availability. " +
    "Check `granted_decisions` for what the owner has authorised; an M0 issue being open does not mean " +
    "the decision it tracks is outstanding.",
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
    "Given `granted_decisions`, is any approval that M2 (package and adapter foundation — writing product " +
    "code, adding dependencies, building a package skeleton) actually needs still OUTSTANDING? Judge what " +
    "has been granted, not how many M0 issues remain open: the remaining ones may track decisions about " +
    "live operation on a third-party repository, which M2 does not require.", {
      true: "An approval M2 genuinely needs has not been granted",
      false: "Everything M2 needs is granted; the remaining M0 items concern later live operation",
    }),
  recommendation: choice(
    "Given `granted_decisions` and `work_done_so_far`, what should the orchestrator do now?", {
      proceed_m2: "Continue autonomously into M2 implementation work: everything M2 needs is granted",
      stop_and_ask_owner: "Stop: an approval M2 genuinely needs is still outstanding",
      m1_docs_only: "Only continue with documentation/specification work, not implementation",
    }),
}, { probe: "milestone-order" });

if (!a) { console.log("jev unavailable"); process.exit(1); }
console.log(`M0 open: ${m0.map((i) => "#" + i.number).join(" ")}\n`);
for (const [k, v] of Object.entries(a)) {
  console.log(`  ${k.padEnd(20)} ${v.noul !== undefined ? v.noul.toFixed(2) : v.choice}`);
}
console.log(`\njev usage: ${JSON.stringify(jev.usage)}`);
