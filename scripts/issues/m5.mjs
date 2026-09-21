// M5 — Model catalog, Jev selection, fallback, single-worker execution (PLAN §8 Stage 5)

const S5 = `
> ### PLAN §8 Stage 5
> Catalog and model cards; task profiles; Jev selection; allowlist/budget enforcement; cap detection and ModelAvailability; fallback policies including mid-task handoff; worker processes and contracts; single-worker end-to-end run; pause/cancel.
> **Exit:** a task executes in isolation with Jev-chosen model, survives a simulated cap with a visible fallback, and reports accurate state.
`;

const D_PRINCIPLE = `
> ### PLAN §3.D Principle
> Model selection is task-specific and Jev decides — initially and on every fallback — within the user's configured allowlist and budgets. Selection is automatic and visible, never silent. The system never uses a provider or model outside the allowlist.
`;

export default [
  {
    key: "m5-catalog",
    title: "Model catalog from Pi registry filtered by allowlist; no credentials exposed",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models"],
    planRef: "§3.D Allowlist, Model cards layer 1",
    todoRef: "§5 'Catalog from Pi registry filtered by allowlist; no credentials exposed'",
    context: `
Build the eligible-model set: Pi registry (fields confirmed in \`docs/model-registry-fields.md\`) ∩ Pi's enabled models ∩ config allowlist. Catalog entries expose only what Jev and the UI need; provider base URLs and keys never enter the catalog.
`,
    plan: `${D_PRINCIPLE}
> ### PLAN §3.D Allowlist
> Eligible models are whatever the user's Pi has configured, filtered by an optional provider/model allowlist in config. Default: all configured models.
${S5}`,
    scope: ["`buildCatalog(ctx, config)` → `CatalogEntry[]` with id, provider, name, reasoning, thinkingLevelMap, input modalities, contextWindow, maxTokens, cost (or `unknown`).", "Allowlist filter with audit of excluded models and why.", "Catalog refresh on Pi model-registry change events (from the integration map)."],
    deliverables: ["`src/models/catalog.ts`."],
    acceptance: ["A model outside the allowlist never appears in the catalog (test with a fake registry).", "Serialised catalog contains no URL or key (assert by regex).", "Zero-cost proxied model is represented with `cost: unknown`, not 0 (see Stage 2 accounting)."],
    verification: ["`npm test -- catalog`"],
    files: ["src/models/catalog.ts"],
    deps: ["m2-load-tests", "m1-model-registry"],
  },
  {
    key: "m5-cards",
    title: "Model cards: four-layer merge (registry → bundled hints → user overrides → outcome refinement)",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models"],
    planRef: "§3.D Model cards",
    todoRef: "§5 'Model cards, four layers'",
    context: `
Jev ranks models against cards, not bare IDs. A card merges four sources so no one source needs to be complete, and it must be able to say "unrated" so Jev can answer "not enough information".
`,
    plan: `
> ### PLAN §3.D Model cards
> The catalog carries a card per model, merged from four layers:
> 1. **Pi registry metadata (automatic).** Sufficient for hard-constraint filtering.
> 2. **Bundled aptitude hints (shipped, versioned).** Model families by id pattern → short aptitude descriptions. Unknown models get an explicit "unrated" card.
> 3. **User overrides (config).** Per-model notes, aptitude corrections, and pins.
> 4. **Measured outcomes (per user, grows over time).** \`ModelOutcome\` records refine the card with uncertainty for sparse data.
>
> Registry metadata excludes candidates; hints, overrides, and outcomes rank them. A thin card lets Jev answer "not enough information", which routes to the static fallback order.
${S5}`,
    scope: ["`ModelCard` type: hard constraints (from registry), aptitudes (tagged strings with source layer), pins, outcome stats (n, success rate, mean cost/latency, confidence interval), `rated: boolean`.", "`mergeCards(catalog, hints, overrides, outcomes)`; later layers override earlier for the same aptitude tag; provenance kept per field.", "Outcome refinement uses a simple Bayesian/Wilson interval so n=1 does not swing the card."],
    deliverables: ["`src/models/cards.ts`."],
    acceptance: ["Unknown model id → card with `rated: false` and no aptitudes.", "User override replaces a bundled hint and the field's provenance says `user`.", "Outcome with n=1 changes the interval, not the point estimate materially (documented test)."],
    verification: ["`npm test -- cards`"],
    files: ["src/models/cards.ts"],
    deps: ["m5-catalog"],
  },
  {
    key: "m5-hints",
    title: "Bundled aptitude-hints file: id-pattern matching, versioned, 'unrated' default, update process",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models", "area:docs"],
    planRef: "§3.D Model cards layer 2",
    todoRef: "§5 'Bundled aptitude-hints file'",
    context: `
The shipped hints file. Small, versioned, pattern-matched so proxied/local model names (e.g. \`mac-mini/some-model-name\`) still match a family. Must not contain anything author-specific; families only.
`,
    plan: `
> ### PLAN §3.D layer 2
> A small package file mapping model families (by id pattern, so proxied/local names match) to short aptitude descriptions — e.g. front-end/UI, deep reasoning, large refactors, tool use, speed. Unknown models get an explicit "unrated" card so Jev knows the gap. Kept small and updated with the package.
${S5}`,
    scope: ["`src/models/hints.json` with `version`, and entries `{pattern: regex, family, aptitudes[], caveats[]}`.", "Matcher that ignores provider prefix and common suffixes (dates, quantisation tags).", "`docs/model-hints.md`: how to propose an update, review rules, and that hints are advisory."],
    deliverables: ["`src/models/hints.json`, `src/models/hints.ts`, `docs/model-hints.md`."],
    acceptance: ["Pattern test table with ≥ 20 ids including proxied forms; each maps to the intended family or `unrated`.", "File contains no provider hostnames or user-specific ids (`mac-mini` must not appear).", "Schema-validated on load; invalid file → hints disabled with a message, not a crash."],
    verification: ["`npm test -- hints`", "`! grep -n 'mac-mini' src/models/hints.json`"],
    files: ["src/models/hints.json", "src/models/hints.ts", "docs/model-hints.md"],
    deps: ["m5-cards"],
  },
  {
    key: "m5-task-profile",
    title: "Task-profile evaluator independent of model names",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:decisions", "area:models"],
    planRef: "§3.D Task profile, §6",
    todoRef: "§5 'Task-profile evaluator independent of model names'",
    context: `
Before selecting a model, Jev characterises the task: domain (e.g. front-end, backend, infra, docs), modality needs (images?), reasoning depth, expected context size, risk. The profile is stored on the Attempt and is the input to selection — it never mentions models.
`,
    plan: `
> ### PLAN §3.D Task profile
> Jev characterises each task (domain, modality needs, reasoning depth, context size, risk) independently of model names.
${S5}`,
    scope: ["`TaskProfile` type.", "Questions: `profile.domain@1` (Choice), `profile.reasoningDepth@1` (Score), `profile.contextSize@1` (Choice: small/medium/large), modality from deterministic detection (attachments), risk from the task's riskClass.", "Fallback when disabled: domain from ownership path heuristics; depth `unknown`."],
    deliverables: ["`src/models/profile.ts`, `src/decisions/questions/profile.ts`."],
    acceptance: ["Profile output type has no model-id field (compile-time).", "Fixture tasks map to expected domains with mock Jev and with fallback."],
    verification: ["`npm test -- profile`"],
    files: ["src/models/profile.ts", "src/decisions/questions/profile.ts"],
    deps: ["m5-cards"],
  },
  {
    key: "m5-selection",
    title: "Jev model selection against cards; code enforces allowlist, budget, and policy after selection",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models", "area:decisions", "risk:high"],
    planRef: "§3.D Selection",
    todoRef: "§5 'Jev selection question against cards; code enforces allowlist/budget/policy after selection'",
    context: `
The core routing decision. Jev ranks eligible cards for the task profile; code then re-checks the pick against the allowlist, budget, and policy (defence in depth — Jev's answer is never trusted to be in bounds). Jev may answer "none adequate" or "not enough information".
`,
    plan: `${D_PRINCIPLE}
> ### PLAN §3.D Selection
> Jev chooses from the eligible candidates for the task profile. Code enforces allowlist, budget, and policy after selection.
>
> ### PLAN §3.D Caps and fallback
> No adequate substitute: Jev may answer "none adequate" for hard tasks → pause rather than degrade silently. Jev unavailable: use the static fallback ordering from config.
${S5}`,
    scope: ["`selectModel(profile, cards, ledger, config)` → `{model, rationale, decisionId} | {none: 'inadequate'|'insufficient_info'}`.", "Question `models.rank@1` (Noul: ranked list with per-candidate adequacy) over minimal card summaries.", "Post-selection enforcement: reject if not in allowlist, if reservation fails, or if policy forbids the model for the risk class — audit and re-ask excluding it (bounded).", "Disabled/insufficient-info fallback: first available in static order."],
    deliverables: ["`src/models/select.ts`, `src/decisions/questions/models.ts`."],
    acceptance: ["Mock Jev returning an out-of-allowlist id → rejected, audited, next candidate used (test).", "`none adequate` → returns `none`, no model used.", "Static order used when Jev disabled; selection is still recorded as a Decision with rule `static`."],
    verification: ["`npm test -- select`"],
    files: ["src/models/select.ts", "src/decisions/questions/models.ts"],
    deps: ["m5-task-profile", "m5-hints", "m2-accounting"],
  },
  {
    key: "m5-pins",
    title: "User pins and explicit overrides",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models", "area:config"],
    planRef: "§3.D Model cards layer 3, Caps and fallback (pinned)",
    todoRef: "§5 'User pins and explicit overrides'",
    context: `
A user may pin a model globally, per phase, or per task, or override a selection interactively. Pins bypass Jev ranking but not the allowlist/budget checks; fallback from a pinned model requires asking the user (or the unattended policy's class for it).
`,
    plan: `
> ### PLAN §3.D
> User overrides (config): optional per-model notes, aptitude corrections, and pins. Pinned model: user pins are not overridden by fallback without asking.
${S5}`,
    scope: ["Pin resolution order: task > phase > workflow > config.", "`/korwf models pin <model> [--task|--phase]` and `unpin`.", "Pinned selection still passes post-selection enforcement; recorded with rule `pin`."],
    deliverables: ["`src/models/pins.ts`, command in `src/extension/commands/models.ts`."],
    acceptance: ["Pinned model used regardless of mock Jev ranking.", "Pinned model outside allowlist → error explaining why, not silent use.", "Fallback from a pin triggers approval class `model-substitute-pinned`."],
    verification: ["`npm test -- pins`"],
    files: ["src/models/pins.ts", "src/extension/commands/models.ts"],
    deps: ["m5-selection"],
  },
  {
    key: "m5-caps",
    title: "Cap detection (429, quota, budget) → ModelAvailability with estimated reset",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models", "area:telemetry"],
    planRef: "§3.D Caps and fallback",
    todoRef: "§5 'Cap detection (429, quota, budget) → ModelAvailability with estimated reset'",
    context: `
Code, not Jev, detects that a model is unavailable: HTTP 429, provider quota messages, our own budget cap. Each detection writes a ModelAvailability record with cap kind, time, and an estimated reset (from headers if present, else a config default per kind).
`,
    plan: `
> ### PLAN §3.D Caps and fallback
> Code detects quota exhaustion, rate limits, and budget caps, and records them in ModelAvailability with an estimated reset.
${S5}`,
    scope: ["Detector over provider errors (patterns from the Stage 1 TypeSafe doc and Pi's provider error shapes from the integration map).", "`ModelAvailability` repo: set/clear cap; `isAvailable(model, now)`.", "Budget cap from the ledger → availability `capped: budget` for the scope."],
    deliverables: ["`src/models/availability.ts`."],
    acceptance: ["Fixture errors for 429 with `retry-after`, quota text, and budget exceeded each produce the right cap kind and reset estimate.", "`isAvailable` flips back after the estimated reset (fake clock)."],
    verification: ["`npm test -- availability`"],
    files: ["src/models/availability.ts"],
    deps: ["m5-catalog", "m4-failure-taxonomy"],
  },
  {
    key: "m5-fallback",
    title: "Fallback ranking: Jev ranks substitutes for the task profile; 'none adequate' → pause; static order when Jev unavailable",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models", "area:decisions"],
    planRef: "§3.D Caps and fallback",
    todoRef: "§5 'Fallback: Jev ranks substitutes…' and 'Static fallback order when Jev unavailable'",
    context: `
On a cap, re-run selection over the still-available candidates for the same task profile. If Jev says none is adequate, pause the task/phase with a visible state rather than degrading. If Jev is unavailable, walk the static order. All of this is recorded on the Attempt.
`,
    plan: `
> ### PLAN §3.D Caps and fallback
> On a cap, Jev ranks the remaining candidates for the task profile and the workflow switches. All candidates capped: pause the phase, surface state, resume when a cap clears. Not a failure. No adequate substitute: pause rather than degrade silently. Jev unavailable: use the static fallback ordering from config.
${S5}`,
    scope: ["`chooseFallback(attempt, availability)` → substitute | pause reason.", "`paused(cap)` state entry with auto-resume when `isAvailable` becomes true for any candidate (poll interval from config).", "Attempt fields: `requested_model`, `used_model`, `fallback_reason` set on every switch."],
    deliverables: ["`src/models/fallback.ts`."],
    acceptance: ["All candidates capped → task `paused(cap)`, phase paused, status shows earliest estimated reset.", "Cap clears (fake clock) → auto-resume without user action.", "Attempt record shows both models and the reason after a switch."],
    verification: ["`npm test -- fallback`"],
    files: ["src/models/fallback.ts"],
    deps: ["m5-selection", "m5-caps", "m5-pins"],
  },
  {
    key: "m5-handoff",
    title: "Mid-task handoff packet with intact worktree; restart alternative per task-kind policy",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models", "area:workers", "area:memory"],
    planRef: "§3.D Caps and fallback (mid-task), §3.H",
    todoRef: "§5 'Mid-task handoff packet with intact worktree; restart alternative per task-kind policy'",
    context: `
When a cap hits mid-task, the default is to hand the same worktree to a substitute model with an explicit handoff packet (task, criteria, checks, what has been done, what remains, open questions, last evidence). Some task kinds are better restarted; policy decides per kind.
`,
    plan: `
> ### PLAN §3.D
> Mid-task: hand off with an explicit handoff packet and intact worktree (default), or restart the task, per task-kind policy.
>
> ### PLAN §3.H
> Explicit handoff packets for workers, model fallback (D), and resumed sessions.
${S5}`,
    scope: ["`HandoffPacket` schema and builder from Attempt + Evidence + worker progress notes (written by the worker at checkpoints).", "Policy table: task kind → handoff | restart.", "Restart = new Attempt from the last checkpoint; handoff = same worktree, new Attempt linked to the previous."],
    deliverables: ["`src/workers/handoff.ts`, `src/memory/handoff-packet.ts`."],
    acceptance: ["Packet contains every field listed above and passes the outbound filter.", "Handoff keeps the worktree's uncommitted changes (test).", "Restart discards them to the last checkpoint and says so in the audit."],
    verification: ["`npm test -- handoff`"],
    files: ["src/workers/handoff.ts", "src/memory/handoff-packet.ts"],
    deps: ["m5-fallback", "m4-checkpoints"],
  },
  {
    key: "m5-fallback-policies",
    title: "Recovery to primary at next task boundary, anti-oscillation dwell, all-capped auto-resume, expensive-substitute policy",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models"],
    planRef: "§3.D Caps and fallback",
    todoRef: "§5 'Recovery to primary…', 'Anti-oscillation dwell…', 'Expensive-substitute policy…'",
    context: `
The remaining fallback policies from PLAN §3.D: do not re-probe the primary every task; stay on the substitute for at least the configured dwell; if the substitute costs more, apply the budget and optionally prefer waiting when the reset is near.
`,
    plan: `
> ### PLAN §3.D
> Recovery: retry the primary at the next task boundary once the cap is estimated to have cleared; do not re-probe every task. Anti-oscillation: minimum dwell on the fallback (default: remainder of the current task). More expensive substitute: apply the workflow budget; configurable prefer-wait-if-reset-within-N-minutes.
${S5}`,
    scope: ["Boundary hook: at task start, if primary's estimated reset has passed and dwell satisfied, select normally (primary eligible again).", "Dwell tracked per (attempt, substitute).", "Cost comparison using card cost (or `unknown` → treat as not more expensive but flag); prefer-wait when reset within N minutes → `paused(cap)` with reason `prefer_wait`."],
    deliverables: ["Extensions to `src/models/fallback.ts`; config fields wired."],
    acceptance: ["After a cap, the next task boundary before the reset does not probe the primary (spy on transport).", "Substitute with higher cost and reset in 2 min with N=5 → prefer-wait pause.", "Dwell prevents switching back mid-task."],
    verification: ["`npm test -- fallback-policies`"],
    files: ["src/models/fallback.ts"],
    deps: ["m5-fallback"],
  },
  {
    key: "m5-status-models",
    title: "Attempt records requested/used model and reason; `/korwf status` and `/korwf models` surface switches and caps",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:extension", "area:models"],
    planRef: "§3.D (visible, recorded), §3.I, §4 UI",
    todoRef: "§5 'Attempt records requested/used model and reason; status and models surface switches and caps'",
    context: `
Selection and fallback must be visible. \`/korwf status\` shows the workers, models in use, any fallback and why, budgets and running cost. \`/korwf models\` shows the catalog, cards, availability/caps with estimated resets, and pins.
`,
    plan: `
> ### PLAN §3.D
> Every switch is recorded on the Attempt (\`requested_model\`, \`used_model\`, \`fallback_reason\`) and surfaced in status.
>
> ### PLAN §4 UI
> \`/korwf status\` — workers, models in use, fallbacks, budgets, running cost. \`/korwf models\` — catalog, cards, availability/caps, pins.
${S5}`,
    scope: ["`status` and `models` commands with TTY and plain renderings.", "No secrets, URLs, or proxy hostnames in output (redactor)."],
    deliverables: ["`src/extension/commands/status.ts`, `src/extension/commands/models.ts`."],
    acceptance: ["After a simulated fallback, `status` shows requested → used and the reason.", "`models` shows a capped model with its estimated reset.", "Output passes the secret regex check."],
    verification: ["`npm test -- commands/status commands/models`"],
    files: ["src/extension/commands/status.ts", "src/extension/commands/models.ts"],
    deps: ["m5-fallback-policies"],
  },
  {
    key: "m5-main-session-routing",
    title: "Opt-in main-session routing at safe boundaries only",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:extension", "area:models"],
    planRef: "§3.D Main session",
    todoRef: "§5 'Opt-in main-session routing at safe boundaries only'",
    context: `
By default the user's main Pi session keeps its model. If the user opts in, the product may switch the main session's model, but only at a safe boundary (between turns, not mid-tool-call), with a visible notice and an explicit context handoff summary.
`,
    plan: `
> ### PLAN §3.D Main session
> Stable by default; opt-in routing of the main session only at safe boundaries, with visible switch and explicit context handoff.
${S5}`,
    scope: ["Config `models.routeMainSession: false` default.", "Boundary detection via Pi lifecycle events (integration map).", "Switch uses Pi's model-selection API; prints a notice; writes a session entry with the handoff summary."],
    deliverables: ["`src/extension/main-session-routing.ts`."],
    acceptance: ["With default config no switch ever occurs (spy).", "With opt-in, a switch happens only at a boundary and a notice + session entry are produced."],
    verification: ["`npm test -- main-session-routing`"],
    files: ["src/extension/main-session-routing.ts"],
    deps: ["m5-selection"],
  },
  {
    key: "m5-workers",
    title: "Worker roles, contracts, launch with explicit model/profile/tools/cwd; resource-inheritance control",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:workers", "risk:high"],
    planRef: "§3.E, docs/adr/0004-worker-interface.md",
    todoRef: "§5 'Worker roles, contracts, launch…; resource inheritance control'",
    context: `
Implements the worker interface chosen in Stage 1. A worker is a Pi process with a role (scout, planner, implementer, verifier, reviewer, integrator), a contract (task, tools, artifacts, budget, model, termination criteria), a cwd (its worktree), and controlled inheritance of extensions/skills so it cannot spawn orchestration recursively.
`,
    plan: `
> ### PLAN §3.E
> Bounded roles: scout, planner, implementer, verifier, reviewer, integrator. Explicit worker contracts: task, tools, artifacts, budget, model, termination criteria. Workers do not inherit orchestration extensions that could spawn recursively unless explicitly allowed.
${S5}`,
    scope: ["`WorkerContract` type and `spawnWorker(contract)` → handle with progress stream, usage, exit.", "Role → allowed tools table; read-only roles get no mutation tools (bash restricted per next issue).", "Environment scrubbing: worker env contains only allowlisted variables; the Jev key is never passed to workers.", "Recursion guard: env marker + extension exclusion so a worker cannot run `/korwf run`."],
    deliverables: ["`src/workers/contract.ts`, `src/workers/spawn.ts`, `src/workers/roles.ts`."],
    acceptance: ["Worker env does not contain the Jev key variable (test).", "Worker attempting `/korwf run` is refused (test).", "Contract with a model outside allowlist is rejected before spawn."],
    verification: ["`npm test -- workers`"],
    files: ["src/workers/"],
    deps: ["m5-selection", "m1-worker-interface", "m0-sandbox"],
  },
  {
    key: "m5-readonly-enforcement",
    title: "Read-only roles enforced across all mutation routes; sandbox boundaries where supported",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:security", "area:workers", "risk:high"],
    planRef: "§7 Execution policy, §3.E",
    todoRef: "§5 'Read-only roles enforced across all mutation routes; sandbox boundaries where supported'",
    context: `
Disabling \`edit\`/\`write\` is not read-only. Scouts, verifiers, and reviewers must be unable to mutate the repo via bash, custom tools, or git. Use tool-call hooks as policy gates plus, where the platform and M0 decision allow, the sandbox mechanism.
`,
    plan: `
> ### PLAN §7 Execution policy
> All mutation routes tested (bash, custom tools); disabling \`edit\`/\`write\` alone is not read-only enforcement. Role-specific tools, constrained environments, path boundaries, network policy where the platform supports it.
${S5}`,
    scope: ["Tool-call hook in worker context: for read-only roles, deny bash commands matching a mutation classifier (write redirections, `rm`, `mv`, `git commit/push/reset`, package installs) and deny all mutation tools.", "Path boundary: workers may only touch their worktree and `.korwf/artifacts/<attempt>`.", "Sandbox integration per `docs/decisions/0006` if approved; otherwise documented as hook-only enforcement with limitations."],
    deliverables: ["`src/security/execution-policy.ts`, `src/workers/tool-gate.ts`."],
    acceptance: ["Test matrix: each mutation route (edit, write, bash redirection, bash rm, git commit, custom tool) is blocked for a scout and allowed for an implementer within its worktree.", "Implementer writing outside its worktree is blocked and audited."],
    verification: ["`npm test -- execution-policy`"],
    files: ["src/security/execution-policy.ts", "src/workers/tool-gate.ts"],
    deps: ["m5-workers"],
  },
  {
    key: "m5-worktree-guard",
    title: "Dirty-tree preservation and repository identity check",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:workflow", "area:workers"],
    planRef: "§3.E, §10",
    todoRef: "§5 'Dirty-tree preservation and repository identity check'",
    context: `
Before any worker runs, confirm we are in the repository the Workflow was created for (remote/root/first-commit fingerprint) and that the user's uncommitted changes in the main tree are left alone: workers operate in worktrees created from a clean base revision.
`,
    plan: `
> ### PLAN §3.E
> Separate Git worktrees for parallel writing workers; never concurrent uncontrolled integration into the user's tree.
>
> ### PLAN §10
> Dirty user changes preserved.
${S5}`,
    scope: ["Repo identity fingerprint on Workflow; mismatch → refuse with explanation.", "Worktree creation under `.korwf/worktrees/<attempt>` from the base revision; user's main tree never checked out or reset by the product.", "Cleanup policy hook (Stage 6)."],
    deliverables: ["`src/workers/worktree.ts`, `src/workflow/repo-identity.ts`."],
    acceptance: ["Running in a different clone of another repo → refused.", "User's dirty file in main tree unchanged after a full worker run (hash compare)."],
    verification: ["`npm test -- worktree repo-identity`"],
    files: ["src/workers/worktree.ts", "src/workflow/repo-identity.ts"],
    deps: ["m5-workers"],
  },
  {
    key: "m5-worker-lifecycle",
    title: "Progress, artifacts, usage capture; global and per-worker limits; pause/resume/cancel; process-tree termination",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:workers", "area:telemetry"],
    planRef: "§3.E",
    todoRef: "§5 'Progress, artifacts, usage capture; global/per-worker limits; pause/resume/cancel; process-tree termination'",
    context: `
Runtime control of workers: stream progress into the Attempt, capture artifacts and usage, enforce elapsed-time/token/spend limits per worker and globally, and implement pause/resume/cancel with guaranteed child-process cleanup.
`,
    plan: `
> ### PLAN §3.E
> Enforce concurrency, recursion depth, elapsed-time, token, and spend limits. Propagate cancellation and terminate child process trees. Pause, resume, cancel, restart recovery, partial completion.
${S5}`,
    scope: ["Progress events → Attempt timeline; usage → ledger settlement.", "Limits: elapsed, tokens, spend per worker; concurrency global (Stage 6 uses it).", "`pause` (SIGSTOP or cooperative), `resume`, `cancel` (SIGTERM → SIGKILL after grace; kill the whole process group).", "`/korwf pause|resume|cancel` commands."],
    deliverables: ["`src/workers/lifecycle.ts`, commands in `src/extension/commands/`."],
    acceptance: ["Cancel leaves no processes in the worker's group (pgrep test).", "Elapsed limit terminates a sleeping worker and records `outcome: timeout`.", "Usage settles against the ledger within the reservation."],
    verification: ["`npm test -- lifecycle`"],
    files: ["src/workers/lifecycle.ts", "src/extension/commands/pause.ts", "resume.ts", "cancel.ts"],
    deps: ["m5-workers", "m2-accounting"],
  },
  {
    key: "m5-crash-reconcile",
    title: "Crash-interrupted attempt reconciliation on startup",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:storage", "area:workers"],
    planRef: "§5",
    todoRef: "§5 'Crash-interrupted attempt reconciliation'",
    context: `
If Pi or the coordinator dies mid-attempt, on next start the store contains \`running\` attempts with no live process. Reconcile: check worktree state, mark the attempt \`interrupted\`, keep the worktree, release budget reservations, and offer resume-via-handoff or restart.
`,
    plan: `
> ### PLAN §5
> Abandoned attempts reconciled on startup.
${S5}`,
    scope: ["Startup hook (interface from Stage 2 storage) implemented.", "Detection: attempt `running` with dead pid or missing lock.", "Outcome: `interrupted`, reservation released, worktree preserved, task → `failed` with recovery options."],
    deliverables: ["`src/workers/reconcile.ts`."],
    acceptance: ["Kill -9 during an attempt; restart; attempt is `interrupted`, worktree exists, ledger reservation released (integration test)."],
    verification: ["`npm test -- workers/reconcile`"],
    files: ["src/workers/reconcile.ts"],
    deps: ["m5-worker-lifecycle", "m5-handoff"],
  },
  {
    key: "m5-e2e",
    title: "Single-worker end-to-end run in a disposable repo; simulated-cap test with visible fallback (Scenario 4)",
    milestone: "M5",
    labels: ["stage:5", "type:test", "area:workers", "area:models"],
    planRef: "§8 Stage 5 exit, §2.8 scenario 4",
    todoRef: "§5 'Single-worker end-to-end run…; simulated-cap test with visible fallback (scenario 4)'",
    context: `
Proves the Stage 5 exit: one task, planned in Stage 3, executes in an isolated worktree with a Jev-chosen model (mock Jev, and a real mac-mini model if a live budget is approved on this issue), passes the gate, and reports accurate state. Then the same with a simulated 429 mid-task: fallback to a substitute, handoff, completion, primary retried at the next task.
`,
    plan: `
> ### PLAN §2.8 Scenario 4
> Primary model returns quota exhausted; Jev ranks substitutes for the task profile; handoff packet built; worker continues on the substitute; switch recorded; next task retries the primary.
${S5}`,
    scope: ["Integration test with a fake provider that can be told to return 429 after N calls.", "Assertions from `test/scenarios/04-cap-mid-task.md` implemented.", "Optional live variant behind an env flag and budget from M0 — uses the mac-mini allowlist via config, never hardcoded."],
    deliverables: ["`test/integration/stage5/e2e.test.ts`, `test/integration/stage5/scenario4.test.ts`."],
    acceptance: ["Mocked scenario 4 passes with every assertion from the outline.", "Status output during the run shows the switch.", "Live variant (if run) is reported with cost in the PR."],
    verification: ["`npm test -- stage5`"],
    files: ["test/integration/stage5/"],
    deps: ["m5-status-models", "m5-readonly-enforcement", "m5-worktree-guard", "m5-crash-reconcile", "m4-tests"],
  },
];
