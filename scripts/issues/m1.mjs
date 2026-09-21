// M1 — Discovery and contracts (PLAN §8 Stage 1)

const PI = "/home/lee/.local/share/mise/installs/pi/0.86.0/pi";

export default [
  {
    key: "m1-pi-docs",
    title: "Read Pi docs and produce an integration-surface map",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:extension", "area:docs"],
    planRef: "§4 'Pi integration surfaces to validate', §12",
    todoRef: "§1 'Read relevant Pi docs and cross-references completely'",
    context: `
KorWF-Pi is a Pi package (no fork). Every later stage depends on knowing exactly which Pi extension APIs exist in the installed version (0.86.0) and what they guarantee. This issue produces the reference map that other agents use instead of re-reading the docs.

Pi is installed at \`${PI}\`. Read \`README.md\`, then \`docs/extensions.md\`, \`docs/packages.md\`, \`docs/sdk.md\`, \`docs/rpc.md\`, \`docs/tui.md\`, \`docs/session-format.md\`, \`docs/compaction.md\`, \`docs/environment-variables.md\`, \`docs/models.md\`, \`docs/custom-provider.md\`, \`docs/skills.md\`, and follow every cross-reference. Read each file completely — do not skim.
`,
    plan: `
> ### PLAN §4 Pi integration surfaces to validate
> Commands and custom tools; input/pre-agent hooks; tool-call hooks as policy gates (not sandboxing); tool-result and turn events for evidence and stall detection; settled lifecycle events; session/tree/fork/resume/reload/compaction events; model-selection APIs at safe boundaries; session entries for session-linked summaries; project storage for cross-worker state.
>
> ### PLAN §12
> Planning is based on installed Pi 0.86.0 docs. Verify current APIs before implementation.
`,
    scope: [
      "For each surface in PLAN §4's list: the exact API (function/event/hook name and signature), the doc file and section, what it guarantees, and known limits.",
      "How extensions are loaded/unloaded, and what happens on reload/compaction/fork.",
      "Model registry APIs: `ctx.modelRegistry`, `ctx.scopedModels`, `enabledModels`, and how to switch the active model.",
      "Session entry and project-storage APIs.",
      "Which surfaces are missing or insufficient for PLAN's needs (gaps list).",
    ],
    deliverables: ["`docs/pi-integration-map.md` — table per surface: need → API → doc ref → guarantees → gaps.", "`docs/pi-integration-map.md#gaps` listing anything PLAN assumes that Pi 0.86.0 does not provide, with a proposed workaround."],
    acceptance: [
      "Every surface in PLAN §4's list has a row with a concrete API name and doc reference.",
      "Every referenced doc file was read completely (list them at the top of the document).",
      "Gaps section exists, even if empty, with an explicit 'none found' if so.",
      "A second agent can implement a tool-call hook and a command from the map without opening the Pi docs.",
    ],
    verification: ["`test -f docs/pi-integration-map.md`", "`grep -c '|' docs/pi-integration-map.md` ≥ 30 (table rows)", "`grep -q '## Gaps' docs/pi-integration-map.md`"],
    files: ["docs/pi-integration-map.md"],
    deps: [],
  },
  {
    key: "m1-reuse-table",
    title: "Reuse/extend/replace table for Pi's shipped example extensions",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:extension", "area:docs"],
    planRef: "§4 'Reuse of Pi's shipped examples'",
    todoRef: "§1 'Produce reuse/extend/replace table…; revise source layout'",
    context: `
Pi ships example extensions that overlap with KorWF-Pi's needs. PLAN requires a decision per example before the source layout is finalised, so agents don't reinvent what Pi already provides or copy code that conflicts with the design.

Examples live at \`${PI}/examples/extensions/\`. Read the source of each one listed below fully.
`,
    plan: `
> ### PLAN §4 Reuse of Pi's shipped examples
> Stage 1 produces a reuse/extend/replace table for each of: \`subagent/\`, \`plan-mode/\`, \`sandbox/\`, \`todo.ts\`, \`git-checkpoint.ts\`, \`handoff.ts\`, \`dirty-repo-guard.ts\`, \`permission-gate.ts\`, \`protected-paths.ts\`, \`custom-compaction.ts\`, \`git-merge-and-resolve.ts\`, \`questionnaire.ts\`, \`structured-output.ts\`. The source layout above is revised after that table exists.
`,
    scope: [
      "For each of the 13 examples: what it does, which PLAN scope area (A–J) it touches, decision (reuse as-is / extend / replace / ignore), rationale, and licence compatibility.",
      "For 'extend' and 'replace': what specifically is missing versus PLAN.",
      "A revised `src/` layout if the table changes PLAN §4's proposed layout, with the diff explained.",
    ],
    deliverables: ["`docs/adr/0001-reuse-of-pi-examples.md` (table + rationale).", "`docs/adr/0002-source-layout.md` (final layout; may say 'PLAN §4 layout unchanged').", "AGENTS.md §8 updated if the layout changed."],
    acceptance: [
      "All 13 examples have a row with a decision.",
      "Every 'reuse' decision names the file(s) that will be copied/imported and confirms licence.",
      "Source layout ADR exists and AGENTS.md matches it.",
    ],
    verification: ["`test -f docs/adr/0001-reuse-of-pi-examples.md && test -f docs/adr/0002-source-layout.md`", "`grep -c 'subagent\\|plan-mode\\|sandbox\\|todo.ts\\|git-checkpoint\\|handoff.ts\\|dirty-repo-guard\\|permission-gate\\|protected-paths\\|custom-compaction\\|git-merge-and-resolve\\|questionnaire\\|structured-output' docs/adr/0001-reuse-of-pi-examples.md` ≥ 13"],
    files: ["docs/adr/0001-reuse-of-pi-examples.md", "docs/adr/0002-source-layout.md", "AGENTS.md"],
    deps: ["m1-pi-docs"],
  },
  {
    key: "m1-typesafe",
    title: "Verify current TypeSafe API, JS SDK, Jev model versions, limits, pricing, retention",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:jev", "area:docs"],
    planRef: "§6, §7 Jev transport, §12",
    todoRef: "§1 'Verify current TypeSafe API, JS SDK, Jev model versions, limits, pricing, retention'",
    context: `
PLAN was written against TypeSafe docs at a point in time. Before the Jev adapter (Stage 2) is designed, the actual API shape must be confirmed: endpoints, request/response schemas for Choice, Score, and Noul questions, the confidence statistic semantics, rate limits, pricing, data retention, and the JS SDK's surface. This is read-only research using public docs; **no API calls with the key**.

TypeSafe docs: https://docs.typesafe.ai/introduction, /models, /api, /confidence, /model-jaggedness/jev-1.13, /concepts/how-to-build-with-system-one, /cookbooks/skill_suggestion, /sdk/javascript.
`,
    plan: `
> ### PLAN §6 Jev decision design
> Narrow, versioned Choice, Score, and Noul questions with explicit boundary cases and none/unknown outcomes. Preserve raw distributions; validate schemas and bounds; pin tested Jev versions.
>
> ### PLAN §1 Responsibility boundaries
> Jev: narrow semantic classification, ranking, scoring, uncertainty; task characterisation; model selection and fallback ranking; evidence-gap detection. Jev is not a generative coding model, a security boundary, or a final correctness oracle. It only sees the text sent to it. Its confidence statistic is not a task-specific guarantee of correctness.
`,
    scope: [
      "Document each question type's request and response schema exactly, including the raw distribution field(s).",
      "Document the confidence statistic: what it measures and what it does not.",
      "Current model IDs/versions and which to pin.",
      "Rate limits, error codes (esp. 429 / quota), pricing per call, retention/privacy terms.",
      "Whether to use the JS SDK or raw fetch, with rationale (bundle size, cancellation support, base-URL override).",
    ],
    deliverables: ["`docs/typesafe-api-reference.md`.", "`docs/adr/0003-jev-transport.md` (SDK vs fetch decision)."],
    acceptance: [
      "Schemas for Choice, Score, Noul recorded with field types and bounds.",
      "Error taxonomy includes quota/rate-limit codes needed by PLAN §3.G.",
      "Pinned Jev model version named.",
      "Retention statement quoted with URL and date checked (today's date).",
      "No API requests were made (state this explicitly in the PR).",
    ],
    verification: ["`test -f docs/typesafe-api-reference.md && test -f docs/adr/0003-jev-transport.md`"],
    files: ["docs/typesafe-api-reference.md", "docs/adr/0003-jev-transport.md"],
    deps: [],
  },
  {
    key: "m1-model-registry",
    title: "Confirm Pi model registry field set and allowlist interaction at runtime",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:models"],
    planRef: "§3.D Model cards layer 1, Allowlist",
    todoRef: "§1 'Confirm ctx.modelRegistry.getAvailable() / ctx.scopedModels field set…'",
    context: `
The model catalog (Stage 5) is built from Pi's registry. PLAN assumes specific fields exist. This issue confirms them empirically by writing a throwaway extension that dumps the registry in a Pi session, and records how \`enabledModels\` scoping interacts with our own allowlist.

Use the mac-mini provider (already configured on this machine) as the test data. **Do not print credentials or proxy URLs into the doc** — redact base URLs and keys.
`,
    plan: `
> ### PLAN §3.D Model cards — layer 1
> **Pi registry metadata (automatic).** \`ctx.modelRegistry\` / \`ctx.scopedModels\` provide id, provider, name, \`reasoning\` and \`thinkingLevelMap\`, \`input\` modalities, \`contextWindow\`, \`maxTokens\`, and \`cost\` (may be zero for local/proxied models). Sufficient for hard-constraint filtering with no user effort.
>
> ### PLAN §3.D Allowlist
> Eligible models are whatever the user's Pi has configured, filtered by an optional provider/model allowlist in config. Default: all configured models. The system never uses a provider or model outside the allowlist.
`,
    scope: [
      "A throwaway extension under `scripts/probe/model-registry.ts` that prints the registry as JSON (redacting anything resembling a URL or key).",
      "Run it in a Pi session and capture output.",
      "Document the actual field set, types, and which are optional/zero for proxied models.",
      "Document how `enabledModels` / scoped models behave and how our allowlist should compose with them (intersection).",
    ],
    deliverables: ["`docs/model-registry-fields.md` with a sample redacted dump.", "`scripts/probe/model-registry.ts`."],
    acceptance: ["Every field named in PLAN §3.D layer 1 is confirmed present or documented as absent.", "Allowlist composition rule stated: `eligible = configured ∩ enabledModels ∩ allowlist`. Deviations explained.", "Doc contains no base URLs, keys, or hostnames of the proxy."],
    verification: ["`test -f docs/model-registry-fields.md`", "`! grep -iE 'apikey|token=|https?://' docs/model-registry-fields.md`"],
    files: ["docs/model-registry-fields.md", "scripts/probe/model-registry.ts"],
    deps: ["m1-pi-docs"],
    notes: "Refer to `~/.pi/agent/skills/mac-mini-models/SKILL.md` before invoking any model. Do not commit anything from that skill file.",
  },
  {
    key: "m1-config-schema",
    title: "Draft the configuration schema",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:config", "area:security", "risk:high"],
    planRef: "§3.J, §3.D, §2.6, §7",
    todoRef: "§1 'Draft config schema'",
    context: `
All user-facing policy (allowlist, budgets, modes, approval classes, privacy lists, fallback) lives in one validated config. This is the contract everything else enforces. Draft it as a JSON Schema plus a TypeScript type, with safe defaults that make the product usable with no config file and no Jev key.
`,
    plan: `
> ### PLAN §3.J
> Config schema with validation and safe defaults: allowlist, budgets, modes, approval classes, privacy lists, fallback policy, static fallback order, Jev base URL/key source. Runs without a Jev key. No user-specific paths, providers, or credentials in shipped code.
>
> ### PLAN §3.D Caps and fallback (config-relevant)
> Mid-task handoff vs restart per task-kind policy; retry primary at next task boundary; anti-oscillation dwell (default: remainder of current task); prefer-wait-if-reset-within-N-minutes; pinned models not overridden without asking; static fallback ordering when Jev unavailable.
>
> ### PLAN §7 Data policy (shipped defaults)
> Default-deny outbound for secrets and sensitive paths (\`.env*\`, key files, credential stores, \`node_modules\`, build output, and a documented list). Minimal outbound snippets; raw payload logging opt-in with retention and deletion controls.
`,
    scope: [
      "Sections: `models.allowlist` (providers[], models[], pins), `budgets` (per-workflow, per-phase, per-task; spend/tokens/requests/concurrency), `mode` (shadow|advisory|supervised|bounded-autonomous), `approvals` (class → auto|queue|stop per mode), `privacy` (deny paths, deny patterns, outbound limits, raw logging opt-in), `fallback` (policy per task kind, dwell, prefer-wait minutes, static order), `jev` (baseUrl, keySource, model version pin, enabled), `notifications`, `storage` (path override).",
      "Defaults for every field; document why each default is safe.",
      "Validation rules beyond types (e.g. static order ⊆ allowlist; budgets ≥ 0; deny list cannot be emptied below the shipped minimum).",
    ],
    deliverables: ["`docs/config-reference.md` (every key, type, default, rationale).", "`src/config/schema.json` (JSON Schema draft 2020-12).", "`src/config/types.ts` matching the schema."],
    acceptance: [
      "An empty config validates and yields a working no-Jev configuration.",
      "Config cannot reduce the privacy deny list below the shipped minimum (schema or documented validator rule).",
      "No field default contains a path, provider name, or hostname specific to the author's machine.",
      "`mac-mini` appears nowhere in shipped defaults (only in the author's local config, which is not committed).",
    ],
    verification: ["`test -f src/config/schema.json && test -f src/config/types.ts && test -f docs/config-reference.md`", "`! git grep -n 'mac-mini' -- src/ docs/config-reference.md`"],
    files: ["docs/config-reference.md", "src/config/schema.json", "src/config/types.ts"],
    deps: ["m1-typesafe", "m1-model-registry"],
  },
  {
    key: "m1-records",
    title: "Define all persistent records (Workflow, Phase, Task, Attempt, Decision, Evidence, Approval, Memory, ModelAvailability, ModelOutcome)",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:storage", "area:workflow"],
    planRef: "§2.2, §5 Records",
    todoRef: "§1 'Define all records (PLAN §5)…'",
    context: `
The SQLite store (Stage 2) needs exact record definitions. PLAN §5 lists the records and their fields at a high level; this issue turns them into TypeScript interfaces and a documented ER model with identity, versioning, and revision semantics.
`,
    plan: `
> ### PLAN §5 Records
> - **Workflow** — goal, repo identity, base revision, exclusions, mode, budgets, policy version, session refs.
> - **Phase** — id, order, goal, acceptance criteria, budget cap, integration point, gate status, report.
> - **Task** — stable id, revision, phase, goal, dependencies, ownership, acceptance criteria, checks, risk class, status.
> - **Attempt** — worker id, task profile, requested model, used model, fallback reason, profile, inputs, worktree, timestamps, usage, outcome, artifacts.
> - **Decision** — state hash, question version, Jev model version, raw distribution and confidence, policy rule, action, override, freshness.
> - **Evidence** — requirement/check id, artifact, revision, command identity, exit status, reviewer, caveats.
> - **Approval** — actor, scope, task/plan revision, permitted action, expiry, invalidation.
> - **Memory** — source, revision, type, freshness, supersession, status.
> - **ModelAvailability** — model id, cap kind, detected at, estimated reset, last probe.
> - **ModelOutcome** — model, task profile, result, cost, latency (feeds card refinement).
>
> Pi conversation branching does not undo Git changes or external effects. Fork/resume reconciles live repository state and never resurrects obsolete approvals or replays completed actions.
`,
    scope: [
      "TypeScript interface per record with every PLAN field, plus `id`, `createdAt`, `updatedAt`, and a `schemaVersion`.",
      "Identity rules: Task has a stable id and a `revision` that increments on any change to goal/criteria/checks; Approvals reference `(taskId, taskRevision)` and are invalid if the revision moves.",
      "Which records are append-only (Decision, Evidence, audit) vs mutable.",
      "Foreign keys and cascade rules.",
      "Provenance fields on Evidence and Memory: revision, path, range, retrieval method, content hash (PLAN §3.B).",
    ],
    deliverables: ["`src/storage/records.ts`.", "`docs/records.md` with an ER diagram (Mermaid) and the revision/invalidation rules."],
    acceptance: [
      "Every field listed in PLAN §5 for every record is present.",
      "Approval invalidation on revision change is expressed in the types (revision field) and documented.",
      "Append-only records have no update path in the type design (documented).",
    ],
    verification: ["`test -f src/storage/records.ts && test -f docs/records.md`", "`grep -c 'export interface' src/storage/records.ts` ≥ 10"],
    files: ["src/storage/records.ts", "docs/records.md"],
    deps: [],
  },
  {
    key: "m1-transitions",
    title: "Define task and phase state transitions, paused(cap), and approval invalidation",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:workflow"],
    planRef: "§5 Task states, §3.C, §3.D Caps",
    todoRef: "§1 'Define task and phase state transitions, paused(cap), approval invalidation'",
    context: `
The workflow engine is a state machine. Every transition must have preconditions and evidence requirements so that nothing (Jev, worker, tool) can move a task to \`done\` without the gate. This issue writes the transition table as a spec and as a TypeScript table that Stage 3 implements verbatim.
`,
    plan: `
> ### PLAN §5 Task states
> \`\`\`
> proposed -> ready -> running -> verifying -> review -> done
>                \\       \\           \\          \\
>                 blocked / failed / cancelled / needs_changes / paused(cap)
> \`\`\`
> Explicit transition table with preconditions and evidence requirements.
>
> ### PLAN §2.3
> A task with no checks is not \`ready\`.
>
> ### PLAN §3.D
> All candidates capped: pause the phase, surface state, resume when a cap clears. Not a failure.
>
> ### PLAN §3.C
> Plan revision, scope change, cancellation, reprioritisation, approval invalidation; replan without silent scope expansion.
`,
    scope: [
      "Task transition table: from, to, trigger, preconditions, required evidence, side effects, who may trigger (engine only / user / worker-request-then-engine).",
      "Phase states and transitions (pending, running, gating, done, paused, failed, cancelled).",
      "`paused(cap)` semantics: entered when all eligible models are capped; auto-resume rule.",
      "Approval invalidation events: task revision change, plan revision change, expiry, mode change, policy version change.",
      "Illegal-transition handling (reject + audit).",
    ],
    deliverables: ["`docs/state-machine.md` (tables + Mermaid).", "`src/workflow/transitions.ts` exporting the table as data (not logic yet)."],
    acceptance: [
      "`ready` requires ≥1 check (PLAN §2.3) in preconditions.",
      "`done` requires: all checks pass at exact revision ∧ no Jev evidence gap (or Jev disabled) ∧ policy review satisfied — and nothing else can set it.",
      "Every state has at least one outgoing transition except `done` and `cancelled`.",
      "Approval invalidation events are enumerated and each maps to a state effect.",
    ],
    verification: ["`test -f docs/state-machine.md && test -f src/workflow/transitions.ts`"],
    files: ["docs/state-machine.md", "src/workflow/transitions.ts"],
    deps: ["m1-records"],
  },
  {
    key: "m1-gates",
    title: "Write the task gate and phase gate formulas as testable specifications",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:verification", "risk:high"],
    planRef: "§2.4, §2.5, §3.F",
    todoRef: "§1 'Write the task gate and phase gate formulas as testable specs'",
    context: `
The gates are the product's central safety property: no completion without evidence. Stage 4 implements them; this issue specifies them precisely enough that the implementation can be tested against the spec, including all the ways they must *not* be bypassable.
`,
    plan: `
> ### PLAN §2.4 Success gate (per task)
> A task reaches \`done\` only when all of the following hold:
> 1. **Deterministic checks pass** — registered commands exit 0 at the exact revision, recorded as evidence.
> 2. **Jev finds no evidence gap** — completion claim is supported by the presented evidence; every acceptance criterion maps to a check or evidence item; tests exercise the requirement rather than something unrelated.
> 3. **Policy-required review passes** — independent coding-model review for change classes the policy specifies; human approval for high-risk classes.
>
> Jev cannot waive (1) or (3). A worker's assertion cannot set \`done\`. A Jev "no gap" result cannot substitute for a failing check.
>
> ### PLAN §2.5 Phase gate
> Phase done = all tasks done ∧ integrated verification passes on the merged result ∧ Jev finds no gap between phase acceptance criteria and accumulated evidence ∧ policy-required phase review passes.
>
> ### PLAN §3.F
> Evidence invalidated after relevant changes; integrated checks after merges. Flaky, missing, or unavailable checks are represented explicitly, never as success.
`,
    scope: [
      "Formal definition of each gate as a predicate over records, including the Jev-disabled case (condition 2 becomes 'deterministic fallback satisfied', never 'skipped').",
      "Evidence freshness: evidence is valid only if `evidence.revision == task.currentRevision` of the worktree.",
      "Check result states: pass, fail, flaky, missing, unavailable, timeout — only `pass` satisfies condition 1.",
      "Enumerated bypass attempts the tests must cover: worker sets status directly; Jev returns 'no gap' with a failing check; evidence from stale revision; check registered after the fact with `true` as the command; review approval from the same context that wrote the code.",
    ],
    deliverables: ["`docs/gates.md`.", "`test/spec/gates.spec.md` — a test outline (Given/When/Then) per predicate and per bypass attempt, to be implemented in Stage 4."],
    acceptance: ["Both gates are written as predicates with every term defined.", "≥ 8 bypass scenarios enumerated with expected outcome 'rejected + audit entry'.", "Jev-disabled behaviour explicitly defined for both gates."],
    verification: ["`test -f docs/gates.md && test -f test/spec/gates.spec.md`", "`grep -c 'Given' test/spec/gates.spec.md` ≥ 10"],
    files: ["docs/gates.md", "test/spec/gates.spec.md"],
    deps: ["m1-transitions"],
  },
  {
    key: "m1-approval-classes",
    title: "Define unattended approval classes (auto / queue-and-continue / stop)",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:workflow", "area:security", "risk:high"],
    planRef: "§2.6, §7 Execution policy, §3.A",
    todoRef: "§1 'Define unattended approval classes'",
    context: `
When \`run\` operates unattended, every decision that would normally prompt the user must be classified in advance. This issue defines the taxonomy of approval classes and their default disposition per mode. Lee's pilot choice (M0) selects from this table; the config schema references it.
`,
    plan: `
> ### PLAN §2.6 Unattended operation
> Policy must define, per approval class: **Auto-decide** — low-risk classes the user pre-approved for the mode. **Queue and continue** — block the task, continue other ready tasks, notify. **Stop the phase** — high-risk classes.
>
> ### PLAN §7 Execution policy
> High-risk actions (destructive cleanup, deployment, credential access, publishing, remote pushes) require explicit policy/approval regardless of mode.
>
> ### PLAN §3.A
> Never infer authorization for irreversible actions from a Jev score.
`,
    scope: [
      "Enumerate approval classes: e.g. add-dependency, modify-config-file, delete-file, run-migration, network-access, spend-over-estimate, scope-change, new-file-outside-ownership, remote-push, deploy, credential-access, destructive-git, replan, model-substitute-more-expensive.",
      "Default disposition table: class × mode → auto | queue | stop, with the hard rule that the PLAN §7 high-risk set is always `stop` (not configurable to `auto`).",
      "Notification payload per class.",
      "How the class is determined in code (deterministic rules first; Jev may only escalate, never de-escalate).",
    ],
    deliverables: ["`docs/approval-classes.md`.", "`src/workflow/approval-classes.ts` (enum + default table as data)."],
    acceptance: ["Every class has a default for all four modes.", "High-risk classes from PLAN §7 cannot be set to `auto` — the schema/validator rule is stated.", "Rule 'Jev may escalate but never de-escalate a class' is stated."],
    verification: ["`test -f docs/approval-classes.md && test -f src/workflow/approval-classes.ts`"],
    files: ["docs/approval-classes.md", "src/workflow/approval-classes.ts"],
    deps: ["m1-config-schema"],
  },
  {
    key: "m1-worker-interface",
    title: "Select the worker interface (subagent example vs SDK vs RPC)",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:workers"],
    planRef: "§3.E, §4",
    todoRef: "§1 'Select worker interface'",
    context: `
Workers are Pi processes running a bounded role. There are three ways to spawn and control them: extend the shipped \`subagent/\` example, use the Pi SDK in-process, or drive a Pi subprocess over RPC (\`docs/rpc.md\`). The choice affects cancellation, resource inheritance, and whether workers can recursively spawn orchestration — all PLAN §3.E requirements.
`,
    plan: `
> ### PLAN §3.E
> Explicit worker contracts: task, tools, artifacts, budget, model, termination criteria. Enforce concurrency, recursion depth, elapsed-time, token, and spend limits. Propagate cancellation and terminate child process trees. Workers do not inherit orchestration extensions that could spawn recursively unless explicitly allowed. Pause, resume, cancel, restart recovery, partial completion.
`,
    scope: [
      "Evaluate each option against: cancellation and process-tree kill, resource/extension inheritance control, per-worker model/tool/cwd selection, progress and usage capture, crash detection, cross-platform behaviour.",
      "Prototype the chosen one minimally (spawn a worker that lists a directory and exits) under `scripts/probe/worker-spawn.ts`.",
    ],
    deliverables: ["`docs/adr/0004-worker-interface.md` with the comparison matrix and decision.", "`scripts/probe/worker-spawn.ts`."],
    acceptance: ["Matrix covers all PLAN §3.E requirements listed above.", "Decision states how recursive spawning is prevented.", "Prototype runs and exits cleanly; its cancellation path is demonstrated (kill mid-run, no orphan processes)."],
    verification: ["`test -f docs/adr/0004-worker-interface.md`", "Prototype run + `pgrep -f worker-spawn` empty afterwards (paste output)"],
    files: ["docs/adr/0004-worker-interface.md", "scripts/probe/worker-spawn.ts"],
    deps: ["m1-pi-docs", "m1-reuse-table"],
  },
  {
    key: "m1-adrs",
    title: "Record architecture decisions and threat boundaries",
    milestone: "M1",
    labels: ["stage:1", "type:spec", "area:security", "area:docs", "risk:high"],
    planRef: "§1 Responsibility boundaries, §7, §4",
    todoRef: "§1 'Record architecture decisions and threat boundaries'",
    context: `
Consolidate the Stage 1 decisions into a threat model and a set of ADRs so later agents know what is trusted, what is not, and why. This is the document that agents consult when an issue's security implications are unclear.
`,
    plan: `
> ### PLAN §1 Responsibility boundaries
> Jev is not a generative coding model, a security boundary, or a final correctness oracle. It only sees the text sent to it.
>
> ### PLAN §7
> Untrusted repository/tool content isolated from instruction and policy sources. Jev prompt-injection signals never authorise execution or data release. Permissions come from user-approved rules and execution isolation, not semantic confidence. All mutation routes tested (bash, custom tools); disabling \`edit\`/\`write\` alone is not read-only enforcement.
>
> ### PLAN §3.E
> Worktrees are change isolation, not security isolation.
`,
    scope: [
      "Threat model: assets (user repo, credentials, budgets, user's uncommitted work), actors (malicious repo content, prompt injection via tool output, misbehaving worker, Jev outage/compromise, buggy policy), trust boundaries, mitigations, residual risks.",
      "ADRs: SQLite single-writer; Jev-optional design; code-enforced policy after Jev selection; worktree isolation model; no-fork Pi package.",
      "Data-flow diagram showing what leaves the machine (to TypeSafe, to model providers) and what never does.",
    ],
    deliverables: ["`docs/threat-model.md`.", "`docs/adr/0005-…` through `0009-…` (one per ADR above).", "`docs/adr/README.md` index."],
    acceptance: ["Every trust boundary in PLAN §7 appears with a mitigation.", "Data-flow diagram exists and matches the config privacy defaults.", "ADR index lists all ADRs created in Stage 1."],
    verification: ["`test -f docs/threat-model.md && test -f docs/adr/README.md`", "`ls docs/adr/*.md | wc -l` ≥ 10"],
    files: ["docs/threat-model.md", "docs/adr/"],
    deps: ["m1-reuse-table", "m1-typesafe", "m1-config-schema", "m1-gates", "m1-worker-interface"],
  },
  {
    key: "m1-scenarios",
    title: "Write PLAN §2.8 scenarios as acceptance test outlines",
    milestone: "M1",
    labels: ["stage:1", "type:test", "area:evaluation"],
    planRef: "§2.8",
    todoRef: "§1 'Write scenarios 2.8 as acceptance test outlines'",
    context: `
The four scenarios in PLAN §2.8 are the end-to-end acceptance tests for the whole product (Stage 8). Writing them now as Given/When/Then outlines gives every later stage a target and lets agents check their work against the intended behaviour.
`,
    plan: `
> ### PLAN §2.8 Scenarios
> 1. **Greenfield app, phase 1.** Plan from a spec; scaffolding + tests; three feature tasks with two independent; parallel execution; integration; phase report.
> 2. **Feature on an existing repo.** Retrieval ranks the right files; one task; model chosen for the task type; check invalidated after a later edit; re-verification.
> 3. **Worker claims done, test is wrong.** Checks pass but Jev flags the test doesn't exercise the acceptance criterion; task goes to \`needs_changes\`; recovery path; second attempt succeeds.
> 4. **Cap hit mid-task.** Primary model returns quota exhausted; Jev ranks substitutes for the task profile; handoff packet built; worker continues on the substitute; switch recorded; next task retries the primary.
`,
    scope: ["One outline per scenario: fixture repo description, config used, step list, observable assertions per step (records created, states, evidence, cost), and which stage's issues they exercise.", "Each scenario in a Jev-enabled and a Jev-disabled variant (for 3 and 4, the disabled variant documents the deterministic fallback behaviour)."],
    deliverables: ["`test/scenarios/01-greenfield.md`, `02-existing-repo.md`, `03-wrong-test.md`, `04-cap-mid-task.md`."],
    acceptance: ["All four scenarios have both variants.", "Every assertion names the record and field it checks (e.g. `Attempt.fallback_reason == 'quota'`)."],
    verification: ["`ls test/scenarios/*.md | wc -l` = 4"],
    files: ["test/scenarios/"],
    deps: ["m1-records", "m1-transitions", "m1-gates"],
  },
];
