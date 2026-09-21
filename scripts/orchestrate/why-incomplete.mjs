// Read-only: ask Jev WHICH part of an issue's scope a PR fails to deliver, and
// whether the shortfall is real or an artefact of the question's framing.
// The merge review's `complete` is a single existential over the whole scope, so a
// low score does not say what is missing. This decomposes it.
// Usage: node scripts/orchestrate/why-incomplete.mjs <issue> <pr>

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Jev, noul, choice } from "./jev.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "scripts/orchestrate/config.json"), "utf8"));
const [issueNo, prNo] = process.argv.slice(2);
const gh = (a) => execFileSync("gh", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

const issue = JSON.parse(gh(["issue", "view", issueNo, "--json", "number,title,body"]));
const pr = JSON.parse(gh(["pr", "view", prNo, "--json", "number,title,body,files"]));
const diff = gh(["pr", "diff", prNo]).slice(0, 60_000);

const criteria = (issue.body.match(/## Acceptance criteria\n([\s\S]*?)\n## /)?.[1] ?? "")
  .split("\n").filter((l) => /^\s*- \[/.test(l)).map((l) => l.replace(/^\s*- \[.\]\s*/, "").trim());

const jev = new Jev({
  apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
  logPath: join(ROOT, ".orchestrate/probe-decisions.jsonl"),
  budgetTokens: CONFIG.budgets?.maxJevTokensPerSession ?? 400_000,
});

const state = {
  issue: { number: issue.number, title: issue.title, acceptance: criteria, body: issue.body.slice(0, 5000) },
  pr: { title: pr.title, body: pr.body.slice(0, 6000) },
  changed_files: pr.files.map((f) => `${f.path} +${f.additions} -${f.deletions}`).join("\n"),
  diff,
};

const q = {};
criteria.forEach((c, i) => {
  q[`c${i}`] = noul({ criterion: c, question: "Judging from `diff` and `changed_files`, is this specific criterion fully delivered?" }, {
    true: "The diff contains everything this criterion requires",
    false: "Something this criterion requires is missing from the diff",
  });
});
q.scope_beyond_criteria = noul(
  "Does `issue.body` demand deliverables BEYOND its listed `acceptance` items that `diff` does not provide?", {
    true: "The issue body requires additional work not covered by the acceptance list and not in the diff",
    false: "The acceptance list covers what the issue asks for",
  });
q.docs_only_ok = noul(
  "This is a specification/decision issue. Is a documentation-only change (ADRs, AGENTS.md, TODO.md) the CORRECT and complete form of delivery here, with no code expected?", {
    true: "Docs-only is the right deliverable for this issue",
    false: "Code or tests were also expected",
  });
q.blocker = choice("If this PR is not mergeable as-is, what is the single most accurate reason?", {
  nothing_missing: "Nothing is missing; it is complete as a specification issue",
  missing_criterion: "A listed acceptance criterion is genuinely not delivered",
  missing_scope_item: "Something the issue body requires beyond the criteria is absent",
  expected_code: "The issue expected code or tests that are not present",
});

const a = await jev.ask("why-incomplete", state, q, { issue: issue.number, pr: pr.number });
if (!a) { console.log("jev unavailable"); process.exit(1); }

console.log(`issue #${issue.number} / PR #${pr.number}  criteria=${criteria.length}  diff=${diff.length}B\n`);
criteria.forEach((c, i) => console.log(`  c${i} ${a[`c${i}`].noul.toFixed(2)}  ${c}`));
console.log(`\n  scope_beyond_criteria: ${a.scope_beyond_criteria.noul.toFixed(2)}`);
console.log(`  docs_only_ok:          ${a.docs_only_ok.noul.toFixed(2)}`);
console.log(`  blocker:               ${a.blocker.choice}`);
console.log(`\njev usage: ${JSON.stringify(jev.usage)}`);
