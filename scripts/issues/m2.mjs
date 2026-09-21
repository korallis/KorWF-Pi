// M2 — Package and adapter foundation (PLAN §8 Stage 2)

const S2 = `
> ### PLAN §8 Stage 2: Package and adapter foundation
> Package manifest, modular layout, test harness, config validation, SQLite store and migrations, Jev adapter with mock transport and optional-mode, versioned questions, tracing, accounting, cancellation.
> **Exit:** loads in an isolated Pi session; offline tests pass; works with no Jev key; failures cannot hang Pi or leak credentials.
`;

export default [
  {
    key: "m2-package",
    title: "Package manifest, modular layout, namespaced commands/tools/storage",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:extension", "area:config"],
    planRef: "§3.J, §4, §8 Stage 2",
    todoRef: "§2 'Initialise Git; package manifest per docs/packages.md; modular layout; namespaced commands/tools/storage'",
    context: `
This is the first code issue. It turns the repo into an installable Pi package with the module layout decided in Stage 1 (\`docs/adr/0002-source-layout.md\`), registers the \`/korwf\` command namespace with a single placeholder subcommand (\`/korwf version\`), and defines the storage namespace. Everything else in Stage 2 builds on this.

Read \`docs/packages.md\` in the Pi install and \`docs/pi-integration-map.md\` first.
`,
    plan: `
> ### PLAN §3.J
> Distributed as a Pi package per \`docs/packages.md\`; install/upgrade/disable/uninstall through Pi's mechanism. Namespaced commands, tools, and storage; documented platform support (Linux, macOS; Windows status stated explicitly).
${S2}`,
    scope: [
      "`package.json` with Pi package metadata, `type: module`, TypeScript, and scripts: `build`, `test`, `lint`, `typecheck`, `format`.",
      "Directory skeleton per the Stage 1 layout ADR with an `index.ts` per module exporting nothing yet but compiling.",
      "Extension entry point registering `/korwf` with a `version` subcommand.",
      "Storage root resolution: `<project>/.korwf/` by default, overridable by config; never inside the user's source tree except that folder; added to `.gitignore` template.",
      "`docs/platform-support.md` stating Linux and macOS supported, Windows untested.",
    ],
    deliverables: ["`package.json`, `tsconfig.json`, `src/**/index.ts`, `src/extension/index.ts`.", "`docs/platform-support.md`."],
    acceptance: [
      "`pi` loads the package from a clean temporary Pi config dir and `/korwf version` prints the package version.",
      "No command, tool, or storage path lacks the `korwf` prefix.",
      "`npm run typecheck` and `npm run build` exit 0.",
    ],
    verification: ["`npm run typecheck && npm run build`", "Isolated-session load: run Pi with an empty temp config dir, install the package from the local path, run `/korwf version` — paste the transcript."],
    files: ["package.json", "tsconfig.json", "src/extension/index.ts", "src/*/index.ts", "docs/platform-support.md"],
    deps: ["m1-reuse-table", "m1-pi-docs"],
  },
  {
    key: "m2-toolchain",
    title: "Formatting, type checking, unit and integration test harness",
    milestone: "M2",
    labels: ["stage:2", "type:test", "area:extension"],
    planRef: "§8 Stage 2",
    todoRef: "§2 'Formatting, type checking, unit and integration test scripts'",
    context: `
Every later issue's Verification section runs \`npm test\`. Set up the test runner (Node's built-in \`node:test\` or Vitest — choose and record in an ADR), a formatter (Biome or Prettier — choose one), strict TypeScript, and a CI workflow so PRs are checked automatically. Dependencies must be within the M0 approved list; if none is approved yet, use only Node built-ins and document it.
`,
    plan: S2,
    scope: [
      "Unit tests under `test/unit`, integration under `test/integration`, scenario stubs under `test/scenarios` (from Stage 1).",
      "A `test/helpers/` module with a temp-dir fixture and a fake clock.",
      "GitHub Actions workflow: typecheck, lint, test on ubuntu and macos.",
      "Pre-commit-style secret scan script `scripts/check-secrets.sh` (grep for `apikey_`, `sk-`, `ghp_`, `JEV_API_KEY=`) wired into CI.", // check-secrets:allow
    ],
    deliverables: ["`.github/workflows/ci.yml`.", "`test/helpers/*`.", "`scripts/check-secrets.sh`.", "`docs/adr/00xx-toolchain.md`."],
    acceptance: ["`npm test` runs at least one real unit test and one integration test and exits 0.", "CI passes on a PR.", "Secret scan fails CI if a fake key is committed (prove with a scratch branch, then delete it)."],
    verification: ["`npm run lint && npm run typecheck && npm test`", "`bash scripts/check-secrets.sh` exit 0 on main"],
    files: [".github/workflows/ci.yml", "test/helpers/", "scripts/check-secrets.sh"],
    deps: ["m2-package"],
  },
  {
    key: "m2-config",
    title: "Config loading, validation, safe defaults, and first-use disclosure",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:config", "area:security"],
    planRef: "§3.J, §7 Data policy",
    todoRef: "§2 'Config loading, validation, safe defaults, first-use disclosure'",
    context: `
Implements the schema drafted in Stage 1 (\`src/config/schema.json\`, \`docs/config-reference.md\`). Config is read from the project (\`.korwf/config.json\`) and the user's Pi config dir, merged (project overrides user), validated, and frozen. The first time the extension runs in a project it must show what data goes where before any outbound call.
`,
    plan: `
> ### PLAN §3.J
> Config schema with validation and safe defaults. Runs without a Jev key: deterministic workflow fully functional; Jev features off with a clear message.
>
> ### PLAN §7 Data policy
> First-use disclosure: which data classes go to TypeSafe and to model providers.
${S2}`,
    scope: [
      "`loadConfig(projectDir)` → validated, typed, deep-frozen config; validation errors are precise (path + reason) and never crash Pi.",
      "Merge order: shipped defaults < user config < project config < env overrides (documented set only).",
      "Invariants enforced in code: privacy deny list ⊇ shipped minimum; static fallback order ⊆ allowlist; high-risk approval classes never `auto`.",
      "First-use disclosure recorded in storage (`disclosureAcceptedAt`, package version); re-shown when the disclosure text version changes.",
    ],
    deliverables: ["`src/config/load.ts`, `src/config/validate.ts`, `src/config/defaults.ts`.", "`src/extension/disclosure.ts`.", "Tests for each invariant and for malformed input."],
    acceptance: [
      "Empty config → valid, Jev disabled, all defaults.",
      "Each invariant has a failing-input test that is rejected with a path-qualified error.",
      "Disclosure shown once per project per disclosure version; test proves it.",
      "No outbound call is possible before disclosure is accepted (test with a stub transport that throws if called).",
    ],
    verification: ["`npm test -- config`"],
    files: ["src/config/", "src/extension/disclosure.ts", "test/unit/config/"],
    deps: ["m2-toolchain", "m1-config-schema", "m1-approval-classes"],
  },
  {
    key: "m2-secrets",
    title: "Credential resolution; secrets excluded from all logs and exports",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:security", "risk:high"],
    planRef: "§7 Jev transport, §3.J",
    todoRef: "§2 'Credential resolution; secrets excluded from all logs and exports'",
    context: `
Implements the mechanism decided in M0 (\`docs/decisions/0002-jev-secret-mechanism.md\`). The key is resolved lazily, held only in memory, and a redaction layer ensures it can never appear in logs, traces, error messages, artifacts, session entries, or exports.
`,
    plan: `
> ### PLAN §7 Jev transport
> Key resolved through an approved secret mechanism (env var or Pi's secrets facility), never stored in the repo, transcripts, or logs.
>
> ### PLAN §10
> Privacy defaults enforced; no credential leakage in output, logs, artifacts, or exports.
${S2}`,
    scope: [
      "`resolveJevKey(config)` → `Secret` wrapper whose `toString()`/`toJSON()`/`inspect` return `[redacted]`.",
      "Global redactor applied to every logger sink and every error before it is surfaced to Pi or written to disk; redacts the resolved key value and generic patterns (`apikey_…`, bearer tokens).",
      "Key absent → Jev disabled with one clear message, not an error.",
    ],
    deliverables: ["`src/security/secrets.ts`, `src/security/redact.ts`.", "Tests: key never appears in logger output, thrown error text, JSON.stringify of any record, or a simulated crash dump."],
    acceptance: ["Test writes a known fake key through every log/error/export path and asserts it is absent from all outputs.", "Missing key yields a disabled-Jev config, not an exception.", "`Secret` cannot be serialised by accident (test JSON.stringify, template literal, console.log)."],
    verification: ["`npm test -- secrets`", "`bash scripts/check-secrets.sh`"],
    files: ["src/security/secrets.ts", "src/security/redact.ts", "test/unit/security/"],
    deps: ["m2-config", "m0-key"],
  },
  {
    key: "m2-storage",
    title: "SQLite store: migrations, lockfile ownership, append-only audit, artifact directory",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:storage"],
    planRef: "§5, §3.E (coordinator lock)",
    todoRef: "§2 'SQLite store, migrations, lockfile ownership, append-only audit, artifact directory'",
    context: `
Implements persistence for the records defined in Stage 1 (\`src/storage/records.ts\`, \`docs/records.md\`). Single writer process, explicit migrations, append-only audit, and an artifact directory. The SQLite driver must be on the M0-approved dependency list (Node ≥ 22 has \`node:sqlite\` built in — prefer it if the Node version floor allows; record the choice).
`,
    plan: `
> ### PLAN §5
> **Store: SQLite** (decided), single writer process, lockfile for coordinator ownership, explicit migrations, append-only audit table, artifact directory. Abandoned attempts reconciled on startup.
${S2}`,
    scope: [
      "Migration runner with numbered SQL files and a `schema_version` table; forward-only; runs on open.",
      "Repository per record type with typed CRUD; append-only types expose insert/read only.",
      "`audit` table: every state transition and policy decision, with actor and timestamp; no update/delete.",
      "Lockfile at `.korwf/coordinator.lock` containing pid + start time; stale-lock detection (pid dead) and takeover with audit entry.",
      "Artifact directory `.korwf/artifacts/<attemptId>/` with a manifest.",
      "Startup reconciliation hook (interface only; Stage 5 supplies the attempt logic).",
    ],
    deliverables: ["`src/storage/db.ts`, `src/storage/migrations/*.sql`, `src/storage/repos/*.ts`, `src/storage/lock.ts`, `src/storage/artifacts.ts`.", "Tests including crash-during-migration and concurrent-open."],
    acceptance: ["All ten record types round-trip.", "Attempting to update an audit row throws.", "Second process opening the store while lock is held gets a clear read-only/denied result; stale lock is taken over.", "Migration from empty DB and from each prior version succeeds (test matrix grows with versions)."],
    verification: ["`npm test -- storage`"],
    files: ["src/storage/", "test/unit/storage/", "test/integration/storage/"],
    deps: ["m2-toolchain", "m1-records", "m0-sandbox"],
  },
  {
    key: "m2-jev-transport",
    title: "Jev transport behind a mockable interface; configurable base URL; optional mode with no key",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:jev"],
    planRef: "§7 Jev transport, §3.J, §6",
    todoRef: "§2 'Jev transport behind mockable interface; configurable base URL; optional mode when no key'",
    context: `
The adapter that every Jev question goes through. Uses the transport decision from \`docs/adr/0003-jev-transport.md\` and the schemas from \`docs/typesafe-api-reference.md\`. Must be fully testable offline via a mock transport, and must degrade to a \`DisabledJev\` implementation when there is no key.
`,
    plan: `
> ### PLAN §7 Jev transport
> Direct TypeSafe API using the user's own key, with a configurable base URL for users who proxy.
>
> ### PLAN §6
> Jev is optional at runtime: every Jev-assisted decision has a deterministic fallback behaviour.
${S2}`,
    scope: [
      "`JevTransport` interface: `choice()`, `score()`, `noul()` taking typed requests, returning typed raw responses; plus `ping()`.",
      "`HttpJevTransport` (real), `MockJevTransport` (scripted responses + call recorder), `DisabledJevTransport` (every call returns `{kind:'disabled'}` immediately).",
      "Base URL from config; key from `src/security/secrets.ts`; all requests carry a request id for tracing.",
      "Factory `createJev(config)` chooses the implementation; never throws for a missing key.",
    ],
    deliverables: ["`src/jev/transport.ts`, `src/jev/http.ts`, `src/jev/mock.ts`, `src/jev/disabled.ts`, `src/jev/index.ts`.", "Tests use only the mock; the HTTP transport is tested against a local fake server, never the real API."],
    acceptance: ["No test makes a network request to typesafe.ai (assert via a fetch stub that fails on unknown hosts).", "Disabled transport returns within 1 ms and records nothing sensitive.", "Base URL override is honoured (fake server test)."],
    verification: ["`npm test -- jev`"],
    files: ["src/jev/", "test/unit/jev/"],
    deps: ["m2-secrets", "m1-typesafe"],
  },
  {
    key: "m2-jev-validation",
    title: "Response validation for Choice / Score / Noul (unknown fields, bounds, malformed)",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:jev"],
    planRef: "§6",
    todoRef: "§2 'Response validation for Choice/Score/Noul'",
    context: `
Raw Jev responses are untrusted input. Validate every response against the schema recorded in \`docs/typesafe-api-reference.md\` before it reaches any decision logic. Preserve the raw distribution alongside the validated result.
`,
    plan: `
> ### PLAN §6
> Preserve raw distributions; validate schemas and bounds; pin tested Jev versions.
${S2}`,
    scope: ["Validators per question type returning `{ok, value, raw}` or `{ok:false, reason, raw}`.", "Bounds: probabilities in [0,1] and summing to ~1 for Choice; scores within declared range; option labels must match the request's options exactly; unknown fields are kept in `raw` but never in `value`.", "Model version in response must match the pinned version or produce a `version_mismatch` result (not an exception)."],
    deliverables: ["`src/jev/validate.ts`.", "Fixture files of malformed responses under `test/fixtures/jev/`."],
    acceptance: ["≥ 12 malformed fixtures each produce a typed rejection, never a throw.", "Version mismatch is surfaced as a result and logged once."],
    verification: ["`npm test -- jev/validate`"],
    files: ["src/jev/validate.ts", "test/fixtures/jev/"],
    deps: ["m2-jev-transport"],
  },
  {
    key: "m2-resilience",
    title: "Cancellation, deadlines, bounded retries, backoff, and circuit breaking for Jev and model calls",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:jev", "area:telemetry"],
    planRef: "§8 Stage 2 exit, §3.G",
    todoRef: "§2 'Cancellation, deadlines, bounded retries, backoff, circuit breaking'",
    context: `
Stage 2's exit criterion says failures cannot hang Pi. Every outbound call must be cancellable via \`AbortSignal\`, bounded by a deadline, retried only for idempotent failures with jittered backoff, and cut off by a circuit breaker after repeated failures so the product falls back to deterministic behaviour instead of stalling.
`,
    plan: `
> ### PLAN §8 Stage 2 exit
> failures cannot hang Pi or leak credentials.
>
> ### PLAN §3.G
> No blind retry of side effects; reconcile uncertain outcomes first.
${S2}`,
    scope: ["`withDeadline`, `withRetry` (idempotent-only flag, max attempts, jitter), `CircuitBreaker` (closed/open/half-open, per host).", "Wrap the HTTP Jev transport; expose breaker state to status.", "Cancellation propagates from Pi's abort signal through every await."],
    deliverables: ["`src/jev/resilience.ts` (or `src/telemetry/resilience.ts` if shared).", "Tests with fake timers for each behaviour."],
    acceptance: ["A hung transport is abandoned at the deadline and the caller receives a typed timeout.", "Breaker opens after N failures and the Jev factory returns disabled-mode results while open.", "Aborting the signal mid-retry stops further attempts within one tick."],
    verification: ["`npm test -- resilience`"],
    files: ["src/jev/resilience.ts", "test/unit/jev/resilience.test.ts"],
    deps: ["m2-jev-transport"],
  },
  {
    key: "m2-questions",
    title: "Versioned question definitions and composition policy",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:decisions"],
    planRef: "§6",
    todoRef: "§2 'Versioned question definitions and composition policy'",
    context: `
Every Jev question the product asks is a versioned artefact: prompt text, options, expected type, boundary cases, and the deterministic fallback used when Jev is disabled or abstains. This issue builds the registry and the composition layer (batch independent questions, stage dependent ones). The actual question families are added by later stages.
`,
    plan: `
> ### PLAN §6 Jev decision design
> Narrow, versioned Choice, Score, and Noul questions with explicit boundary cases and none/unknown outcomes. Question families: intake classification; passage relevance/staleness/contradiction; task atomicity/coverage/readiness; task profile; model selection and fallback ranking; semantic coupling; completion-claim support; evidence gap; test-exercises-requirement; review-finding severity; memory classification. Minimal relevant state per evaluation; batch independent questions; stage dependent ones. Graph algorithms, arithmetic, counters, schema checks in code.
${S2}`,
    scope: ["`QuestionDefinition<TState, TResult>`: id, version, type, build(state) → request, interpret(validated) → result, fallback(state) → result, boundary examples.", "Registry keyed by `id@version`; changing text requires a version bump (test compares a content hash).", "`ask(question, state)` records a Decision record (state hash, question version, Jev version, raw, result, rule applied) via storage.", "`askAll([...])` batches independent questions with a concurrency cap; `askStaged` for dependent chains."],
    deliverables: ["`src/decisions/question.ts`, `src/decisions/registry.ts`, `src/decisions/ask.ts`.", "One example question (`example.echo@1`) used only in tests."],
    acceptance: ["Every `ask` writes a Decision record even in disabled mode (rule = 'fallback').", "Changing a question's prompt without bumping the version fails a test.", "`askAll` with the mock transport issues calls concurrently up to the cap."],
    verification: ["`npm test -- decisions`"],
    files: ["src/decisions/", "test/unit/decisions/"],
    deps: ["m2-jev-validation", "m2-storage"],
  },
  {
    key: "m2-outbound-policy",
    title: "Minimal-state construction, outbound size limits, default-deny path and data filtering",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:security", "risk:high"],
    planRef: "§7 Data policy, §6",
    todoRef: "§2 'Minimal-state construction, outbound limits, default-deny path/data filtering'",
    context: `
Before anything is sent to Jev or a model provider it passes through one outbound policy: strip content from denied paths, redact secret-shaped strings, truncate to configured byte limits, and record what was sent (sanitised) for the decision trace. This is the enforcement point for the privacy config.
`,
    plan: `
> ### PLAN §7 Data policy
> Default-deny outbound for secrets and sensitive paths (\`.env*\`, key files, credential stores, \`node_modules\`, build output, and a documented list). Minimal outbound snippets; sanitised logs. Untrusted repository/tool content isolated from instruction and policy sources.
>
> ### PLAN §6
> Minimal relevant state per evaluation.
${S2}`,
    scope: ["`OutboundPolicy.filter(payload, {purpose})` → filtered payload + report of what was removed/truncated.", "Deny-path matcher (globs from config ∪ shipped minimum).", "Secret-pattern redactor (reuse `src/security/redact.ts`).", "Per-purpose byte caps from config.", "Wire into `src/decisions/ask.ts` so nothing reaches the transport unfiltered."],
    deliverables: ["`src/security/outbound.ts`.", "Shipped minimum deny list in `src/security/deny-list.ts` with a doc comment explaining each entry."],
    acceptance: ["A payload containing `.env` content, a `node_modules` file, and a fake key is filtered so none reach the mock transport (test).", "Truncation keeps a marker and the report says how many bytes were dropped.", "Filter cannot be bypassed: the transport interface only accepts `FilteredPayload` (branded type)."],
    verification: ["`npm test -- outbound`"],
    files: ["src/security/outbound.ts", "src/security/deny-list.ts", "test/unit/security/outbound.test.ts"],
    deps: ["m2-questions"],
  },
  {
    key: "m2-cache",
    title: "Revision-aware caching and invalidation for decisions",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:decisions", "area:storage"],
    planRef: "§6",
    todoRef: "§2 'Revision-aware caching and invalidation'",
    context: `
Repeated identical Jev questions should not be re-asked, but a cache hit must never serve a stale approval or revision-sensitive evidence. Keys include everything that can change the answer.
`,
    plan: `
> ### PLAN §6
> Cache only with complete versioned keys; never reuse stale approvals or revision-sensitive evidence.
${S2}`,
    scope: ["Cache key = hash(question id@version, Jev model version, policy version, state hash, repo revision where the question is revision-sensitive).", "Questions declare `revisionSensitive: boolean`; Approval-related questions are never cached.", "Backed by a table in the SQLite store with TTL from config."],
    deliverables: ["`src/decisions/cache.ts`.", "Tests for key completeness and for invalidation on each key component change."],
    acceptance: ["Changing any key component produces a miss (one test per component).", "Approval questions bypass the cache (test)."],
    verification: ["`npm test -- decisions/cache`"],
    files: ["src/decisions/cache.ts"],
    deps: ["m2-questions"],
  },
  {
    key: "m2-accounting",
    title: "Usage accounting, atomic budget reservations, known/estimated/unknown cost",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:telemetry", "risk:high"],
    planRef: "§2.6, §3.I, §3.D",
    todoRef: "§2 'Usage accounting; atomic budget reservations; known/estimated/unknown cost'",
    context: `
Budgets are hard limits enforced in code. Every Jev call and model call reserves budget before it runs and settles after. Cost may be known (priced model), estimated (pre-call), or unknown (proxy with zero cost metadata) — all three are tracked separately so reports are honest.
`,
    plan: `
> ### PLAN §2.6
> Per-phase and per-workflow budget caps with hard stop.
>
> ### PLAN §3.I
> Latency, errors, overrides, retries, actual/estimated/unknown cost tracked explicitly.
${S2}`,
    scope: ["`Ledger` in storage: reservations and settlements per scope (workflow, phase, task, attempt) with spend, tokens, requests.", "`reserve(scope, estimate)` is atomic (SQLite transaction) and fails with `BudgetExceeded` if any enclosing cap would be breached.", "Cost classification: `known | estimated | unknown`; unknown cost counts against request/token caps and is reported as unknown, never as zero spend.", "Status API to read remaining budget per scope."],
    deliverables: ["`src/telemetry/ledger.ts`.", "Concurrency test with many parallel reservations against a small cap."],
    acceptance: ["Parallel reservations never exceed the cap (test with 100 concurrent attempts against cap 10).", "Unknown-cost calls appear in reports as unknown, not 0.", "Reservation without settlement is reconciled on startup as `abandoned`."],
    verification: ["`npm test -- ledger`"],
    files: ["src/telemetry/ledger.ts", "test/unit/telemetry/"],
    deps: ["m2-storage", "m0-budgets"],
  },
  {
    key: "m2-traces",
    title: "Decision traces, retention, and opt-in raw-payload logging",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:telemetry", "area:security"],
    planRef: "§3.I, §7",
    todoRef: "§2 'Decision traces; retention; raw-payload logging opt-in'",
    context: `
\`/korwf why <decision>\` (Stage 8 UI) explains decisions from recorded inputs. This issue makes sure every decision, model call, and policy application leaves a trace with versions, latency, and outcome — sanitised by default, raw only when the user opts in, with retention and deletion.
`,
    plan: `
> ### PLAN §3.I
> Decisions explained from recorded inputs, returned values, and policy rules — never fabricated rationales. Versions recorded: Jev model, question set, policy, schema, package.
>
> ### PLAN §7
> Sanitised logs; raw payload logging opt-in with retention and deletion controls.
${S2}`,
    scope: ["Trace record linked to Decision/Attempt: versions (package, schema, policy, question set, Jev model), latency, retries, breaker state, sanitised request summary, result.", "Raw payload storage only if `privacy.rawPayloadLogging.enabled`; stored under artifacts with the configured retention; `korwf` maintenance command to purge.", "Redactor applied to every trace field."],
    deliverables: ["`src/telemetry/trace.ts`, `src/telemetry/retention.ts`."],
    acceptance: ["Default config stores no raw payloads (test asserts absence on disk).", "With opt-in, raw payloads are stored and purged after retention (fake clock test).", "Every trace has all five version fields populated."],
    verification: ["`npm test -- trace`"],
    files: ["src/telemetry/trace.ts", "src/telemetry/retention.ts"],
    deps: ["m2-questions", "m2-secrets"],
  },
  {
    key: "m2-load-tests",
    title: "Isolated-session load test, no-key load test, lifecycle cleanup test",
    milestone: "M2",
    labels: ["stage:2", "type:test", "area:extension"],
    planRef: "§8 Stage 2 exit",
    todoRef: "§2 'Isolated-session load test; no-key load test; lifecycle cleanup test'",
    context: `
Proves the Stage 2 exit criterion end to end. These are integration tests that start a real Pi process with the package installed in a temporary config directory.
`,
    plan: S2,
    scope: ["Test 1: fresh temp Pi config, install package, start Pi, `/korwf version`, exit — no errors, no files written outside temp dir and `.korwf/`.", "Test 2: same with no Jev key in the environment — `/korwf status` reports Jev disabled with the documented message; no network attempt (fetch stub).", "Test 3: start, open store, kill Pi with SIGKILL, restart — lock is recovered, audit shows takeover, no corruption.", "Test 4: with a fake key in env, run a mock decision; assert the key appears nowhere on disk under temp dir."],
    deliverables: ["`test/integration/lifecycle/*.test.ts`."],
    acceptance: ["All four tests pass in CI on Linux and macOS.", "M2 milestone exit criteria are each mapped to a test name in the PR."],
    verification: ["`npm test -- lifecycle`"],
    files: ["test/integration/lifecycle/"],
    deps: ["m2-config", "m2-secrets", "m2-storage", "m2-jev-transport", "m2-resilience", "m2-accounting", "m2-traces"],
  },
];
