// Jev-driven triage of `needs-human` issues.
//
// `needs-human` is currently applied by the orchestrator for two very different
// reasons and never removed (nothing in run.mjs calls --remove-label):
//   (a) genuine human authority   — spend, credentials, publishing, irreversible acts,
//                                   or a decision only the repo owner can make;
//   (b) the orchestrator gave up  — attempt limit hit, gate false-positive, or the
//                                   issue text was under-specified for a worker.
// (b) is agent-recoverable. This tool asks Jev to separate them and to pick the
// approach that will actually work, rather than escalating everything to Lee.
//
// Read-only by default. Pass --apply to act on the classification.
// Usage: node scripts/orchestrate/triage.mjs [--apply] [issue...]

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Jev, noul, choice, score } from "./jev.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "scripts/orchestrate/config.json"), "utf8"));
const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);

function gh(args) {
  return execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
}
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const statePath = join(ROOT, ".orchestrate/state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { attempts: {} };

const key = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
const jev = new Jev({
  apiKey: key,
  logPath: join(ROOT, ".orchestrate/decisions.jsonl"),
  budgetTokens: CONFIG.budgets?.maxJevTokensPerSession ?? 400_000,
});

const issues = JSON.parse(gh([
  "issue", "list", "--state", "open", "--label", "needs-human",
  "--json", "number,title,body,labels,milestone", "--limit", "60",
]));

const targets = ONLY.length ? issues.filter((i) => ONLY.includes(i.number)) : issues;
log(`triaging ${targets.length} needs-human issue(s)`);

const results = [];
for (const i of targets) {
  const labels = i.labels.map((l) => l.name);
  const attempts = state.attempts?.[i.number] ?? [];
  const last = attempts.at(-1) ?? null;

  // Why did it get the label? Give Jev the real history, not a summary.
  const st = {
    issue: { number: i.number, title: i.title, body: (i.body ?? "").slice(0, 6000), labels, milestone: i.milestone?.title ?? null },
    orchestrator_history: attempts.map((a) => ({
      attempt: a.attempt, model: a.model, outcome: a.outcome,
      feedback: (a.feedback ?? "").slice(0, 1500),
      merge_review: a.mergeReview ? { hard: a.mergeReview.hard, soft: a.mergeReview.soft, verdict: a.mergeReview.verdict } : null,
    })),
    attempt_limit: CONFIG.workers.maxAttemptsPerIssue,
    policy: {
      human_authority_rule:
        "Only these genuinely require the repo owner: authorising spend or live-API budgets; " +
        "providing or rotating credentials; publishing/releasing/tagging; irreversible or " +
        "destructive acts; granting permissions; choosing a product direction the written " +
        "PLAN.md does not already settle. Everything else — under-specification, a failed " +
        "gate, an exhausted attempt budget, a flaky check, a bad worker report — is the " +
        "orchestrator's own problem to solve.",
    },
  };

  const a = await jev.ask("triage", st, {
    needs_owner: noul(
      "Under `policy.human_authority_rule`, does resolving this issue REQUIRE the repo owner personally — " +
      "as opposed to being something a capable agent could resolve by reading PLAN.md, the issue, and the code?",
      {
        true: "It needs the owner's authority: money, credentials, publishing, irreversible acts, or an unsettled product decision",
        false: "An agent can resolve it; the label reflects an orchestrator failure or under-specification",
      }),
    label_was_giveup: noul(
      "Does `orchestrator_history` show the label came from the orchestrator giving up (attempt limit, gate " +
      "failure, merge-review block) rather than from a deliberate finding that owner authority is required?",
      {
        true: "The label records an orchestrator failure or exhausted budget",
        false: "The label records a genuine need for the owner, or there is no such history",
      }),
    underspecified: noul(
      "Is `issue.body` too under-specified for a competent worker to implement without inventing product decisions?",
      {
        true: "Key acceptance criteria or scope are missing or ambiguous in a way an agent cannot settle from PLAN.md",
        false: "The issue states enough to implement and verify",
      }),
    approach: choice(
      "What is the single best next action for an autonomous orchestrator on this issue?",
      {
        retry_worker: "Clear the label and re-dispatch to a worker, possibly with a better model or a sharper handoff",
        fix_report_then_merge: "The work itself is sound but its PR body or verification evidence is wrong; have a worker correct the evidence, then merge",
        agent_can_decide: "This is a decision issue an agent can settle from PLAN.md and write up, without the owner",
        needs_owner_input: "Genuinely requires the repo owner; leave the label and summarise for them",
        close_obsolete: "No longer applicable; close it",
      }),
    confidence: score(
      "How confident should the orchestrator be acting on `approach` without checking with the owner first?",
      [
        "Low: ambiguous, ask the owner",
        "Moderate: act, but report the action clearly afterwards",
        "High: act autonomously; this is routine orchestration",
      ]),
  }, { issue: i.number });

  if (!a) { log(`#${i.number}: Jev unavailable — leaving label (fail closed)`); continue; }

  const r = {
    number: i.number, title: i.title, labels,
    needs_owner: a.needs_owner.noul,
    giveup: a.label_was_giveup.noul,
    underspecified: a.underspecified.noul,
    approach: a.approach.choice,
    confidence: a.confidence.score,
  };
  results.push(r);
  log(`#${r.number} needs_owner=${r.needs_owner.toFixed(2)} giveup=${r.giveup.toFixed(2)} ` +
      `underspec=${r.underspecified.toFixed(2)} → ${r.approach} (confidence ${r.confidence.toFixed(2)})`);
}

// Deterministic policy over Jev's judgment. risk:high always keeps the label:
// AGENTS.md §4 says high-risk actions need explicit approval regardless of mode.
console.log("\n=== triage summary ===");
const release = [];
for (const r of results) {
  const riskHigh = r.labels.includes("risk:high");
  const canRelease = !riskHigh && r.needs_owner < 0.5 && r.approach !== "needs_owner_input" && r.confidence >= 0.5;
  console.log(
    `#${String(r.number).padEnd(4)} ${canRelease ? "RELEASE" : "KEEP   "} ${r.approach.padEnd(22)} ` +
    `needs_owner=${r.needs_owner.toFixed(2)} conf=${r.confidence.toFixed(2)}${riskHigh ? "  [risk:high → owner]" : ""}`);
  if (canRelease) release.push(r);
}
console.log(`\n${release.length} of ${results.length} can proceed without the owner.`);

if (APPLY) {
  for (const r of release) {
    gh(["issue", "comment", String(r.number), "-b",
      `Orchestrator triage: removing \`needs-human\`.\n\n` +
      `Jev judged this agent-resolvable (p(needs owner)=${r.needs_owner.toFixed(2)}, ` +
      `p(label was orchestrator give-up)=${r.giveup.toFixed(2)}, confidence=${r.confidence.toFixed(2)}). ` +
      `Planned approach: \`${r.approach}\`.\n\n` +
      `The label was originally added because the orchestrator hit a limit or a gate, not because ` +
      `owner authority is required. Raw decision in \`.orchestrate/decisions.jsonl\`.`]);
    gh(["issue", "edit", String(r.number), "--remove-label", "needs-human"]);
    log(`#${r.number}: needs-human removed → ${r.approach}`);
  }
}

console.log(`\njev usage: ${JSON.stringify(jev.usage)}`);
