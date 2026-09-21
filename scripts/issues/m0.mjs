// M0 — Approvals and decisions (PLAN §11). These need Lee, not an agent.
// Agents may prepare the decision (options, trade-offs, recommendation) but must not decide.

const humanPlan = `
> ### PLAN §11 Development environment (author-specific; not product policy)
> These apply to the author's machine while building and evaluating, and are expressed through the product's own config — never hardcoded.
> - Allowlist config: \`providers: ["mac-mini"]\`. Direct providers remain available only as explicit exceptions.
> - Jev: direct TypeSafe with the author's key via the approved secret mechanism; base URL default.
> - Pilot repository, sample tasks, spend/token/request/concurrency caps, and approval classes to be agreed before live tests.
>
> ### Decisions needed before implementation/live operation
> Authorization to implement · TypeSafe key availability and secret mechanism · Pilot repository and data-sharing restrictions · Live test budgets · Default operating mode and approval classes for the pilot · Whether sandbox setup and additional dependencies are permitted.
`;

const files = ["docs/decisions/README.md (decision log — create if absent)"];

export default [
  {
    key: "m0-authorize",
    title: "Decision: authorization to implement",
    milestone: "M0",
    labels: ["type:approval", "needs-human"],
    planRef: "§0 Status and authorization, §11",
    todoRef: "§0 'Authorization to implement'",
    context: `
PLAN.md states that only the project folder and planning documents were authorized when it was written. Nothing in Stages 1–8 may begin until Lee explicitly authorizes implementation on this issue. This issue exists so that authorization is recorded in the repository rather than in chat.

Agents: do not close this. Lee closes it with a comment stating what is authorized (e.g. "Stage 1 and 2 authorized; no live requests"). Stage-1 issues are marked \`agent-ready\` because they are read-only research, but Lee's comment here governs.
`,
    plan: humanPlan,
    scope: ["Record Lee's authorization decision and its boundaries."],
    outOfScope: ["Any implementation work."],
    deliverables: ["A comment from Lee stating the authorization and any limits.", "`docs/decisions/0001-authorization.md` capturing the same text (an agent may write this after Lee comments)."],
    acceptance: ["Lee has commented with an explicit authorization statement.", "The decision file exists and matches the comment."],
    verification: ["`test -f docs/decisions/0001-authorization.md`"],
    files,
    deps: [],
  },
  {
    key: "m0-key",
    title: "Decision: TypeSafe (Jev) key availability and secret mechanism",
    milestone: "M0",
    labels: ["type:approval", "needs-human", "area:security", "risk:high"],
    planRef: "§7 Jev transport, §11",
    todoRef: "§0 'TypeSafe key availability and secret mechanism agreed'",
    context: `
The product talks to Jev via the TypeSafe API using the user's own key. During development the author's key must be resolved through an approved secret mechanism and must never appear in the repo, transcripts, logs, or artifacts.

Known state: a key exists in \`~/Projects/.env\` as \`JEV_API_KEY\` (outside this repo; \`.env*\` is git-ignored). Whether that env var name is the mechanism, or Pi's secrets facility is used instead, is Lee's decision.

An agent may prepare this decision by reading Pi's docs (\`docs/environment-variables.md\`, and anything on secrets in \`docs/extensions.md\`) and listing the options with trade-offs, but must not choose.
`,
    plan: `
> ### PLAN §7 Jev transport
> Direct TypeSafe API using the user's own key, with a configurable base URL for users who proxy. Key resolved through an approved secret mechanism (env var or Pi's secrets facility), never stored in the repo, transcripts, or logs.
${humanPlan}`,
    scope: ["Agent: summarise the options (env var name, Pi secrets facility, file path) with pros/cons.", "Lee: choose the mechanism and env var name."],
    outOfScope: ["Implementing credential resolution (that is a Stage 2 issue)."],
    deliverables: ["Options comment by an agent.", "Decision comment by Lee.", "`docs/decisions/0002-jev-secret-mechanism.md`."],
    acceptance: ["Lee has commented with the chosen mechanism and variable/secret name.", "The decision file records it and explicitly states the key must never be logged or committed."],
    verification: ["`test -f docs/decisions/0002-jev-secret-mechanism.md`", "`git grep -iE 'apikey_' -- ':!scripts/issues' | wc -l` → 0"],
    files,
    deps: [],
  },
  {
    key: "m0-pilot",
    title: "Decision: pilot repository, sample tasks, and data-sharing restrictions",
    milestone: "M0",
    labels: ["type:approval", "needs-human", "area:security"],
    planRef: "§9 Evaluation strategy, §11",
    todoRef: "§0 'Pilot repository, sample tasks, data-sharing restrictions'",
    context: `
Live evaluation (Stage 5 onwards) needs a real repository to run tasks against, a set of sample tasks, and explicit rules on what data may be sent to TypeSafe and to model providers. Nothing live can run until this is agreed. An agent may propose candidates (e.g. a disposable fixture repo generated for the purpose) but Lee decides.
`,
    plan: `
> ### PLAN §9 Evaluation strategy
> Baseline distribution for normal Pi is measured first on the author's real work, then numeric thresholds are set, then the no-Jev and Jev configurations are run. Mocked tests never authorise live requests; live runs need explicit budgets.
${humanPlan}`,
    scope: ["Agent: propose pilot repo options and a sample-task list (10–20 tasks across the intake classes in PLAN §3.A).", "Lee: choose the repo and state data-sharing restrictions."],
    deliverables: ["Proposal comment.", "Decision comment by Lee.", "`docs/decisions/0003-pilot-repo-and-data-sharing.md`."],
    acceptance: ["Pilot repository identified.", "Sample tasks listed.", "Data-sharing restrictions written as explicit allow/deny rules that Stage 2 privacy defaults can encode."],
    verification: ["`test -f docs/decisions/0003-pilot-repo-and-data-sharing.md`"],
    files,
    deps: [],
  },
  {
    key: "m0-budgets",
    title: "Decision: live test budgets (spend, tokens, requests, concurrency)",
    milestone: "M0",
    labels: ["type:approval", "needs-human", "risk:high"],
    planRef: "§2.6, §9, §11",
    todoRef: "§0 'Live test budgets'",
    context: `
Every live run (Jev calls, model calls, unattended phases) must run under hard caps. The product enforces per-phase and per-workflow caps in code; this issue sets the numbers Lee is willing to spend during development and evaluation. Until this is closed, all tests are mocked.
`,
    plan: `
> ### PLAN §2.6 Unattended operation
> Per-phase and per-workflow budget caps with hard stop; notification hooks; a cost estimate before \`run\` begins; a resumable state on any stop.
${humanPlan}`,
    scope: ["Lee states: max spend per live run, per day; token cap; request cap; max concurrent workers; whether local mac-mini models count as zero-cost."],
    deliverables: ["Decision comment.", "`docs/decisions/0004-live-budgets.md`."],
    acceptance: ["All five numbers are recorded.", "Statement of how mac-mini (proxied/local) model cost is accounted."],
    verification: ["`test -f docs/decisions/0004-live-budgets.md`"],
    files,
    deps: [],
  },
  {
    key: "m0-mode",
    title: "Decision: default operating mode and approval classes for the pilot",
    milestone: "M0",
    labels: ["type:approval", "needs-human", "area:workflow", "risk:high"],
    planRef: "§2.6, §4 UI (`/korwf mode`), §11",
    todoRef: "§0 'Pilot operating mode and approval classes'",
    context: `
The product has four modes — shadow, advisory, supervised, bounded autonomous — and a policy that classifies approvals as auto-decide / queue-and-continue / stop-the-phase. Autonomous operation may only be enabled with evidence from lower modes (PLAN §0). This issue records which mode the pilot starts in and which approval classes are pre-approved.
`,
    plan: `
> ### PLAN §2.6 Unattended operation
> \`run\` may take hours with the user absent. Policy must define, per approval class:
> - **Auto-decide** — low-risk classes the user pre-approved for the mode.
> - **Queue and continue** — block the task, continue other ready tasks, notify.
> - **Stop the phase** — high-risk classes.
>
> ### PLAN §0
> Autonomous operation is part of the build. Enabling it requires explicit operating policy and evidence, gathered from the product's own lower operating modes on real tasks, that it meets its acceptance criteria.
${humanPlan}`,
    scope: ["Agent may draft a proposed class table once #m1-approval-classes exists.", "Lee: choose starting mode and the pre-approved auto-decide classes."],
    deliverables: ["Decision comment.", "`docs/decisions/0005-pilot-mode-and-approvals.md`."],
    acceptance: ["Starting mode named.", "Each approval class assigned auto / queue / stop for that mode.", "Explicit statement that bounded-autonomous is not enabled until evidence criteria are defined and met."],
    verification: ["`test -f docs/decisions/0005-pilot-mode-and-approvals.md`"],
    files,
    deps: [],
  },
  {
    key: "m0-sandbox",
    title: "Decision: sandbox setup and additional dependency permissions",
    milestone: "M0",
    labels: ["type:approval", "needs-human", "area:security"],
    planRef: "§3.E (worktrees are not security isolation), §7 Execution policy, §11",
    todoRef: "§0 'Sandbox setup and dependency permissions'",
    context: `
Restricted worker execution uses a separately defined sandbox. Setting one up (e.g. bubblewrap, containers) and adding npm dependencies to the package both need Lee's permission on this machine. Agents may list what they would need and why.
`,
    plan: `
> ### PLAN §3.E
> Worktrees are change isolation, not security isolation. Restricted execution uses a separately defined sandbox.
>
> ### PLAN §7 Execution policy
> Permissions come from user-approved rules and execution isolation, not semantic confidence. Role-specific tools, constrained environments, path boundaries, network policy where the platform supports it.
${humanPlan}`,
    scope: ["Agent: list candidate sandbox mechanisms available on Linux/macOS and the dependency set the package will need (SQLite driver, schema validator, test runner).", "Lee: approve or restrict."],
    deliverables: ["Proposal comment.", "Decision comment.", "`docs/decisions/0006-sandbox-and-dependencies.md`."],
    acceptance: ["Approved dependency list recorded.", "Sandbox approach approved, deferred, or declined — explicitly."],
    verification: ["`test -f docs/decisions/0006-sandbox-and-dependencies.md`"],
    files,
    deps: [],
  },
];
