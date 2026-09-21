#!/usr/bin/env node
// Bootstrap orchestrator: builds KorWF-Pi from its own issue tracker using the
// responsibility split in PLAN.md §1 — code owns scheduling/permissions/budgets,
// Jev supplies narrow judgments (task profile, model ranking, evidence-gap
// detection), Pi worker processes on the mac-mini allowlist write the code.
//
// This is development tooling (PLAN §11), not the product. It is deliberately
// small; the product replaces it from Stage 5 onward.
//
// Usage:
//   node scripts/orchestrate/run.mjs [--dry-run] [--once] [--issue N] [--max N]
//
// Env: JEV_API_KEY (or TYPESAFE_API_KEY) from ~/Projects/.env — never passed to workers.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Jev, noul, choice, score } from "./jev.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CONFIG = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"));
const STATE_DIR = join(ROOT, ".orchestrate");
const STATE_PATH = join(STATE_DIR, "state.json");
const LOCK_PATH = join(STATE_DIR, "lock");
const LOG_PATH = join(STATE_DIR, "orchestrator.log");
const ISSUE_KEYS = JSON.parse(readFileSync(join(ROOT, "scripts/issues/created.json"), "utf8"));
const KEY_BY_NUMBER = Object.fromEntries(Object.entries(ISSUE_KEYS).map(([k, n]) => [n, k]));

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const DRY = flag("--dry-run");
const ONCE = flag("--once");
const ONLY_ISSUE = opt("--issue") ? Number(opt("--issue")) : null;
const MAX_RUNS = opt("--max") ? Number(opt("--max")) : CONFIG.budgets.maxWorkerRunsPerSession;
// Re-admit issues parked as `orchestrator-stuck` (attempts exhausted, but Jev judged
// them agent-resolvable) with a fresh attempt budget.
const RETRY_STUCK = flag("--retry-stuck");
const MERGE = opt("--merge") ? Number(opt("--merge")) : null; // merge-review an awaiting-review issue's PR; merge if it passes
const REVIEW = opt("--review") ? Number(opt("--review")) : null; // re-run gate on the last attempt of an issue without a new worker run
const UNATTENDED = flag("--unattended");

// Batch dispatch must be a deliberate choice, not muscle memory.
//
// This script's workers are headless subprocesses: invisible in Herdr's Agents panel,
// unsteerable, and unable to ask a question, so one that meets an ambiguity guesses in
// silence. The normal way to build this repo is for the orchestrating pi session to spawn
// *real* pi agents (ORCHESTRATOR-PLAYBOOK.md). On #14 batch mode burnt six attempts and
// ~400k tokens writing nothing; one real agent then finished the issue and opened PR #120.
//
// Typing `node run.mjs` out of habit is the actual failure mode — it has happened
// repeatedly, including immediately after the playbook was written. So dispatching now
// requires saying so. --review, --merge and --dry-run are unaffected: they run no workers.
// Only applies to direct invocation: importers (ask-jev.mjs) reuse the Jev batteries and
// dispatch nothing, so the guard must not fire on them.
const DIRECT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (DIRECT && !DRY && !MERGE && !REVIEW && !UNATTENDED) {
  console.error(`
run.mjs dispatches HEADLESS workers (batch mode). They never appear in Herdr's Agents
panel, cannot be steered, and cannot ask a question.

If Lee is watching, or you are orchestrating interactively, this is the wrong tool:
  .pi/skills/jev-orchestration/ORCHESTRATOR-PLAYBOOK.md
  node scripts/orchestrate/ask-jev.mjs select-model <n>
  .pi/skills/korwf-worker-delegation/scripts/spawn-pi.sh issue-<n> <model> <thinking> \\
      --worktree issue-<n>-<slug> --task "issue #<n>"

If you really do want an unattended batch queue, pass --unattended.
Review and merge do not need it: --review <n>, --merge <n>, --dry-run.
`);
  process.exit(2);
}

mkdirSync(STATE_DIR, { recursive: true });
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_PATH, line + "\n");
};

// ---------- state ----------
const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { attempts: {}, caps: {}, sessionRuns: 0, sessionTokens: 0 };
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const { pid, at } = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) throw new Error(`orchestrator already running (pid ${pid} since ${at})`);
    log(`stale lock from pid ${pid}; taking over`);
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const release = () => { try { if (existsSync(LOCK_PATH)) execFileSync("rm", ["-f", LOCK_PATH]); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
}

// ---------- gh / git helpers ----------
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o }).trim();
const gh = (a, o) => sh("gh", [...a, "-R", CONFIG.repo], o);

function fetchIssues() {
  const raw = gh(["issue", "list", "--state", "all", "--limit", "500", "--json",
    "number,title,state,labels,milestone,body"]);
  const list = JSON.parse(raw).map((i) => ({
    ...i,
    labels: i.labels.map((l) => l.name),
    milestone: i.milestone?.title ?? "",
    key: KEY_BY_NUMBER[i.number],
  }));
  return Object.fromEntries(list.map((i) => [i.number, i]));
}

async function loadDefs() {
  const defs = {};
  // `prd` holds issues derived from docs/PRD.md rather than a PLAN stage. They carry a
  // `milestone` like any other def, so ordering is unaffected; without this they exist
  // only on GitHub and readyIssues()/select-model skip them for want of a definition.
  for (const f of ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "prd"]) {
    const mod = await import(`../issues/${f}.mjs`);
    for (const d of mod.default) defs[d.key] = d;
  }
  return defs;
}

function parseCriteria(body) {
  const m = body.match(/## Acceptance criteria\n([\s\S]*?)\n## /);
  if (!m) return [];
  return m[1].split("\n").filter((l) => /^- \[[ x]\]/.test(l)).map((l) => l.replace(/^- \[[ x]\] /, "").trim());
}
function parseVerification(body) {
  const m = body.match(/## Verification[^\n]*\n([\s\S]*?)\n## /);
  if (!m) return [];
  return m[1].split("\n").filter((l) => l.startsWith("- `")).map((l) => l.replace(/^- `([^`]*)`.*/, "$1"));
}

// ---------- readiness (deterministic) ----------
function readyIssues(issues, defs) {
  const running = new Set(Object.values(state.attempts).flat().filter((a) => a.outcome === "running").map((a) => a.issue));
  const out = [];
  for (const i of Object.values(issues)) {
    if (i.state !== "OPEN") continue;
    if (ONLY_ISSUE && i.number !== ONLY_ISSUE) continue;
    if (i.labels.includes("needs-human")) continue;
    if (running.has(i.number)) continue;
    // `orchestrator-stuck` means attempts ran out but Jev judged it agent-resolvable.
    // It is eligible again once RETRY_STUCK raises the per-issue attempt budget.
    if (i.labels.includes("orchestrator-stuck") && !RETRY_STUCK) continue;
    const d = defs[i.key];
    if (!d) continue;
    const blockers = d.deps.map((k) => issues[ISSUE_KEYS[k]]).filter((b) => b && b.state !== "CLOSED");
    if (blockers.length) continue;
    const attempts = state.attempts[i.number] ?? [];
    const cap = CONFIG.workers.maxAttemptsPerIssue + (RETRY_STUCK && i.labels.includes("orchestrator-stuck") ? CONFIG.workers.maxAttemptsPerIssue : 0);
    // A `truncated` attempt produced no work and no usable signal: the turn hit the
    // output-token ceiling before its tool call. Counting it would let a harness limit
    // burn an issue's whole budget (it burnt six on #14). Bounded separately so a
    // persistently truncating issue still cannot loop forever.
    const truncated = attempts.filter((a) => a.outcome === "truncated").length;
    const real = attempts.length - truncated;
    if (truncated >= cap) continue; // every attempt truncating = a real problem, stop
    if (real >= cap) continue;
    if (attempts.some((a) => a.outcome === "awaiting-review")) continue; // PR open, waiting on Lee
    const dependents = Object.values(defs).filter((x) => x.deps.includes(i.key)).length;
    out.push({ issue: i, def: d, dependents });
  }
  // AGENTS.md §2: lowest open milestone first (M0 is human-only and excluded above).
  const stageOf = (i) => Number(i.milestone.match(/^M(\d)/)?.[1] ?? 9);
  const lowest = Math.min(...out.map((o) => stageOf(o.issue)), 9);
  return out.filter((o) => stageOf(o.issue) === lowest).sort((a, b) => b.dependents - a.dependents || a.issue.number - b.issue.number);
}

// ---------- Jev decisions ----------
function availableModels(now = Date.now()) {
  return CONFIG.allowlist.models.filter((m) => !(state.caps[m] && new Date(state.caps[m]).getTime() > now));
}

async function profileAndSelect(jev, issue, def, attempt, prev) {
  const candidates = availableModels();
  const taskState = {
    title: issue.title,
    milestone: issue.milestone,
    labels: issue.labels,
    context: def.context.trim(),
    scope: def.scope,
    acceptance: def.acceptance,
    files: def.files,
    previous_attempt: prev ? { model: prev.model, outcome: prev.outcome, feedback: prev.feedback ?? null } : null,
  };
  const questions = {
    domain: choice("What kind of work does this task mainly require?", {
      spec_docs: "Writing specifications, ADRs, tables, or documentation; little or no code",
      implementation: "Writing or changing TypeScript source with tests",
      testing: "Mainly writing tests, fixtures, or evaluation harnesses",
      infra: "Toolchain, packaging, CI, storage, or process management",
      security: "Permission boundaries, secret handling, or adversarial hardening",
    }),
    depth: score("How much reasoning depth does the task need?", [
      "Mechanical: follow clear instructions, no design decisions",
      "Standard: ordinary feature work with a few local design decisions",
      "Deep: novel design, subtle concurrency, security, or many interacting constraints",
    ]),
    context_size: score("How much of the repository and docs must the agent hold in context at once?", [
      "Small: a few files",
      "Medium: a module and its tests",
      "Large: many modules or long external documents",
    ]),
    sufficient: noul("Does the issue give enough information for a capable coding agent to complete it without asking the user questions?", {
      true: "Scope, acceptance criteria, and constraints are concrete and self-contained",
      false: "Key decisions are missing and would require guessing or asking",
    }),
  };
  for (const m of candidates) {
    questions[`adequate:${m}`] = noul(
      { model_card: CONFIG.cards[m] ?? "unrated", question: "Is the model described in `model_card` an adequate choice to complete this task well?" },
      { true: "The model's known aptitudes and limits fit the task's domain, depth, and context needs", false: "A mismatch in aptitude, context window, or reliability makes it a poor choice" },
    );
  }
  const answers = await jev.ask("select", taskState, questions, { issue: issue.number, attempt });

  const profile = answers
    ? { domain: answers.domain.choice, depth: answers.depth.score, contextSize: answers.context_size.score, sufficient: answers.sufficient.noul, source: "jev" }
    : { domain: "unknown", depth: 1, contextSize: 1, sufficient: null, source: "fallback" };

  let model, rule, ranking = [];
  if (answers) {
    ranking = candidates.map((m) => ({ model: m, p: answers[`adequate:${m}`].noul })).sort((a, b) => b.p - a.p);
    const best = ranking[0];
    if (best && best.p >= 0.5) { model = best.model; rule = `jev p=${best.p.toFixed(2)}`; }
    else if (best) { rule = "jev: none adequate"; }
  }
  if (!model) {
    model = CONFIG.staticFallbackOrder.find((m) => candidates.includes(m)) ?? candidates[0];
    rule = rule ? `${rule} → static` : "static (jev unavailable)";
  }
  if (prev && prev.model === model && prev.outcome === "capped") {
    // never immediately reuse a model that just capped
    model = ranking.find((r) => r.model !== prev.model)?.model ?? CONFIG.staticFallbackOrder.find((m) => m !== prev.model && candidates.includes(m));
    rule += " (avoid capped)";
  }
  // A model that has already failed this issue twice should not get a third go at it.
  // Jev ranks the model against the *task*, which does not change between attempts, so
  // it keeps returning the same top pick while the evidence says that pick is not
  // working. Observed on #14: three consecutive claude-fable-5-1 attempts each stopped
  // after ~67k tokens with a 53-83 character report and no fenced JSON block, writing no
  // files; Jev agreed a different family should be tried (`try_different_family` 0.81).
  // Deterministic rather than Jev-gated: it is an evidence count, not a judgment, and it
  // must also hold when Jev is unavailable.
  const repeatedFailures = (prevAttempts) => prevAttempts
    .filter((a) => a.model === model && ["gap", "timeout", "error", "truncated"].includes(a.outcome)).length;
  const priorAttempts = state.attempts[issue.number] ?? [];
  if (repeatedFailures(priorAttempts) >= 2) {
    const family = (m) => m.split(/[-.]/)[0]; // claude-*, gpt-*, kimi-*, zai-*, grok-*
    const failed = model;
    const alt = ranking.find((r) => r.model !== failed && family(r.model) !== family(failed) && r.p >= 0.5)
      ?? ranking.find((r) => r.model !== failed)
      ?? { model: CONFIG.staticFallbackOrder.find((m) => m !== failed && candidates.includes(m)) };
    if (alt?.model) {
      model = alt.model;
      rule += ` (${failed} failed \u00d72 \u2192 different family)`;
    }
  }
  const thinking = profile.depth >= 1.5 ? "high" : profile.depth >= 0.75 ? "medium" : "low";
  return { profile, model, rule, ranking, thinking };
}

function branchDiff(dir) {
  try {
    const stat = sh("git", ["diff", "--stat", "origin/main...HEAD"], { cwd: dir });
    const diff = sh("git", ["diff", "origin/main...HEAD", "--", ".", ":!package-lock.json", ":!scripts/issues/created.json"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    return { stat, diff: diff.length > 60_000 ? diff.slice(0, 60_000) + "\n[... diff truncated ...]" : diff };
  } catch { return { stat: "", diff: "" }; }
}

async function evidenceGap(jev, issue, criteria, report, checks, dir) {
  const { stat, diff } = branchDiff(dir);
  const st = {
    acceptance_criteria: criteria,
    deterministic_checks: checks,
    changed_files: stat,
    actual_changes_diff: diff,
    worker_final_report: report.slice(-4000),
  };
  const q = {
    overclaims: noul("Does `worker_final_report` claim work that is not present in `actual_changes_diff`, or verification results that `deterministic_checks` contradict?", {
      true: "The report describes files, sections, tests, or results that the diff and checks do not contain",
      false: "The report's claims are all visible in the diff or consistent with the checks",
    }),
  };
  criteria.forEach((c, i) => {
    q[`c${i}`] = noul({ criterion: c, question: "Judging primarily from `actual_changes_diff` (the real work) and `deterministic_checks`, and treating `worker_final_report` only as a guide to where to look, has `criterion` been met?" }, {
      true: "The diff contains what the criterion requires",
      false: "The diff is missing, incomplete, or contradicts what the criterion requires",
    });
  });
  const a = await jev.ask("gap", st, q, { issue: issue.number });
  // Jev unavailable (budget exhausted / breaker open) must fail CLOSED: require real
  // verification evidence, and honour every recorded exit code. `testsExit` is null
  // whenever there is no root package.json, so it cannot be the only gate.
  if (!a) return {
    source: "fallback", unmet: [], scores: [], overclaims: null,
    pass: checks.prExists && checks.closesRef &&
      (checks.testsExit === 0 || checks.testsExit === null) &&
      Array.isArray(checks.verification) && checks.verification.length > 0 &&
      checks.verification.every((v) => v.exit === 0),
  };
  const scores = criteria.map((c, i) => ({ c, p: a[`c${i}`].noul }));
  const unmet = scores.filter((x) => x.p < CONFIG.policy.gapThresholdPass);
  const minP = scores.length ? Math.min(...scores.map((x) => x.p)) : 0;
  const oc = a.overclaims.noul;
  // `overclaims` is an existential over every claim in the report, so its probability
  // grows with the NUMBER of itemised claims regardless of honesty (measured r=0.91 vs
  // claim count, r=0.21 vs prose length). It therefore corroborates weak criteria rather
  // than vetoing strong ones: waive it only when EVERY criterion is strong, and keep a
  // hard ceiling for the blatant case. Empirically: every merged attempt has minP>=0.75,
  // every genuine failure minP<=0.54. Deterministic checks remain non-waivable.
  const ocBlock = CONFIG.policy.overclaimBlock ?? 0.5;
  const ocWaiveMin = CONFIG.policy.overclaimWaiveMinCriterion ?? 0.8;
  const ocCeiling = CONFIG.policy.overclaimCeiling ?? 0.8;
  const overclaimOk = oc < ocBlock || (minP >= ocWaiveMin && oc < ocCeiling);
  // scores.length > 0 stops a malformed issue body (no parseable criteria) passing vacuously.
  const pass = checks.prExists && checks.closesRef && scores.length > 0 &&
    unmet.length === 0 && overclaimOk;
  return { source: "jev", pass, unmet, scores, minP, overclaims: oc, overclaimWaived: overclaimOk && oc >= ocBlock };
}

// Decide whether a stuck issue truly needs Lee, or is the orchestrator's own problem.
// Deterministic guard first (an existing needs-human label is left alone), then Jev.
async function escalateOrPark(jev, issue, reason, attempts) {
  const n = issue.number;
  // `risk:high` marks SUBJECT MATTER (security, approvals, credentials), not a risky act.
  // 34 of 97 open issues carry it, including specification documents. Gating escalation on
  // the label alone is the same overbroad-gate mistake ADR 0005 removed from AGENTS.md §4
  // (Jev: risk_high_blanket_wrong=0.89, judge_risk_from_diff=0.91). Escalate on what the
  // blocker actually needs, judged below; `needs-human` still hard-blocks everything.
  if (issue.labels.includes("needs-human")) {
    log(`#${n}: already labelled needs-human — leaving for the owner`);
    return;
  }
  const a = await jev.ask("escalation", {
    issue: { number: n, title: issue.title, labels: issue.labels, body: (issue.body ?? "").slice(0, 4000) },
    blocker: reason,
    attempts: attempts.map((x) => ({ attempt: x.attempt, model: x.model, outcome: x.outcome, feedback: (x.feedback ?? "").slice(0, 800) })),
    human_authority_rule:
      "Only these require the repo owner: authorising spend or live-API budgets; providing or " +
      "rotating credentials; publishing, releasing, or tagging; irreversible or destructive acts; " +
      "granting permissions; or a product decision PLAN.md does not already settle. " +
      "Under-specification, a failed gate, an exhausted attempt budget, a wrong PR report, or a " +
      "flaky check are the orchestrator's problems to solve, not the owner's.",
  }, {
    needs_owner: noul("Under `human_authority_rule`, does `blocker` require the repo owner personally?", {
      true: "It needs owner authority: money, credentials, publishing, irreversible acts, or an unsettled product decision",
      false: "A capable agent could resolve it from PLAN.md, the issue, and the code",
    }),
    tractable: noul("Would a fresh worker with a sharper handoff, or a stronger model, plausibly resolve `blocker`?", {
      true: "The blocker is a solvable engineering or evidence problem",
      false: "Repeating the attempt cannot help; something external must change",
    }),
  }, { issue: n });
  // Fail closed: if Jev is unavailable we keep the old conservative behaviour.
  if (!a || a.needs_owner.noul >= 0.5 || a.tractable.noul < 0.4) {
    gh(["issue", "edit", String(n), "--add-label", "needs-human"]);
    gh(["issue", "comment", String(n), "-b", `Orchestrator: escalating to a human.\n\n${reason}\n\n${a ? `Jev: p(needs owner)=${a.needs_owner.noul.toFixed(2)}, p(tractable by retry)=${a.tractable.noul.toFixed(2)}.` : "Jev unavailable — escalating conservatively."}`]);
    log(`#${n}: escalated to Lee${a ? ` (needs_owner=${a.needs_owner.noul.toFixed(2)})` : " (Jev unavailable)"}`);
    return;
  }
  // Agent-resolvable: park it for human-free follow-up instead of blocking on Lee.
  gh(["issue", "edit", String(n), "--add-label", "orchestrator-stuck"]);
  gh(["issue", "comment", String(n), "-b", `Orchestrator: attempts exhausted, but this does not need the repo owner (Jev: p(needs owner)=${a.needs_owner.noul.toFixed(2)}, p(tractable)=${a.tractable.noul.toFixed(2)}).\n\n${reason}\n\nLabelled \`orchestrator-stuck\` for a fresh attempt with a different model or a sharper handoff. Raw decision in \`.orchestrate/decisions.jsonl\`.`]);
  log(`#${n}: agent-resolvable (needs_owner=${a.needs_owner.noul.toFixed(2)}) — labelled orchestrator-stuck, not needs-human`);
}

// Some `needs-human` labels were applied by a discredited earlier policy that used the
// label to mean "I gave up"; they are self-perpetuating, because a labelled issue is never
// worked and so the label is never revisited. Re-validate them with Jev before trusting
// them (Jev: stale_labels_must_be_revalidated=0.86; revalidation_is_self_weakening=0.13 —
// this corrects a mislabel, it does not weaken the policy). Fails closed: no Jev, no
// removal, and removal needs a confident judgment (require_high_confidence_to_remove=0.61).
async function revalidateNeedsHuman(jev, issues) {
  const flagged = Object.values(issues).filter((i) => i.state === "OPEN" && i.labels.includes("needs-human"));
  if (!flagged.length) return 0;
  let cleared = 0;
  for (const i of flagged) {
    // M0 issues are `type:approval` by construction — pure owner gates. Never touch them.
    if (i.labels.includes("type:approval")) continue;
    const a = await jev.ask("needs-human-revalidation", {
      issue: { number: i.number, title: i.title, labels: i.labels, body: (i.body ?? "").slice(0, 4000) },
      human_authority_rule:
        "Only these require the repo owner: authorising spend or live-API budgets; providing or rotating " +
        "credentials; publishing, releasing, or tagging; irreversible or destructive acts; granting " +
        "permissions; or a product decision PLAN.md does not already settle. Running out of attempts, a " +
        "failed gate, under-specification, a bad PR report, or a flaky check are NOT owner matters.",
      note: "Some labels were applied by an earlier orchestrator that used `needs-human` to mean 'I gave up'.",
    }, {
      needs_owner: noul("Under `human_authority_rule`, can ONLY the repo owner resolve this issue?", {
        true: "It genuinely requires the owner",
        false: "A capable agent could complete it from PLAN.md, the issue, and the code",
      }),
    }, { issue: i.number, probe: "revalidate" });
    if (!a) return cleared; // Jev unavailable: fail closed, trust every remaining label.
    if (a.needs_owner.noul <= 0.25) {
      if (!DRY) {
        gh(["issue", "edit", String(i.number), "--remove-label", "needs-human"]);
        gh(["issue", "comment", String(i.number), "-b", `Orchestrator: removing \`needs-human\`. Jev judges this does not require the repo owner (p(needs owner)=${a.needs_owner.noul.toFixed(2)}); it looks like a label left by the older "orchestrator gave up" policy. Re-admitting it to the work queue. Raw decision in \`.orchestrate/decisions.jsonl\`.`]);
      }
      i.labels = i.labels.filter((l) => l !== "needs-human");
      cleared++;
      log(`#${i.number}: cleared stale needs-human (p(needs owner)=${a.needs_owner.noul.toFixed(2)})`);
    }
  }
  return cleared;
}

// Keep local main identical to the remote before creating worktrees from it, so workers
// never branch from stale history. Refuses to touch a dirty tree or a non-main checkout.
function syncMain() {
  try {
    sh("git", ["fetch", "--prune", "-q", "origin"], { cwd: ROOT });
    const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT }).trim();
    if (branch !== "main") { log(`syncMain: skipped (on ${branch}, not main)`); return; }
    if (sh("git", ["status", "--porcelain"], { cwd: ROOT }).trim()) { log("syncMain: skipped (working tree dirty)"); return; }
    // Fast-forward only: never rewrite or discard local commits silently.
    sh("git", ["merge", "--ff-only", "origin/main"], { cwd: ROOT });
    log(`syncMain: main at ${sh("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).trim()}`);
  } catch (e) { log(`syncMain: ${String(e.stderr ?? e.message).trim().slice(-200)}`); }
}

// Remove a finished worker's worktree, local branch and stale tracking ref.
// Safe to call more than once; every step is best-effort.
function cleanupWorktree(dir, branch) {
  try { sh("git", ["worktree", "remove", "--force", dir], { cwd: ROOT }); } catch {}
  try { sh("git", ["worktree", "prune"], { cwd: ROOT }); } catch {}
  try { sh("git", ["branch", "-D", branch], { cwd: ROOT }); } catch {}
  try { sh("git", ["fetch", "--prune", "origin"], { cwd: ROOT }); } catch {}
  log(`cleaned up worktree ${dir} and branch ${branch}`);
}

// Sweep worktrees/branches whose issue is closed. Runs at the end of every session so
// abandoned attempts (timeouts, caps, interrupts) do not accumulate on disk.
function sweepWorktrees() {
  let list = "";
  try { list = sh("git", ["worktree", "list", "--porcelain"], { cwd: ROOT }); } catch { return; }
  for (const block of list.split("\n\n")) {
    const dir = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!dir || !branch || resolve(dir) === resolve(ROOT)) continue;
    const n = branch.match(/issue-(\d+)/)?.[1];
    if (!n) continue;
    let st;
    try { st = JSON.parse(gh(["issue", "view", n, "--json", "state"])).state; } catch { continue; }
    if (st !== "CLOSED") continue;
    // Never discard unpushed commits: only sweep when the branch is fully merged.
    try { sh("git", ["merge-base", "--is-ancestor", branch, "origin/main"], { cwd: ROOT }); }
    catch { log(`sweep: keeping ${branch} (#${n} closed but has unmerged commits)`); continue; }
    cleanupWorktree(dir, branch);
  }
}

// ---------- worker ----------
function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); }

// `knownBranch` pins the branch instead of deriving it from the issue title. An agentic
// worker's branch is whatever the orchestrator named when spawning it, which need not
// match `slug(issue.title)` — #18's agent worked on
// `issue-18-plan-scenarios-as-acceptance-test-outlines` while this function computed
// `issue-18-write-plan-2-8-scenarios-as-acceptance-t`. The gate then checked out an empty
// worktree at the derived name and reported pushed=false / pr=false for work that was
// pushed and had an open PR: a false negative that would have sent good work back for
// rework. Attempts record their own `branch`, so callers pass it through.
function ensureWorktree(issue, knownBranch) {
  const root = resolve(ROOT, CONFIG.workers.worktreeRoot);
  mkdirSync(root, { recursive: true });
  const branch = knownBranch ?? `issue-${issue.number}-${slug(issue.title)}`;
  // A branch can only be checked out in one worktree. An agentic worker's checkout lives
  // wherever it was spawned (herdr puts them under ~/.herdr/worktrees), so reuse that
  // rather than trying to add a second worktree for the same branch, which git refuses.
  const existing = sh("git", ["worktree", "list", "--porcelain"], { cwd: ROOT });
  const found = existing.split("\n\n").find((b) => b.includes(`branch refs/heads/${branch}\n`) || b.endsWith(`branch refs/heads/${branch}`));
  if (found) {
    const path = found.split("\n").find((l) => l.startsWith("worktree "))?.slice(9);
    if (path && existsSync(path)) return { dir: path, branch };
  }
  // Keep one checkout per branch, not per issue, so a pinned branch never collides with a
  // stale worktree left from a differently-named attempt on the same issue.
  const dir = join(root, knownBranch ? `issue-${issue.number}--${slug(branch)}` : `issue-${issue.number}`);
  if (!existsSync(dir)) {
    sh("git", ["fetch", "-q", "origin"], { cwd: ROOT });
    const remoteHas = sh("git", ["ls-remote", "--heads", "origin", branch], { cwd: ROOT }) !== "";
    if (remoteHas) sh("git", ["worktree", "add", dir, "-B", branch, `origin/${branch}`], { cwd: ROOT });
    else sh("git", ["worktree", "add", dir, "-b", branch, "origin/main"], { cwd: ROOT });
  }
  return { dir, branch };
}

function workerPrompt(issue, attempt, prev, criteria) {
  const handoff = prev ? `
## Handoff from previous attempt (attempt ${attempt - 1}, model ${prev.model}, outcome: ${prev.outcome})
${prev.feedback ? `Reviewer feedback / unmet criteria:\n${prev.feedback}\n` : ""}
Previous worker's final report:
${(prev.report ?? "(none)").slice(-3000)}

The worktree is intact — inspect \`git status\` and \`git log origin/main..HEAD\` before continuing. Do not redo finished work.
` : "";
  return `You are an autonomous worker in the KorWF-Pi build. You are in a dedicated git worktree on branch for issue #${issue.number}. Work only on this issue.

1. Read AGENTS.md fully (it is in this directory). Then run \`gh issue view ${issue.number} --comments\` and read the whole issue — it is the requirement, not this prompt.
2. Comment on the issue: \`gh issue comment ${issue.number} -b "Starting — <one-line plan> (attempt ${attempt})"\`.
3. Implement exactly the issue's scope. Read PLAN.md sections it references. Pi docs are at /home/lee/.local/share/mise/installs/pi/0.86.0/pi/ if the issue needs them.
4. Satisfy every acceptance criterion:
${criteria.map((c) => `   - ${c}`).join("\n")}
5. Run the issue's verification commands. Commit with conventional-commit messages referencing (#${issue.number}). Tick the matching TODO.md item.
6. \`git push -u origin HEAD\`, then open a PR with \`gh pr create --base main --title "<type>: <summary> (#${issue.number})" --body-file <file>\` using the AGENTS.md §6 template with \`Closes #${issue.number}\`. If a PR for this branch already exists, update it with \`gh pr edit\`.
7. Post a progress comment on the issue before any long step, and a final comment summarising what was done.

**Write incrementally — this is the most common way workers here fail.** Every assistant
turn has a hard output-token limit (16384, shared with reasoning at \`--thinking high\`).
A turn that tries to compose a large document or source file in one go is cut off at
\`stopReason: "length"\` **before its tool call is emitted**, so nothing is written to disk
and the whole attempt is lost. Six consecutive attempts on issue #14 failed this way.
Therefore:
- Create each file with a small \`write\`, then extend it with successive \`edit\` calls.
  Never emit more than a few hundred lines in a single tool call.
- \`git add\` and commit after each file is complete, so progress survives a truncated turn.
- Keep prose in your replies to one or two lines; narration burns the same budget the
  tool call needs. Do not restate the plan or summarise what you are about to do.

Constraints (non-negotiable): no credentials or machine-specific paths in shipped code; no bypasses of checks; no live model or TypeSafe API calls (you have no key); do not touch files outside this worktree; do not merge the PR; never run \`git push --force\`; never modify .github workflows to weaken checks.
You cannot ask questions — if something is genuinely undecidable, make the most conservative choice, document it under "Decisions and deviations" in the PR, and mention it in your final report.
${handoff}
When finished, your LAST message must be exactly one fenced json block and nothing else:
\`\`\`json
{"status":"done|partial|blocked","pr":"<url or null>","verification":[{"cmd":"...","exit":0}],"criteria_met":[true,false,...],"notes":"<what an agent with no context needs to know>"}
\`\`\``;
}

// Workers run headless (`pi -p --mode json`), which is what lets us stream structured
// events and enforce timeouts. That makes them invisible to Herdr's Agents panel, so we
// register a surface pane per worker purely for observability: the pane reports the
// worker's lifecycle state and is closed when the worker exits. Best-effort throughout —
// if Herdr is absent or the call fails, the worker still runs.
//
// The surface MUST live in the worker's own worktree Space, never in the caller's tab.
// `pane split --current` splits whatever tab the orchestrator happens to be running in —
// which is the user's tab — and with `workers.concurrency` > 1 it shredded that layout
// with a new pane per dispatch. `worktree open --path <dir>` yields a Space linked to the
// worker's checkout, so it nests under the project in the sidebar (herdr-pi-delegation
// §1.1: nesting is by git worktree identity, never by cwd or label) and the user's tab is
// left alone. Never fall back to splitting the current tab: no surface is strictly better
// than a mangled layout, since the surface is pure observability.
//
// Why a surface exists at all: workers are headless `pi -p --mode json` subprocesses
// (see runWorker), which is what lets us stream structured events and enforce timeouts.
// Headless pi is not in a pane, so Herdr's agent detection cannot see it and it never
// appears in the Agents panel by itself. The Space below is the only thing that makes a
// running worker visible to the user, so it must be created for every dispatch — keep it
// idempotent (`already_open`) rather than skipping it.
function herdrSurface(issue, model, dir) {
  if (!process.env.HERDR_ENV) return null;
  try {
    const name = `w-issue-${issue.number}`;
    const res = JSON.parse(sh("herdr", ["worktree", "open", "--path", dir, "--label", name, "--no-focus"])).result;
    const paneId = res?.root_pane?.pane_id;
    const workspaceId = res?.workspace?.workspace_id;
    if (!paneId) return null;
    // Only close a Space we actually created; if it was already open it belongs to
    // someone else (possibly the user) and must outlive this worker.
    const ownsWorkspace = res?.already_open === false;
    sh("herdr", ["pane", "rename", paneId, name]);
    sh("herdr", ["pane", "report-agent", paneId, "--source", "korwf:orchestrator", "--agent", name, "--state", "working",
      "--message", `#${issue.number} ${model}`]);
    // Show the worker's own git activity in the pane rather than leaving it blank.
    // Run this BEFORE report-metadata: starting a command resets the pane's display
    // label, so the metadata must be applied last to survive.
    sh("herdr", ["pane", "run", paneId,
      `watch -n5 -t 'echo "#${issue.number} ${model}"; git -C ${dir} log --oneline -5 2>/dev/null; git -C ${dir} status -s 2>/dev/null | head -12'`]);
    sh("herdr", ["pane", "report-metadata", paneId, "--source", "korwf:orchestrator", "--agent", "pi",
      "--display-agent", `#${issue.number} · ${model}`, "--title", issue.title.slice(0, 60),
      "--token", `model=${model}`, "--token", `issue=${issue.number}`]);
    return { paneId, name, workspaceId: ownsWorkspace ? workspaceId : null };
  } catch { return null; }
}

function herdrSurfaceEnd(surface, state, message) {
  if (!surface) return;
  try {
    sh("herdr", ["pane", "report-agent", surface.paneId, "--source", "korwf:orchestrator",
      "--agent", surface.name, "--state", state, "--message", message.slice(0, 200)]);
    sh("herdr", ["pane", "release-agent", surface.paneId, "--source", "korwf:orchestrator", "--agent", surface.name]);
    // Close only what this function's own surface created, and only the Space we opened
    // for it — never a tab, which would kill every agent inside it (herdr-pi-delegation
    // §0 rule 2). `cleanupWorktree()` removes the checkout itself once the issue closes.
    if (surface.workspaceId) sh("herdr", ["workspace", "close", surface.workspaceId]);
    else sh("herdr", ["pane", "close", surface.paneId]);
  } catch {}
}

function runWorker({ dir, model, thinking, prompt, issue }) {
  return new Promise((resolvePromise) => {
    const surface = herdrSurface(issue, model, dir);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/JEV|TYPESAFE|API_KEY|SECRET|TOKEN/i.test(k) && !/^GH_/.test(k)) delete env[k];
    env.KORWF_WORKER = "1";
    env.PI_OFFLINE = "1";
    const child = spawn("pi", [
      "--provider", CONFIG.allowlist.providers[0], "--model", model, "--thinking", thinking,
      "-p", "--mode", "json", "--no-session", "--", prompt,
    ], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

    let stdout = "", stderr = "", lastText = "", usage = null, killed = false, stopReason = null;
    const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000); }, CONFIG.workers.timeoutMinutes * 60_000);
    child.stdout.on("data", (d) => {
      stdout += d;
      let idx;
      while ((idx = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, idx); stdout = stdout.slice(idx + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            const t = (ev.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
            if (t.trim()) lastText = t;
            if (ev.message.usage) usage = ev.message.usage;
            // `length` means the turn hit the output-token ceiling mid-thought, so any
            // tool call it was about to make never happened. Without capturing this the
            // failure is invisible: the attempt looks like a worker that simply stopped
            // early, and the gate blames the model or the issue. Diagnosed on #14 after
            // six attempts across two model families wrote zero files.
            if (ev.message.stopReason) stopReason = ev.message.stopReason;
          }
          if (ev.type === "tool_execution_end" && ev.toolName === "bash" && ev.isError) stderr += `\n[tool error] ${String(ev.result).slice(0, 500)}`;
        } catch {}
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      herdrSurfaceEnd(surface, code === 0 && !killed ? "idle" : "blocked",
        killed ? "timed out" : `exit ${code}`);
      resolvePromise({ code, killed, lastText, usage, stopReason, stderr: stderr.slice(-8000) });
    });
  });
}

function detectCap(res) {
  const text = `${res.stderr}\n${res.lastText}`;
  if (/429|rate.?limit|quota|insufficient_quota|overloaded|capacity/i.test(text) && (res.code !== 0 || !res.lastText.includes('"status"'))) return "rate-limit/quota";
  if (/401|403|authentication|unauthori[sz]ed/i.test(res.stderr)) return "auth";
  return null;
}

function parseReport(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function deterministicChecks(issue, dir, branch, verification) {
  const checks = { pushed: false, prExists: false, prUrl: null, closesRef: false, testsExit: null, verification: [] };
  try { checks.pushed = sh("git", ["ls-remote", "--heads", "origin", branch], { cwd: ROOT }) !== ""; } catch {}
  try {
    const prs = JSON.parse(gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url,body"]));
    if (prs[0]) { checks.prExists = true; checks.prUrl = prs[0].url; checks.closesRef = new RegExp(`Closes #${issue.number}\\b`).test(prs[0].body); }
  } catch {}
  for (const cmd of verification) {
    if (!/^(npm|npx|node|ls|test|git|bash|grep|!|wc)/.test(cmd)) { checks.verification.push({ cmd, exit: null, skipped: "not in allowlist" }); continue; }
    try { execFileSync("bash", ["-lc", cmd], { cwd: dir, stdio: "pipe", timeout: 600_000 }); checks.verification.push({ cmd, exit: 0 }); }
    catch (e) { checks.verification.push({ cmd, exit: e.status ?? 1, tail: String(e.stdout ?? "").slice(-800) + String(e.stderr ?? "").slice(-800) }); }
  }
  if (existsSync(join(dir, "package.json"))) {
    // Install first, or the result measures the environment rather than the work. A
    // worktree created before the package gained a test runner has no node_modules, so
    // `npm test` exits 127 ("vitest: command not found") and the gate blames the worker.
    // This blocked #11's PR while its 20 vitest + 12 node:test cases all passed once the
    // dependencies were present. 127 is "command not found", never a test verdict.
    if (!existsSync(join(dir, "node_modules"))) {
      try { execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: dir, stdio: "pipe", timeout: 900_000 }); }
      catch (e) { checks.installFailed = String(e.stderr ?? e.message).slice(-500); }
    }
    try { execFileSync("npm", ["test", "--silent"], { cwd: dir, stdio: "pipe", timeout: 900_000 }); checks.testsExit = 0; }
    catch (e) { checks.testsExit = e.status ?? 1; }
  }
  return checks;
}

// ---------- attempt lifecycle ----------
async function dispatch(jev, cand) {
  const { issue, def } = cand;
  const attempts = state.attempts[issue.number] ??= [];
  const prev = attempts.at(-1) ?? null;
  const attemptNo = attempts.length + 1;
  const criteria = parseCriteria(issue.body);
  const sel = await profileAndSelect(jev, issue, def, attemptNo, prev);

  if (sel.profile.sufficient !== null && sel.profile.sufficient < 0.25) {
    log(`#${issue.number}: Jev p(sufficient)=${sel.profile.sufficient.toFixed(2)} — flagging needs-human instead of dispatching`);
    if (!DRY) {
      gh(["issue", "comment", String(issue.number), "-b", `Orchestrator: Jev judged this issue under-specified (p(sufficient)=${sel.profile.sufficient.toFixed(2)}). Not dispatching to a worker until a human clarifies. Raw decision is in \`.orchestrate/decisions.jsonl\`.`]);
      gh(["issue", "edit", String(issue.number), "--add-label", "needs-human"]);
    }
    return null;
  }

  log(`#${issue.number} "${issue.title}" → ${sel.model} [${sel.rule}] thinking=${sel.thinking} profile=${JSON.stringify(sel.profile)}`);
  if (DRY) return null;

  const { dir, branch } = ensureWorktree(issue);
  const attempt = { issue: issue.number, attempt: attemptNo, model: sel.model, requested: sel.ranking[0]?.model ?? sel.model, rule: sel.rule, thinking: sel.thinking, profile: sel.profile, branch, started: new Date().toISOString(), outcome: "running" };
  attempts.push(attempt); state.sessionRuns++; saveState();
  gh(["issue", "comment", String(issue.number), "-b", `Orchestrator: dispatching attempt ${attemptNo} to \`${CONFIG.allowlist.providers[0]}/${sel.model}\` (thinking ${sel.thinking}). Selection rule: ${sel.rule}. Task profile: ${sel.profile.domain}, depth ${Number(sel.profile.depth).toFixed(1)}, context ${Number(sel.profile.contextSize).toFixed(1)} (${sel.profile.source}).`]);

  const res = await runWorker({ dir, model: sel.model, thinking: sel.thinking, prompt: workerPrompt(issue, attemptNo, prev, criteria), issue });
  attempt.ended = new Date().toISOString();
  attempt.usage = res.usage;
  attempt.report = res.lastText;
  // Persist the diagnostics that make a failed attempt explicable. `stderr` and
  // `stopReason` were previously dropped, which is why six identical #14 failures could
  // not be told apart from ordinary under-performance.
  attempt.stopReason = res.stopReason ?? null;
  attempt.exitCode = res.code ?? null;
  if (res.stderr?.trim()) attempt.stderr = res.stderr.slice(-2000);
  state.sessionTokens += res.usage?.totalTokens ?? 0;

  const cap = detectCap(res);
  if (cap) {
    const until = new Date(Date.now() + CONFIG.policy.capCooldownMinutes * 60_000).toISOString();
    state.caps[sel.model] = until;
    attempt.outcome = "capped"; attempt.fallback_reason = cap; saveState();
    log(`#${issue.number}: model ${sel.model} capped (${cap}); cooldown until ${until}; will hand off`);
    gh(["issue", "comment", String(issue.number), "-b", `Orchestrator: \`${sel.model}\` hit a cap (${cap}). Marked unavailable until ${until}. Handing off to a Jev-ranked substitute with the worktree intact.`]);
    return "retry";
  }
  if (res.killed) { attempt.outcome = "timeout"; attempt.feedback = `Previous attempt exceeded ${CONFIG.workers.timeoutMinutes} min. Resume from the worktree; commit and push smaller increments.`; saveState(); log(`#${issue.number}: timeout`); return "retry"; }

  // A turn cut off at the output-token ceiling never emitted its tool call, so the work
  // was not done and the final JSON report is missing. This is a harness failure, not a
  // quality failure: do not let it consume the issue's attempt budget or feed the model
  // "you did not meet the criteria" feedback, which is untrue and unactionable.
  if (res.stopReason === "length") {
    attempt.outcome = "truncated";
    attempt.feedback = "Your previous turn was cut off at the output-token limit before its "
      + "tool call was emitted, so nothing was written. Work in much smaller steps: create "
      + "each file with a short `write`, extend it with successive `edit` calls, commit after "
      + "each file, and keep replies to one or two lines.";
    saveState();
    log(`#${issue.number}: TRUNCATED (stopReason=length, ${res.usage?.totalTokens ?? 0} tokens) — retrying with incremental-write guidance, attempt not counted`);
    return "retry";
  }

  const report = parseReport(res.lastText);
  const checks = deterministicChecks(issue, dir, branch, parseVerification(issue.body));
  const gap = await evidenceGap(jev, issue, criteria, res.lastText, checks, dir);
  attempt.checks = checks; attempt.gap = gap; attempt.pr = checks.prUrl; attempt.reportStatus = report?.status ?? "unparsed";

  if (gap.pass && report?.status === "done") {
    attempt.outcome = "awaiting-review"; saveState();
    log(`#${issue.number}: PASS → ${checks.prUrl} (gap source ${gap.source})`);
    gh(["issue", "comment", String(issue.number), "-b", `Orchestrator: attempt ${attemptNo} complete. Deterministic checks: pushed=${checks.pushed} pr=${checks.prExists} closesRef=${checks.closesRef} tests=${checks.testsExit ?? "n/a"}. Jev evidence-gap review: no unmet criteria (overclaim p=${gap.overclaims?.toFixed(2) ?? "n/a"}). PR: ${checks.prUrl}\n\n**Awaiting human review and merge.**`]);
    if (CONFIG.policy.merge === "jev-review") {
      try { await mergeReview(jev, issue.number); }
      catch (e) { log(`#${issue.number}: merge review error ${e.message}`); }
    }
    return "done";
  }

  const feedback = [
    !checks.pushed && "Branch was not pushed.",
    !checks.prExists && "No open PR for the branch.",
    checks.prExists && !checks.closesRef && `PR body lacks 'Closes #${issue.number}'.`,
    checks.testsExit ? `npm test exited ${checks.testsExit}.` : null,
    ...checks.verification.filter((v) => v.exit).map((v) => `Verification '${v.cmd}' exited ${v.exit}: ${v.tail ?? ""}`),
    ...gap.unmet.map((u) => `Unmet (p=${u.p.toFixed(2)}): ${u.c}`),
    gap.overclaims >= 0.5 && `Report appears to overclaim (p=${gap.overclaims.toFixed(2)}).`,
    report?.status && report.status !== "done" && `Worker reported status '${report.status}': ${report.notes ?? ""}`,
  ].filter(Boolean).join("\n");
  attempt.outcome = "gap"; attempt.feedback = feedback; saveState();
  log(`#${issue.number}: GAP\n${feedback}`);
  const exhausted = attempts.length >= CONFIG.workers.maxAttemptsPerIssue;
  gh(["issue", "comment", String(issue.number), "-b", `Orchestrator: attempt ${attemptNo} did not pass the gate.\n\n${feedback}\n\n${exhausted ? "Attempt limit reached." : "Re-dispatching with a handoff packet."}`]);
  // Running out of attempts is the orchestrator's failure, not proof that Lee is needed.
  // Only escalate when the blocker genuinely requires owner authority (spend, credentials,
  // publishing, irreversible acts, or an unsettled product decision).
  if (exhausted) await escalateOrPark(jev, issue, feedback, attempts);
  return "retry";
}

async function reviewOnly(jev, n) {
  const issues = fetchIssues(); const issue = issues[n];
  const attempts = state.attempts[n] ?? []; const attempt = attempts.at(-1);
  if (!attempt) throw new Error(`no attempts recorded for #${n}`);
  // Use the branch the attempt actually used (agentic workers name their own).
  const { dir, branch } = ensureWorktree(issue, attempt.branch);
  const criteria = parseCriteria(issue.body);
  const checks = deterministicChecks(issue, dir, branch, parseVerification(issue.body));
  const gap = await evidenceGap(jev, issue, criteria, attempt.report ?? "", checks, dir);
  log(`#${n} re-review: checks=${JSON.stringify({ pushed: checks.pushed, pr: checks.prExists, closes: checks.closesRef, tests: checks.testsExit })} gap=${JSON.stringify({ pass: gap.pass, overclaims: gap.overclaims, unmet: gap.unmet })}`);
  attempt.checks = checks; attempt.gap = gap; attempt.pr = checks.prUrl;
  if (gap.pass) {
    attempt.outcome = "awaiting-review";
    if (!DRY) gh(["issue", "comment", String(n), "-b", `Orchestrator (re-review of attempt ${attempt.attempt}, judging the diff directly): all acceptance criteria supported (min criterion p=${Math.min(...gap.scores.map((x) => x.p)).toFixed(2)}; overclaim p=${gap.overclaims?.toFixed(2)}). PR: ${checks.prUrl}\n\n**Awaiting human review and merge.**`]);
  }
  saveState();
}

// Merge gate. Code enforces the hard rules (PR clean/mergeable, checks green, no
// needs-human, no secrets or machine paths in diff). Jev answers the semantic questions a
// reviewer would: is the change complete for the issue, does the PR describe it honestly,
// does it violate PLAN §2.4/§7 constraints, is anything out of scope. Jev can only block.
async function mergeReview(jev, n) {
  const issues = fetchIssues(); const issue = issues[n];
  const attempt = (state.attempts[n] ?? []).at(-1);
  if (!attempt || attempt.outcome !== "awaiting-review") throw new Error(`#${n} is not awaiting review (last outcome: ${attempt?.outcome ?? "none"})`);
  const { dir, branch } = ensureWorktree(issue, attempt.branch);
  sh("git", ["fetch", "-q", "origin"], { cwd: dir });
  const prState = () => JSON.parse(gh(["pr", "view", branch, "--json", "number,url,body,title,mergeable,mergeStateStatus"]));
  let pr = prState();
  const hard = [];
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    // Earlier PRs in the batch landed first (e.g. adjacent TODO.md ticks). Orchestrator-only rebase; workers never force-push.
    try {
      sh("git", ["rebase", "origin/main"], { cwd: dir });
      sh("git", ["push", "--force-with-lease", "origin", branch], { cwd: dir });
      log(`#${n}: rebased ${branch} onto origin/main`);
      for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 5000)); pr = prState(); if (pr.mergeable === "MERGEABLE") break; }
    } catch (e) {
      try { sh("git", ["rebase", "--abort"], { cwd: dir }); } catch {}
      hard.push(`rebase onto main conflicts: ${String(e.stderr ?? e.message).slice(-300)}`);
    }
  }
  // GitHub computes mergeability asynchronously and reports `UNKNOWN` until it finishes,
  // usually within a few seconds of a push. That is "not known yet", not "not mergeable",
  // so failing on it sends a perfectly good PR back to a worker for rework — which is what
  // happened to #120: every Jev score passed and the only blocker was a transient UNKNOWN.
  // Poll briefly for a definite answer before judging.
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      pr = prState();
      if (pr.mergeable !== "UNKNOWN" && pr.mergeStateStatus !== "UNKNOWN") break;
    }
    if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") {
      // Still indeterminate after ~30s: a GitHub-side delay, not a defect in the work.
      // Retry the merge review later; do not loop a worker over it.
      log(`#${n}: GitHub has not computed mergeability yet (${pr.mergeable}/${pr.mergeStateStatus}) — leaving awaiting-review, retry \`--merge ${n}\` shortly`);
      return "retry-later";
    }
  }
  if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus !== "CLEAN") hard.push(`PR state ${pr.mergeable}/${pr.mergeStateStatus}`);
  // `needs-human` is absolute: by definition only the owner can resolve it (Jev:
  // block_when_warranted=0.67, and stale labels are re-validated by revalidateNeedsHuman()
  // before this point). `risk:high` alone is NOT a merge blocker — it labels sensitive
  // subject matter, not a dangerous merge. What matters is whether the DIFF touches the
  // product's own security/permission enforcement; `touches_enforcement` below judges that
  // from the diff and is treated as a hard block (Jev: security_code_still_gated=0.88).
  if (issue.labels.includes("needs-human")) hard.push("issue labelled needs-human — owner merge only");
  const { stat, diff } = branchDiff(dir);
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  if (/\/home\/[a-z]+\//.test(added)) hard.push("diff adds an absolute home-directory path");
  if (/(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|JEV_API_KEY\s*=\s*\S)/.test(added)) hard.push("diff appears to add a credential");
  const checks = deterministicChecks(issue, dir, branch, parseVerification(issue.body));
  if (checks.testsExit) hard.push(`npm test exited ${checks.testsExit}`);
  for (const v of checks.verification) if (v.exit) hard.push(`verification '${v.cmd}' exited ${v.exit}`);

  const criteria = parseCriteria(issue.body);
  const a = await jev.ask("merge", {
    issue: { number: n, title: issue.title, scope: ISSUE_DEFS[issue.key]?.scope, acceptance: criteria, out_of_scope_rule: "Only what the issue's scope lists; nothing else" },
    pr: { title: pr.title, body: pr.body.slice(0, 4000) },
    changed_files: stat,
    diff,
    hard_rules: "PLAN §2.4/§7: no credentials or machine-specific paths in shipped code; no hardcoded provider names in src/; no bypass of checks; docs must not invent APIs that do not exist",
  }, {
    // Decomposed per criterion. A single "does it deliver EVERYTHING" question is an
    // existential over the whole scope, so its probability falls as the scope is more
    // finely itemised, independent of actual completeness (same artefact measured on
    // `overclaims`: r=0.91 vs claim count). Asking per criterion keeps each judgment
    // bounded; the conjunction is then taken in code below.
    ...Object.fromEntries(criteria.map((c, i) => [`complete_c${i}`, noul(
      { criterion: c, question: "Judging from `diff` and `changed_files`, is this specific criterion fully delivered?" },
      { true: "The diff contains everything this criterion requires", false: "Something this criterion requires is missing from the diff" })])),
    scope_gap: noul("Does `issue.scope` demand deliverables BEYOND `issue.acceptance` that `diff` does not provide?", { true: "The scope requires additional work absent from the diff", false: "The acceptance list covers what the issue asks for" }),
    honest: noul("Does `pr.body` accurately describe what `diff` contains, without claiming more than was done?", { true: "PR description matches the diff", false: "PR description overstates, omits, or misdescribes the change" }),
    in_scope: noul("Is everything in `diff` within `issue.scope` (no unrelated refactors, extra features, or unrequested files)?", { true: "All changes serve the issue", false: "The diff contains unrelated or unrequested changes" }),
    rule_violation: noul("Does `diff` violate any of `hard_rules`?", { true: "A concrete violation is present in the diff", false: "No violation found" }),
    // Replaces the old blanket `risk:high` merge block. The question is not whether the
    // issue's topic is sensitive, but whether THIS diff changes enforcement behaviour.
    touches_enforcement: noul(
      "Does `diff` add or change EXECUTABLE code that enforces security, permissions, the model/provider " +
      "allowlist, spending limits, credential handling, or approval gating — as opposed to specifications, " +
      "documentation, tests, or code unrelated to enforcement?",
      {
        true: "It changes real enforcement behaviour, so a human must review it before merge",
        false: "It is documentation, specification, tests, or non-enforcement code",
      }),
    quality: score("How would a careful senior reviewer rate the quality of `diff` for merging into main?", [
      "Would request changes: errors, confusion, or sloppiness that must be fixed first",
      "Acceptable: minor nits only, fine to merge",
      "Strong: clear, precise, and complete; merge without hesitation",
    ]),
  }, { issue: n, pr: pr.number });
  const soft = [];
  if (!a) soft.push("Jev unavailable — no semantic review; human merge only");
  else {
    const cs = criteria.map((c, i) => ({ c, p: a[`complete_c${i}`].noul }));
    for (const x of cs.filter((x) => x.p < CONFIG.policy.gapThresholdPass)) soft.push(`Jev: p(complete: ${x.c})=${x.p.toFixed(2)}`);
    if (!cs.length) soft.push("no parseable acceptance criteria to review");
    if (a.scope_gap.noul >= 0.5) soft.push(`Jev: p(scope gap beyond criteria)=${a.scope_gap.noul.toFixed(2)}`);
    a.__completeMin = cs.length ? Math.min(...cs.map((x) => x.p)) : 0;
    if (a.honest.noul < CONFIG.policy.gapThresholdPass) soft.push(`Jev: p(honest PR description)=${a.honest.noul.toFixed(2)}`);
    if (a.in_scope.noul < 0.5) soft.push(`Jev: p(in scope)=${a.in_scope.noul.toFixed(2)}`);
    if (a.rule_violation.noul >= 0.4) soft.push(`Jev: p(rule violation)=${a.rule_violation.noul.toFixed(2)}`);
    if (a.quality.score < 0.75) soft.push(`Jev: quality=${a.quality.score.toFixed(2)} (<0.75)`);
    // Hard, not soft: a diff that changes enforcement is owner territory regardless of how
    // clean everything else looks. This is the targeted replacement for the risk:high block.
    if (a.touches_enforcement.noul >= CONFIG.policy.enforcementBlock)
      hard.push(`diff changes security/permission enforcement code (Jev p=${a.touches_enforcement.noul.toFixed(2)}) — owner merge only`);
  }
  const verdict = a ? { complete_min: a.__completeMin, scope_gap: a.scope_gap.noul, honest: a.honest.noul, in_scope: a.in_scope.noul, rule_violation: a.rule_violation.noul, touches_enforcement: a.touches_enforcement.noul, quality: a.quality.score } : null;
  const blockers = [...hard, ...soft];
  const summary = `Merge review of ${pr.url} for #${n}\n\nHard checks: ${hard.length ? hard.join("; ") : "all pass"} (pushed=${checks.pushed}, verification exits=${checks.verification.map((v) => v.exit).join(",") || "n/a"}, tests=${checks.testsExit ?? "n/a"})\nJev merge review: ${verdict ? Object.entries(verdict).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ") : "unavailable"}\nVerdict: ${blockers.length ? "**NOT MERGED** — " + blockers.join("; ") : "**MERGE**"}`;
  log(summary);
  attempt.mergeReview = { at: new Date().toISOString(), hard, soft, verdict };
  if (DRY) { saveState(); return; }
  gh(["pr", "comment", String(pr.number), "-b", summary]);
  if (blockers.length) {
    // Owner instruction: merge when green and Jev agrees; when Jev does NOT agree, keep
    // working the issue until it does (Jev: loop_on_jev_disagreement=0.87), bounded so a
    // permanently-failing issue cannot burn tokens forever (loop_needs_bound=0.86).
    // The blockers become the next attempt's feedback; readyIssues() re-admits the issue
    // because `merge-blocked` is not `awaiting-review`.
    attempt.outcome = "merge-blocked"; attempt.feedback = blockers.join("\n"); saveState();
    const all = state.attempts[n] ?? [];
    const ownerOnly = hard.some((h) => /needs-human|enforcement/.test(h));
    if (ownerOnly) {
      log(`#${n}: merge blocked for the owner — not looping`);
      await escalateOrPark(jev, issue, blockers.join("\n"), all);
    } else if (all.length >= CONFIG.workers.maxAttemptsPerIssue) {
      log(`#${n}: merge blocked and attempts exhausted`);
      await escalateOrPark(jev, issue, blockers.join("\n"), all);
    } else {
      log(`#${n}: merge blocked — looping back to a worker with the blockers as feedback`);
      gh(["issue", "comment", String(n), "-b", `Orchestrator: merge review did not pass. Re-dispatching a worker with these blockers as feedback rather than parking the PR.\n\n${blockers.map((b) => "- " + b).join("\n")}`]);
    }
    return;
  }
  gh(["pr", "merge", String(pr.number), "--squash", "--delete-branch"]);
  attempt.outcome = "merged"; saveState();
  // `gh pr merge --delete-branch` removes the REMOTE branch only. Clean up the local
  // worktree, the local branch, and the now-stale remote-tracking ref too, so a later
  // `worktree add -B` cannot resurrect dead work.
  cleanupWorktree(dir, branch);
  log(`#${n}: merged ${pr.url}`);
}

let ISSUE_DEFS = {};

// ---------- main loop ----------
async function main() {
  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  const jev = new Jev({ apiKey, model: CONFIG.jev.model, logPath: join(STATE_DIR, "decisions.jsonl"), budgetTokens: CONFIG.jev.tokenBudget });
  if (!DRY) acquireLock();
  const defs = await loadDefs(); ISSUE_DEFS = defs;
  if (REVIEW) { await reviewOnly(jev, REVIEW); return; }
  if (MERGE) { await mergeReview(jev, MERGE); return; }
  // Clean up attempts left 'running' by a crashed orchestrator.
  for (const list of Object.values(state.attempts)) for (const a of list) if (a.outcome === "running") { a.outcome = "interrupted"; a.feedback = "Orchestrator was interrupted; resume from the worktree."; }
  saveState();

  let runsThisSession = 0;
  let revalidated = false;
  while (true) {
    if (runsThisSession >= MAX_RUNS) { log(`run budget reached (${MAX_RUNS})`); break; }
    if (state.sessionTokens >= CONFIG.budgets.maxWorkerTokensPerSession) { log("worker token budget reached"); break; }
    syncMain();
    const issues = fetchIssues();
    // Once per session, before trusting any `needs-human` label to exclude work.
    if (!revalidated) { revalidated = true; const c = await revalidateNeedsHuman(jev, issues); if (c) log(`revalidation cleared ${c} stale needs-human label(s)`); }
    const ready = readyIssues(issues, defs);
    if (!ready.length) { log("nothing ready (all remaining issues are blocked, needs-human, awaiting review, or attempt-limited)"); break; }
    const batch = ready.slice(0, CONFIG.workers.concurrency);
    log(`ready: ${ready.map((r) => "#" + r.issue.number).join(" ")} — dispatching ${batch.map((r) => "#" + r.issue.number).join(" ")}`);
    const results = await Promise.all(batch.map((c) => dispatch(jev, c).catch((e) => { log(`#${c.issue.number}: orchestrator error ${e.stack}`); return "error"; })));
    runsThisSession += batch.length;
    if (DRY || ONCE) break;
    if (results.every((r) => r === null)) break;
  }
  if (!DRY) { sweepWorktrees(); syncMain(); }
  log(`Jev usage: ${JSON.stringify(jev.usage)}; worker tokens this session: ${state.sessionTokens}`);
}

// Run the batch loop only when invoked directly. When imported (by ask-jev.mjs, which
// lets an *agentic* orchestrator reuse these Jev batteries without running the loop),
// nothing executes on import — no lock is taken and no worker is dispatched.
if (DIRECT) main().catch((e) => { log(`fatal: ${e.stack}`); process.exit(1); });

export { profileAndSelect, readyIssues, loadDefs, fetchIssues, parseCriteria, parseVerification, availableModels, CONFIG, ISSUE_KEYS, state };
