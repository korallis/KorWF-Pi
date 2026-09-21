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
  for (const f of ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]) {
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
    const d = defs[i.key];
    if (!d) continue;
    const blockers = d.deps.map((k) => issues[ISSUE_KEYS[k]]).filter((b) => b && b.state !== "CLOSED");
    if (blockers.length) continue;
    const attempts = state.attempts[i.number] ?? [];
    if (attempts.length >= CONFIG.workers.maxAttemptsPerIssue) continue;
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
  const thinking = profile.depth >= 1.5 ? "high" : profile.depth >= 0.75 ? "medium" : "low";
  return { profile, model, rule, ranking, thinking };
}

async function evidenceGap(jev, issue, criteria, report, checks) {
  const st = {
    acceptance_criteria: criteria,
    worker_final_report: report.slice(-6000),
    deterministic_checks: checks,
  };
  const q = {
    overclaims: noul("Does `worker_final_report` claim work or verification that `deterministic_checks` does not support?", {
      true: "The report asserts tests passed, files exist, or a PR exists where the checks show otherwise",
      false: "Every claim in the report is consistent with the checks",
    }),
  };
  criteria.forEach((c, i) => {
    q[`c${i}`] = noul({ criterion: c, question: "Do `worker_final_report` and `deterministic_checks` demonstrate that `criterion` has been met?" });
  });
  const a = await jev.ask("gap", st, q, { issue: issue.number });
  if (!a) return { source: "fallback", pass: checks.prExists && checks.closesRef && checks.testsExit === 0 || checks.testsExit === null && checks.prExists && checks.closesRef, unmet: [], overclaims: null };
  const unmet = criteria.map((c, i) => ({ c, p: a[`c${i}`].noul })).filter((x) => x.p < CONFIG.policy.gapThresholdPass);
  const pass = unmet.length === 0 && a.overclaims.noul < 0.5 && checks.prExists && checks.closesRef;
  return { source: "jev", pass, unmet, overclaims: a.overclaims.noul };
}

// ---------- worker ----------
function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); }

function ensureWorktree(issue) {
  const root = resolve(ROOT, CONFIG.workers.worktreeRoot);
  mkdirSync(root, { recursive: true });
  const dir = join(root, `issue-${issue.number}`);
  const branch = `issue-${issue.number}-${slug(issue.title)}`;
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

Constraints (non-negotiable): no credentials or machine-specific paths in shipped code; no bypasses of checks; no live model or TypeSafe API calls (you have no key); do not touch files outside this worktree; do not merge the PR; never run \`git push --force\`; never modify .github workflows to weaken checks.
You cannot ask questions — if something is genuinely undecidable, make the most conservative choice, document it under "Decisions and deviations" in the PR, and mention it in your final report.
${handoff}
When finished, your LAST message must be exactly one fenced json block and nothing else:
\`\`\`json
{"status":"done|partial|blocked","pr":"<url or null>","verification":[{"cmd":"...","exit":0}],"criteria_met":[true,false,...],"notes":"<what an agent with no context needs to know>"}
\`\`\``;
}

function runWorker({ dir, model, thinking, prompt }) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/JEV|TYPESAFE|API_KEY|SECRET|TOKEN/i.test(k) && !/^GH_/.test(k)) delete env[k];
    env.KORWF_WORKER = "1";
    env.PI_OFFLINE = "1";
    const child = spawn("pi", [
      "--provider", CONFIG.allowlist.providers[0], "--model", model, "--thinking", thinking,
      "-p", "--mode", "json", "--no-session", "--", prompt,
    ], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

    let stdout = "", stderr = "", lastText = "", usage = null, killed = false;
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
          }
          if (ev.type === "tool_execution_end" && ev.toolName === "bash" && ev.isError) stderr += `\n[tool error] ${String(ev.result).slice(0, 500)}`;
        } catch {}
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, killed, lastText, usage, stderr: stderr.slice(-8000) }); });
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

  const res = await runWorker({ dir, model: sel.model, thinking: sel.thinking, prompt: workerPrompt(issue, attemptNo, prev, criteria) });
  attempt.ended = new Date().toISOString();
  attempt.usage = res.usage;
  attempt.report = res.lastText;
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

  const report = parseReport(res.lastText);
  const checks = deterministicChecks(issue, dir, branch, parseVerification(issue.body));
  const gap = await evidenceGap(jev, issue, criteria, res.lastText, checks);
  attempt.checks = checks; attempt.gap = gap; attempt.pr = checks.prUrl; attempt.reportStatus = report?.status ?? "unparsed";

  if (gap.pass && report?.status === "done") {
    attempt.outcome = "awaiting-review"; saveState();
    log(`#${issue.number}: PASS → ${checks.prUrl} (gap source ${gap.source})`);
    gh(["issue", "comment", String(issue.number), "-b", `Orchestrator: attempt ${attemptNo} complete. Deterministic checks: pushed=${checks.pushed} pr=${checks.prExists} closesRef=${checks.closesRef} tests=${checks.testsExit ?? "n/a"}. Jev evidence-gap review: no unmet criteria (overclaim p=${gap.overclaims?.toFixed(2) ?? "n/a"}). PR: ${checks.prUrl}\n\n**Awaiting human review and merge.**`]);
    if (CONFIG.policy.merge === "auto-low-risk" && !issue.labels.some((l) => ["risk:high", "needs-human"].includes(l)) && checks.testsExit !== 1) {
      gh(["pr", "merge", checks.prUrl, "--squash", "--delete-branch"]);
      attempt.outcome = "merged"; saveState();
      log(`#${issue.number}: auto-merged`);
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
  gh(["issue", "comment", String(issue.number), "-b", `Orchestrator: attempt ${attemptNo} did not pass the gate.\n\n${feedback}\n\n${attempts.length < CONFIG.workers.maxAttemptsPerIssue ? "Re-dispatching with a handoff packet." : "Attempt limit reached — needs a human."}`]);
  if (attempts.length >= CONFIG.workers.maxAttemptsPerIssue) gh(["issue", "edit", String(issue.number), "--add-label", "needs-human"]);
  return "retry";
}

// ---------- main loop ----------
async function main() {
  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  const jev = new Jev({ apiKey, model: CONFIG.jev.model, logPath: join(STATE_DIR, "decisions.jsonl"), budgetTokens: CONFIG.jev.tokenBudget });
  if (!DRY) acquireLock();
  const defs = await loadDefs();
  // Clean up attempts left 'running' by a crashed orchestrator.
  for (const list of Object.values(state.attempts)) for (const a of list) if (a.outcome === "running") { a.outcome = "interrupted"; a.feedback = "Orchestrator was interrupted; resume from the worktree."; }
  saveState();

  let runsThisSession = 0;
  while (true) {
    if (runsThisSession >= MAX_RUNS) { log(`run budget reached (${MAX_RUNS})`); break; }
    if (state.sessionTokens >= CONFIG.budgets.maxWorkerTokensPerSession) { log("worker token budget reached"); break; }
    const issues = fetchIssues();
    const ready = readyIssues(issues, defs);
    if (!ready.length) { log("nothing ready (all remaining issues are blocked, needs-human, awaiting review, or attempt-limited)"); break; }
    const batch = ready.slice(0, CONFIG.workers.concurrency);
    log(`ready: ${ready.map((r) => "#" + r.issue.number).join(" ")} — dispatching ${batch.map((r) => "#" + r.issue.number).join(" ")}`);
    const results = await Promise.all(batch.map((c) => dispatch(jev, c).catch((e) => { log(`#${c.issue.number}: orchestrator error ${e.stack}`); return "error"; })));
    runsThisSession += batch.length;
    if (DRY || ONCE) break;
    if (results.every((r) => r === null)) break;
  }
  log(`Jev usage: ${JSON.stringify(jev.usage)}; worker tokens this session: ${state.sessionTokens}`);
}

main().catch((e) => { log(`fatal: ${e.stack}`); process.exit(1); });
