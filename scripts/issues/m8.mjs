// M8 — UI/modes (TODO §8), Evaluation (TODO §9), Hardening and release (TODO §10 / PLAN §8 Stage 8)

const S8 = `
> ### PLAN §8 Stage 8: Full-system evaluation, hardening, and release
> Scenarios 2.8 end to end; baseline comparisons; privacy/adversarial/outage/crash/migration tests; docs; packaging; install/upgrade/uninstall tests on a clean Pi.
> **Exit:** release criteria satisfied.
`;

const REL = `
> ### PLAN §10 Release acceptance criteria
> - Scope A–J implemented and documented.
> - \`plan\` → \`run <phase>\` → gates → phase gate → \`run all\` works for single and parallel workflows, attended and unattended.
> - Model selection and fallback are Jev-driven, task-specific, allowlist-bounded, budget-bounded, visible, and recorded; pinned models respected.
> - Product is fully usable without a Jev key.
> - No action exceeds approved scope, capability, or budget because a model recommended it.
> - Records survive restart with correct revision semantics; fork/resume never replays effects or reuses stale approvals.
> - Cancellation stops dispatch and child execution; worktrees remain recoverable; dirty user changes preserved.
> - Required checks cannot be bypassed by Jev, worker claims, or any tool path.
> - Privacy defaults enforced; no credential leakage in output, logs, artifacts, or exports.
> - Installs, upgrades, disables, and uninstalls cleanly on a clean Pi on supported platforms.
> - Evaluation results and limitations published.
`;

export default [
  // ---- UI and operating modes (TODO §8) ----
  {
    key: "m8-commands",
    title: "Namespace conflict check and all remaining `/korwf` commands (review, why, mode, off, eval)",
    milestone: "M8",
    labels: ["stage:8", "type:feature", "area:extension"],
    planRef: "§4 User interface",
    todoRef: "§8 'Namespace conflict check; all /korwf commands from PLAN §4'",
    context: `
Earlier stages added plan, run, tasks, phases, status, models, pause/resume/cancel, export, cleanup. This issue adds the rest and verifies at load time that no other installed extension registers a conflicting \`korwf\` command/tool name.
`,
    plan: `
> ### PLAN §4 User interface
> \`/korwf review\` — artifacts and verification coverage. \`/korwf why <decision>\` — decision inputs and policy application. \`/korwf mode\` — shadow, advisory, supervised, bounded autonomous. \`/korwf off\` — disable optional assistance; never removes required safety controls or abandons running workers. \`/korwf eval\` — explicit, budget-approved evaluation runs.
${S8}`,
    scope: ["`review`: per task/phase — artifacts, checkpoints, evidence, coverage of criteria by checks.", "`why <decisionId>`: recorded inputs (sanitised), raw distribution, rule applied, versions — never a generated explanation.", "`mode` get/set with approval-requirement summary printed independently of mode name.", "`off`: disables Jev-assisted features and suggestions; safety gates, budgets, and running workers unaffected.", "`eval`: entry point for Stage 8 evaluation runs; refuses without an explicit budget argument.", "Conflict check on load."],
    deliverables: ["`src/extension/commands/{review,why,mode,off,eval}.ts`, `src/extension/conflicts.ts`."],
    acceptance: ["`why` output is assembled only from Decision/Trace fields (test asserts no model call).", "`off` while a worker runs leaves the worker running and gates active.", "Conflicting extension in a test harness → clear load error naming the conflict."],
    verification: ["`npm test -- commands`"],
    files: ["src/extension/commands/", "src/extension/conflicts.ts"],
    deps: ["m7-instruction-diffs"],
  },
  {
    key: "m8-modes",
    title: "Shadow, advisory, supervised, bounded-autonomous modes with approval requirements documented independently of mode names",
    milestone: "M8",
    labels: ["stage:8", "type:feature", "area:workflow", "area:docs", "risk:high"],
    planRef: "§4 UI (`/korwf mode`), §2.6, §0",
    todoRef: "§8 'Shadow, advisory, supervised, bounded-autonomous modes; approval requirements documented independently of mode names'",
    context: `
Define precisely what each mode does: shadow (Jev evaluates, nothing acts; decisions logged for calibration), advisory (suggestions shown, user acts), supervised (product acts, every non-auto class prompts), bounded autonomous (unattended policy applies). Document the approval table per mode so a user can understand it without the mode name.
`,
    plan: `
> ### PLAN §0
> Enabling autonomous operation requires explicit operating policy and evidence, gathered from the product's own lower operating modes on real tasks, that it meets its acceptance criteria.
${S8}`,
    scope: ["Mode semantics implemented as a policy layer over scheduler/unattended/approvals.", "Shadow mode records Decisions with `action: none` for calibration (Stage 8 eval uses them).", "Bounded-autonomous requires a config flag `autonomy.evidenceAccepted` that only the user can set, with a pointer to the evidence report.", "`docs/modes.md`."],
    deliverables: ["`src/workflow/modes.ts`, `docs/modes.md`."],
    acceptance: ["Shadow mode performs zero mutations (spy on all mutation routes).", "Bounded-autonomous refused without the evidence flag.", "Docs table lists every approval class × mode."],
    verification: ["`npm test -- modes`"],
    files: ["src/workflow/modes.ts", "docs/modes.md"],
    deps: ["m8-commands"],
  },
  {
    key: "m8-non-interactive",
    title: "Non-interactive operation never hangs on prompts; ordinary Pi behaviour preserved when assistance is unavailable",
    milestone: "M8",
    labels: ["stage:8", "type:feature", "area:extension"],
    planRef: "§3.J, §4 UI (`off`)",
    todoRef: "§8 'Non-interactive operation never hangs on prompts' and 'Ordinary Pi behaviour preserved when assistance is unavailable'",
    context: `
Two robustness properties across every prompt and hook: in non-TTY/RPC mode any prompt resolves to the queue/stop policy without blocking; and if the extension's optional features are off or Jev/storage is broken, Pi still works normally.
`,
    plan: `
> ### PLAN §3.J
> Runs without a Jev key: deterministic workflow fully functional; Jev features off with a clear message.
${S8}`,
    scope: ["Audit every prompt site; central `prompt()` helper with non-interactive fallback.", "Fault injection: storage unavailable, Jev breaker open, config invalid → extension reports degraded status and does not intercept normal Pi turns."],
    deliverables: ["`src/extension/prompt.ts`; fault-injection tests."],
    acceptance: ["RPC-mode run with a pending approval completes the rest of the phase and exits with the approval queued (no hang, test with timeout).", "With storage dir read-only, a plain Pi conversation turn is unaffected (test)."],
    verification: ["`npm test -- non-interactive degraded`"],
    files: ["src/extension/prompt.ts", "test/integration/degraded/"],
    deps: ["m8-commands"],
  },

  // ---- Evaluation (TODO §9, PLAN §9) ----
  {
    key: "m8-baseline",
    title: "Measure normal-Pi baseline on real work; then set numeric thresholds",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:evaluation", "needs-human"],
    planRef: "§9",
    todoRef: "§9 'Measure normal-Pi baseline on real work; then set numeric thresholds'",
    context: `
Before comparing configurations, record how plain Pi performs on the pilot task set (M0): time to verified completion, intervention time, success, regressions, cost. This is done by Lee (or an agent under Lee's supervision) on the pilot repo. Thresholds for the comparison are set only after the baseline exists.
`,
    plan: `
> ### PLAN §9 Evaluation strategy
> Compare (1) normal Pi, (2) KorWF-Pi with Jev disabled, (3) KorWF-Pi with Jev. Baseline distribution for (1) is measured first on the author's real work, then numeric thresholds are set, then (2) and (3) are run. Measure: time to verified completion, intervention time, task success, regressions, missed requirements, retrieval omissions, false warnings/escalations, wrong routing, fallback correctness, total cost, latency.
${S8}`,
    scope: ["Measurement protocol doc and a recording helper (`korwf eval baseline`).", "Run on the pilot task set within M0 budgets.", "Threshold proposal from the distribution; Lee approves."],
    deliverables: ["`docs/evaluation/protocol.md`, `docs/evaluation/baseline.md`, `docs/evaluation/thresholds.md`."],
    acceptance: ["Baseline has ≥ 10 tasks with all metrics recorded.", "Thresholds document is approved by Lee in a comment."],
    verification: ["`ls docs/evaluation/*.md | wc -l` ≥ 3"],
    files: ["docs/evaluation/", "src/evaluation/baseline.ts"],
    deps: ["m8-modes", "m0-pilot", "m0-budgets"],
  },
  {
    key: "m8-fixtures-replay",
    title: "Representative task set, held-out split, sanitised fixtures, replay tooling",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:evaluation"],
    planRef: "§3.I, §9",
    todoRef: "§9 'Representative task set and held-out split; sanitised fixtures; replay tooling'",
    context: `
Reproducible evaluation needs recorded, sanitised Jev/model responses that can be replayed offline. Build the recorder (behind the outbound filter), the fixture format, and the replay transport, plus a fixed train/held-out split of the task set.
`,
    plan: `
> ### PLAN §3.I
> Reproducible replay with recorded, sanitised responses.
${S8}`,
    scope: ["`RecordingTransport` wrapping the real one; fixtures under `test/fixtures/replay/` with secrets stripped and a manifest.", "`ReplayTransport` for tests and `korwf eval replay`.", "Split file with task ids; held-out never used for tuning."],
    deliverables: ["`src/evaluation/replay.ts`, `test/fixtures/replay/`, `docs/evaluation/task-set.md`."],
    acceptance: ["Replay of a recorded run reproduces identical Decision results (hash compare).", "Fixture scan finds no secrets."],
    verification: ["`npm test -- replay`", "`bash scripts/check-secrets.sh test/fixtures/replay`"],
    files: ["src/evaluation/replay.ts", "test/fixtures/replay/"],
    deps: ["m8-baseline"],
  },
  {
    key: "m8-comparison",
    title: "Run no-Jev and Jev configurations; per-question-family ablations",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:evaluation", "needs-human"],
    planRef: "§9",
    todoRef: "§9 'Run no-Jev and Jev configurations; per-question-family ablations'",
    context: `
The main comparison against the baseline thresholds, plus ablations that disable one Jev question family at a time to show which ones earn their cost. Live runs require Lee's budget approval on this issue.
`,
    plan: `
> ### PLAN §9
> Ablations per Jev question family. Held-out split for question/routing changes.
${S8}`,
    scope: ["`korwf eval compare --config <name>` producing metric tables.", "Ablation flags per family in config.", "Report with confidence intervals; comparison to thresholds."],
    deliverables: ["`docs/evaluation/results.md`, `src/evaluation/compare.ts`."],
    acceptance: ["Results for (1), (2), (3) and each ablation on the held-out set.", "Cost per run reported; within M0 budget."],
    verification: ["`test -f docs/evaluation/results.md`"],
    files: ["src/evaluation/compare.ts", "docs/evaluation/results.md"],
    deps: ["m8-fixtures-replay"],
  },
  {
    key: "m8-calibration",
    title: "Calibrate evaluators from shadow/advisory logs; abstention coverage and error rates",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:evaluation", "area:decisions"],
    planRef: "§6",
    todoRef: "§9 'Calibrate evaluators from shadow/advisory logs; abstention coverage and error rates'",
    context: `
Thresholds for each Jev question and risk class were conservative defaults. Using Decision records from shadow/advisory runs with known outcomes, compute calibration curves, choose thresholds per evaluator and risk class, and report abstention rates and error rates. Update config defaults only through a reviewed PR.
`,
    plan: `
> ### PLAN §6
> Thresholds calibrated per evaluator and risk class. Calibration data comes from the product's own shadow and advisory modes on real tasks; until enough data exists, use conservative defaults and abstention.
${S8}`,
    scope: ["`korwf eval calibrate` over Decision + outcome records.", "Per-question reliability diagram data and chosen thresholds with rationale.", "Minimum-n rule: below it, keep defaults."],
    deliverables: ["`src/evaluation/calibrate.ts`, `docs/evaluation/calibration.md`."],
    acceptance: ["Calibration report for every question family with n ≥ minimum; others listed as insufficient data.", "Threshold changes land as a config-defaults PR with the report linked."],
    verification: ["`npm test -- calibrate`"],
    files: ["src/evaluation/calibrate.ts", "docs/evaluation/calibration.md"],
    deps: ["m8-comparison"],
  },
  {
    key: "m8-adversarial",
    title: "Adversarial suite: missing info, contradictions, injection, secrets, misleading descriptions",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:security", "risk:high"],
    planRef: "§7, §9",
    todoRef: "§9 'Adversarial suite'",
    context: `
A separate suite that tries to make the product do the wrong thing: tasks with missing information (should ask, not guess), contradictory instructions (should surface), prompt injection in repo/tool output at every stage (should be inert), secrets in files (must never leave), misleading task descriptions (gate must catch). Extends the Stage 3 injection tests to the full pipeline.
`,
    plan: `
> ### PLAN §9
> Separate adversarial/failure suite.
>
> ### PLAN §7
> Jev prompt-injection signals never authorise execution or data release.
${S8}`,
    scope: ["Fixture repos per attack class.", "Assertions on: no unauthorised transition, no outbound secret, no policy change, correct escalation."],
    deliverables: ["`test/adversarial/**`."],
    acceptance: ["Every attack class has ≥ 3 fixtures; all pass.", "Suite runs in CI on every PR."],
    verification: ["`npm test -- adversarial`"],
    files: ["test/adversarial/"],
    deps: ["m8-non-interactive"],
  },
  {
    key: "m8-fallback-eval",
    title: "Fallback correctness and wrong-routing measurement",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:evaluation", "area:models"],
    planRef: "§9",
    todoRef: "§9 'Fallback correctness and wrong-routing measurement'",
    context: `
Measure, on replayed and (budget-approved) live runs, how often selection picks an inadequate model, how often fallback chooses correctly under simulated caps, and whether the anti-oscillation/prefer-wait policies behave as configured.
`,
    plan: `
> ### PLAN §9
> Measure: wrong routing, fallback correctness.
${S8}`,
    scope: ["Labelled task→adequate-model-set fixtures.", "Cap simulation matrix (single cap, all capped, reset timing).", "Metrics into `docs/evaluation/results.md`."],
    deliverables: ["`src/evaluation/routing-metrics.ts`."],
    acceptance: ["Wrong-routing rate and fallback-correctness rate reported with n.", "All cap-matrix cases produce the policy-expected outcome."],
    verification: ["`npm test -- routing-metrics`"],
    files: ["src/evaluation/routing-metrics.ts"],
    deps: ["m8-comparison"],
  },
  {
    key: "m8-live-runs",
    title: "Capped live Jev and model-comparison runs within approved budgets",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:evaluation", "needs-human", "risk:high"],
    planRef: "§9",
    todoRef: "§9 'Capped live Jev and model-comparison runs within approved budgets'",
    context: `
The only issue that authorises live TypeSafe and model-provider requests during evaluation. Runs only with Lee's explicit budget comment here; every run reports its cost; caps enforced by the product's own ledger.
`,
    plan: `
> ### PLAN §9
> Mocked tests never authorise live requests; live runs need explicit budgets.
${S8}`,
    scope: ["Run the comparison, fallback, and scenario suites live on the pilot repo.", "Record sanitised fixtures for future replay."],
    deliverables: ["Updated `docs/evaluation/results.md` with live sections and costs."],
    acceptance: ["Lee's budget comment precedes any run.", "Total cost ≤ approved; ledger report attached."],
    verification: ["Ledger export attached to the PR"],
    files: ["docs/evaluation/results.md"],
    deps: ["m8-calibration", "m8-fallback-eval", "m8-adversarial", "m0-budgets"],
  },

  // ---- Hardening and release (TODO §10) ----
  {
    key: "m8-scenarios",
    title: "PLAN §2.8 scenarios 1–4 end to end",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:evaluation"],
    planRef: "§2.8, §10",
    todoRef: "§10 'Scenarios 2.8 end to end'",
    context: `
Scenarios 1 and 4 were implemented in Stages 6 and 5; 2 and 3 partially in Stage 4. This issue completes all four as full end-to-end tests (Jev-enabled via replay, Jev-disabled) from the Stage 1 outlines and adds them to CI.
`,
    plan: `
> ### PLAN §2.8 Scenarios
> 1 Greenfield app, phase 1. 2 Feature on an existing repo. 3 Worker claims done, test is wrong. 4 Cap hit mid-task.
${REL}${S8}`,
    scope: ["`test/integration/scenarios/0[1-4]-*.test.ts` complete in both variants."],
    deliverables: ["Four scenario tests × two variants."],
    acceptance: ["Every assertion in the Stage 1 outlines maps to a test assertion (traceability table in PR).", "All pass on CI, Linux and macOS."],
    verification: ["`npm test -- scenarios`"],
    files: ["test/integration/scenarios/"],
    deps: ["m8-non-interactive", "m8-fixtures-replay"],
  },
  {
    key: "m8-lifecycle-hardening",
    title: "Pause/resume/reload/restart/fork/tree transitions; cancellation at every async boundary",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:workflow", "area:extension", "risk:high"],
    planRef: "§10",
    todoRef: "§10 'Pause/resume/reload/restart/fork/tree transitions; cancellation at every async boundary'",
    context: `
Systematic test of every lifecycle transition against a running workflow, and a cancellation sweep that aborts at each awaited boundary in the scheduler/worker/verification paths to prove nothing leaks or corrupts.
`,
    plan: REL + S8,
    scope: ["Transition matrix test.", "Cancellation fuzzing: inject abort at each `await` site (instrumented) and assert invariants: no orphan processes, store consistent, worktrees recoverable, user tree untouched."],
    deliverables: ["`test/hardening/lifecycle.test.ts`, `test/hardening/cancel-sweep.test.ts`."],
    acceptance: ["Matrix complete; all invariants hold at every injection point."],
    verification: ["`npm test -- hardening/lifecycle hardening/cancel`"],
    files: ["test/hardening/"],
    deps: ["m8-scenarios"],
  },
  {
    key: "m8-fault-hardening",
    title: "Outages, malformed responses, disk failures, migrations, scheduler races",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:storage", "area:jev"],
    planRef: "§10, §8 Stage 8",
    todoRef: "§10 'Outages, malformed responses, disk failures, migrations, scheduler races'",
    context: `
Fault-injection suite: TypeSafe down, provider down, garbage responses, ENOSPC during artifact write, SQLite locked, migration from every prior schema version with real data, and concurrent scheduler operations.
`,
    plan: REL + S8,
    scope: ["One test group per fault class with invariants: no hang, no data loss, degraded status visible, resumable."],
    deliverables: ["`test/hardening/faults/*.test.ts`."],
    acceptance: ["All fault classes covered; migration matrix passes for every version in `src/storage/migrations/`."],
    verification: ["`npm test -- hardening/faults`"],
    files: ["test/hardening/faults/"],
    deps: ["m8-scenarios"],
  },
  {
    key: "m8-leak-audit",
    title: "No credential leakage in output, logs, artifacts, exports; no gate bypass via bash / custom tools / worker launch paths",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:security", "risk:high"],
    planRef: "§10",
    todoRef: "§10 'No credential leakage…' and 'No gate bypass via bash/custom tools/worker launch paths'",
    context: `
Final security audit as tests: seed a canary key and canary file contents, run every scenario, and scan every byte the product wrote or printed. Separately, attempt every known route to set a task \`done\` or alter policy from inside a worker.
`,
    plan: `
> ### PLAN §10
> Required checks cannot be bypassed by Jev, worker claims, or any tool path. Privacy defaults enforced; no credential leakage in output, logs, artifacts, or exports.
${S8}`,
    scope: ["Canary sweep across stdout, session files, `.korwf/**`, exports.", "Bypass attempts: direct store write from worker (blocked by path policy), forged evidence, forged approval, transition call, config edit."],
    deliverables: ["`test/hardening/leaks.test.ts`, `test/hardening/bypass.test.ts`, `docs/security-audit.md`."],
    acceptance: ["Zero canary hits.", "Every bypass attempt rejected and audited; list in the doc."],
    verification: ["`npm test -- hardening/leaks hardening/bypass`"],
    files: ["test/hardening/", "docs/security-audit.md"],
    deps: ["m8-adversarial", "m8-lifecycle-hardening"],
  },
  {
    key: "m8-user-changes",
    title: "User changes survive failures and rollback",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:workflow"],
    planRef: "§10",
    todoRef: "§10 'User changes survive failures and rollback'",
    context: `
End-to-end proof that a user's uncommitted work in the main tree is untouched by any product operation, including failures, cancellation, rollback, cleanup, and integration merges.
`,
    plan: REL + S8,
    scope: ["Seed dirty changes; run each operation; hash compare."],
    deliverables: ["`test/hardening/user-changes.test.ts`."],
    acceptance: ["All operations leave the user's dirty files byte-identical."],
    verification: ["`npm test -- user-changes`"],
    files: ["test/hardening/user-changes.test.ts"],
    deps: ["m8-lifecycle-hardening"],
  },
  {
    key: "m8-docs",
    title: "README, configuration reference, architecture guide, limitations, privacy/cost disclosure",
    milestone: "M8",
    labels: ["stage:8", "type:docs", "area:docs"],
    planRef: "§3.J",
    todoRef: "§10 'README, configuration reference, architecture guide, limitations, privacy/cost disclosure'",
    context: `
Public-facing documentation for the release. The configuration reference exists from Stage 1 and must be regenerated from the final schema; the architecture guide summarises the ADRs; limitations are honest and specific.
`,
    plan: `
> ### PLAN §3.J
> README, configuration reference, architecture guide, limitations, and cost/privacy disclosure at first use.
${S8}`,
    scope: ["README rewrite for users (install, first run, commands, modes).", "`docs/configuration.md` generated from schema (script).", "`docs/architecture.md`, `docs/limitations.md`, `docs/privacy-and-cost.md` (same text as the first-use disclosure)."],
    deliverables: ["All listed docs; `scripts/gen-config-docs.mjs`."],
    acceptance: ["Config docs regenerate identically from the schema (CI check).", "Limitations lists every `not_evaluated`/degraded behaviour and Windows status.", "First-use disclosure text and `docs/privacy-and-cost.md` are the same source."],
    verification: ["`node scripts/gen-config-docs.mjs --check`"],
    files: ["README.md", "docs/"],
    deps: ["m8-scenarios"],
  },
  {
    key: "m8-install",
    title: "Install / upgrade / disable / rollback / uninstall on a clean Pi; platform support statement",
    milestone: "M8",
    labels: ["stage:8", "type:test", "area:extension", "area:docs"],
    planRef: "§3.J, §10",
    todoRef: "§10 'Install/upgrade/disable/rollback/uninstall on a clean Pi; platform support statement'",
    context: `
Package lifecycle tests using Pi's package mechanism on a clean temporary Pi install, Linux and macOS in CI. Upgrade test installs the previous tag, creates state, upgrades, and verifies migrations. Uninstall leaves no files outside the project's \`.korwf/\` (which is reported to the user, not deleted).
`,
    plan: `
> ### PLAN §3.J
> Install/upgrade/disable/uninstall through Pi's mechanism; documented platform support (Linux, macOS; Windows status stated explicitly).
${S8}`,
    scope: ["CI job per platform running the lifecycle.", "`docs/platform-support.md` finalised."],
    deliverables: ["`.github/workflows/package-lifecycle.yml`, `test/package/*.sh`."],
    acceptance: ["All five operations succeed on both platforms.", "Upgrade preserves workflow records (count compare)."],
    verification: ["CI workflow green; link in PR"],
    files: [".github/workflows/package-lifecycle.yml", "test/package/"],
    deps: ["m8-docs", "m8-fault-hardening"],
  },
  {
    key: "m8-publish-eval",
    title: "Publish evaluation results and limitations",
    milestone: "M8",
    labels: ["stage:8", "type:docs", "area:evaluation", "area:docs"],
    planRef: "§10",
    todoRef: "§10 'Publish evaluation results and limitations'",
    context: `
Final evaluation write-up in the repo: methodology, baseline, comparison, ablations, calibration, adversarial results, fallback metrics, costs, and known limitations — with the replay fixtures so others can reproduce offline.
`,
    plan: REL + S8,
    scope: ["`docs/evaluation/README.md` linking every report; summary table in README."],
    deliverables: ["Evaluation index and README summary."],
    acceptance: ["Every metric in PLAN §9 has a reported value or an explicit 'not measured' with reason."],
    verification: ["`test -f docs/evaluation/README.md`"],
    files: ["docs/evaluation/README.md", "README.md"],
    deps: ["m8-live-runs", "m8-docs"],
  },
  {
    key: "m8-release",
    title: "Release: verify PLAN §10 criteria, tag v1.0.0, install on Lee's Pi with explicit approval",
    milestone: "M8",
    labels: ["stage:8", "type:approval", "needs-human", "risk:high"],
    planRef: "§10",
    todoRef: "§10 'Explicit installation and operating-mode approval; install and verify existing Pi workflows'",
    context: `
The final gate. An agent prepares a release checklist mapping every PLAN §10 criterion to the evidence (test names, docs, CI links). Lee reviews, approves the operating mode for daily use, and the package is installed on Lee's own Pi. Existing Pi workflows on that machine must be verified unaffected.
`,
    plan: REL + S8,
    scope: ["`docs/release-checklist.md` with evidence per criterion.", "Tag and GitHub release with notes.", "Post-install verification on Lee's machine: `/korwf version`, an existing non-KorWF workflow, `/korwf off` behaviour."],
    deliverables: ["Checklist, tag `v1.0.0`, release notes."],
    acceptance: ["Every §10 criterion has linked evidence.", "Lee's approval comment for installation and mode.", "Post-install verification transcript attached."],
    verification: ["`git tag --list v1.0.0`"],
    files: ["docs/release-checklist.md"],
    deps: ["m8-install", "m8-publish-eval", "m8-leak-audit", "m8-user-changes"],
  },
];
