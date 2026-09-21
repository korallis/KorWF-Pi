#!/usr/bin/env node
// Jev decisions for an *agentic* orchestrator (a pi session driving real Herdr agents),
// as opposed to run.mjs's headless batch loop.
//
// Why this exists: "full agentic" must not mean "the agent guesses". Every judgment —
// which issue next, which model, which thinking level, is the issue even answerable —
// goes to Jev and is logged to .orchestrate/decisions.jsonl, exactly as the batch
// orchestrator does. This command exposes those same batteries to a human-driven or
// agent-driven loop, so the decision quality does not depend on which mode is running.
//
// It reuses run.mjs's functions by import; run.mjs only runs its batch loop when invoked
// directly, so importing it here dispatches nothing and takes no lock.
//
//   node scripts/orchestrate/ask-jev.mjs pick-issue [--json]
//   node scripts/orchestrate/ask-jev.mjs select-model <issue> [--json]
//   node scripts/orchestrate/ask-jev.mjs ask <issue> "<question>"   # free-form judgment
//
// Requires JEV_API_KEY (set -a; . ~/Projects/.env; set +a). With no key every command
// still answers, deterministically, and says so — PLAN §2.4: the system must work with
// no Jev key.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Jev, noul, score } from "./jev.mjs";
import {
  profileAndSelect, readyIssues, loadDefs, fetchIssues, parseCriteria, CONFIG, state,
} from "./run.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const JSON_OUT = process.argv.includes("--json");
const [cmd, arg] = process.argv.slice(2).filter((a) => a !== "--json");

const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
const jev = apiKey
  ? new Jev({ apiKey, model: CONFIG.jev.model, logPath: join(ROOT, ".orchestrate/decisions.jsonl"), budgetTokens: CONFIG.jev.tokenBudget })
  : null;

// PLAN §2.4: the system must work with no Jev key. run.mjs's batteries take a Jev object
// and treat a null *answer* as "unavailable, fall back"; they do not expect a null client.
// So pass a stand-in that always answers null, rather than teaching every call site about
// a missing key. Callers then take exactly the same deterministic path they would if the
// budget were exhausted or the circuit breaker were open.
const JEV_OFFLINE = { ask: async () => null, usage: { input_tokens: 0, output_tokens: 0, requests: 0 }, enabled: false };
const jevOrOffline = jev ?? JEV_OFFLINE;

const out = (obj) => {
  if (JSON_OUT) { console.log(JSON.stringify(obj, null, 2)); return; }
  for (const [k, v] of Object.entries(obj)) {
    console.log(`${k.padEnd(14)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
};

function requireJev(what) {
  if (jev) return true;
  console.error(`No Jev key: cannot ask Jev to ${what}. Falling back deterministically — `
    + `say so when you report this decision.`);
  return false;
}

async function pickIssue() {
  const defs = await loadDefs();
  const ready = readyIssues(fetchIssues(), defs);
  if (!ready.length) return out({ ready: 0, note: "nothing ready (all blocked, needs-human, awaiting review, or attempt-limited)" });

  // Readiness and milestone order are deterministic (AGENTS.md §2) and stay in code.
  // Which of the *eligible* issues to take first is a judgment, so Jev makes it.
  if (!requireJev("rank ready issues")) {
    return out({ source: "fallback", pick: ready[0].issue.number, title: ready[0].issue.title, candidates: ready.map((r) => r.issue.number), rule: "first by dependents then number" });
  }
  const questions = {};
  for (const r of ready.slice(0, 8)) {
    questions[`unblocks:${r.issue.number}`] = score(
      { issue: { number: r.issue.number, title: r.issue.title, scope: r.def.scope, dependents: r.dependents },
        question: "How much does completing this issue unblock the rest of the milestone?" },
      ["Isolated: little else depends on it", "Moderate: a few issues build on it", "Foundational: most remaining work waits on it"],
    );
  }
  const a = await jev.ask("pick-issue", {
    milestone: ready[0].issue.milestone,
    candidates: ready.slice(0, 8).map((r) => ({ number: r.issue.number, title: r.issue.title, labels: r.issue.labels, dependents: r.dependents })),
  }, questions, { probe: "pick-issue" });

  if (!a) return out({ source: "fallback", pick: ready[0].issue.number, title: ready[0].issue.title, rule: "jev unavailable" });
  const ranked = ready.slice(0, 8)
    .map((r) => ({ n: r.issue.number, title: r.issue.title, p: a[`unblocks:${r.issue.number}`].score }))
    .sort((x, y) => y.p - x.p);
  out({ source: "jev", pick: ranked[0].n, title: ranked[0].title, ranking: ranked, milestone: ready[0].issue.milestone });
}

async function selectModel(n) {
  const num = Number(n);
  if (!num) { console.error("usage: ask-jev.mjs select-model <issue>"); process.exit(2); }
  const defs = await loadDefs();
  const issues = fetchIssues();
  const issue = issues[num];
  if (!issue) { console.error(`issue #${num} not found`); process.exit(2); }
  const def = defs[issue.key];
  if (!def) { console.error(`no local definition for #${num} (scripts/issues/*.mjs)`); process.exit(2); }

  const attempts = state.attempts[num] ?? [];
  const prev = attempts.at(-1) ?? null;
  // Same battery the batch orchestrator uses, so agentic and batch modes pick alike.
  const sel = await profileAndSelect(jevOrOffline, issue, def, attempts.length + 1, prev);

  const criteria = parseCriteria(issue.body);
  out({
    issue: num,
    title: issue.title,
    model: sel.model,
    thinking: sel.thinking,
    rule: sel.rule,
    profile: sel.profile,
    ranking: sel.ranking.slice(0, 4),
    attempt: attempts.length + 1,
    criteria: criteria.length,
    spawn: `.pi/skills/korwf-worker-delegation/scripts/spawn-pi.sh issue-${num} ${sel.model} ${sel.thinking} --worktree issue-${num}-<slug> --task "issue #${num}"`,
    ...(sel.profile.sufficient !== null && sel.profile.sufficient < 0.25
      ? { STOP: `Jev judges this issue under-specified (p(sufficient)=${sel.profile.sufficient.toFixed(2)}). Do not dispatch; comment on the issue and clarify first.` }
      : {}),
  });
}

async function askFreeForm(n, question) {
  if (!question) { console.error('usage: ask-jev.mjs ask <issue> "<question>"'); process.exit(2); }
  if (!requireJev("answer a free-form judgment")) process.exit(3);
  const issues = fetchIssues();
  const issue = issues[Number(n)];
  const a = await jev.ask("orchestrator-question", {
    issue: issue ? { number: issue.number, title: issue.title, labels: issue.labels, body: (issue.body ?? "").slice(0, 4000) } : { number: n },
    question,
  }, {
    answer: noul(question, { true: "Yes", false: "No" }),
  }, { issue: Number(n) || undefined, probe: "free-form" });
  if (!a) { console.error("Jev unavailable"); process.exit(3); }
  out({ question, p: a.answer.noul, reading: a.answer.noul >= 0.75 ? "yes (confident)" : a.answer.noul <= 0.25 ? "no (confident)" : "uncertain — ask a sharper, more bounded question (SKILL.md §2)" });
}

// Agentic runs must leave the same audit trail as batch runs, or `--review` and `--merge`
// cannot evaluate them: both look up `state.attempts[n]` and require the last attempt to
// be `awaiting-review`. Without this, finishing an issue with a real Herdr agent meant
// hand-editing state.json (done once for #120 — exactly the kind of manual step that
// silently diverges). Model/thinking/rule come from `select-model` so the record is
// identical in shape to one written by run.mjs.
//
//   ask-jev.mjs record-attempt <issue> --model M --thinking T --branch B --pr URL
//                              [--rule TEXT] [--report-file PATH] [--outcome awaiting-review]
function recordAttempt(n) {
  const num = Number(n);
  if (!num) { console.error("usage: ask-jev.mjs record-attempt <issue> --model M --thinking T --branch B --pr URL [--report-file PATH]"); process.exit(2); }
  const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
  const model = argOf("--model"), thinking = argOf("--thinking", "high");
  const branch = argOf("--branch"), pr = argOf("--pr", null);
  const outcome = argOf("--outcome", "awaiting-review");
  const reportFile = argOf("--report-file");
  if (!model || !branch) { console.error("record-attempt requires --model and --branch"); process.exit(2); }

  let report = argOf("--report", "");
  if (reportFile) {
    try { report = readFileSync(reportFile, "utf8"); }
    catch (e) { console.error(`cannot read --report-file ${reportFile}: ${e.message}`); process.exit(2); }
  }
  const statePath = join(ROOT, ".orchestrate/state.json");
  const s = JSON.parse(readFileSync(statePath, "utf8"));
  const list = s.attempts[String(num)] ??= [];
  const now = new Date().toISOString();
  list.push({
    issue: num, attempt: list.length + 1, model, requested: model,
    rule: argOf("--rule", "agentic: jev-selected, herdr agent"),
    thinking, mode: "agentic", branch, started: argOf("--started", now), ended: now,
    outcome, pr, report,
  });
  writeFileSync(statePath, JSON.stringify(s, null, 2));
  console.log(`recorded agentic attempt ${list.length} for #${num} (outcome=${outcome}${pr ? `, pr=${pr}` : ""})`);
  console.log(`next: node scripts/orchestrate/run.mjs --review ${num} && node scripts/orchestrate/run.mjs --merge ${num}`);
}

const cmds = { "pick-issue": () => pickIssue(), "select-model": () => selectModel(arg), "record-attempt": () => recordAttempt(arg), "ask": () => askFreeForm(arg, process.argv.slice(4).filter((x) => x !== "--json").join(" ")) };
if (!cmds[cmd]) {
  console.error("usage: ask-jev.mjs pick-issue | select-model <issue> | record-attempt <issue> --model M --branch B [--pr URL] [--report-file PATH] | ask <issue> \"<question>\"  [--json]");
  process.exit(2);
}
await cmds[cmd]();
if (jev) console.error(`\n[jev usage: ${JSON.stringify(jev.usage)}]`);
