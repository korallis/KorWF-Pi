// PRD revision 2 — issues derived from docs/PRD.md after reconciling the original
// multi-subscription orchestration PRD with PLAN.md for the mac-mini proxy.
//
// These were opened directly on GitHub (#123-#125) rather than generated, so their
// definitions are recorded here to bring them into the orchestrator's readiness,
// dependency and model-selection logic. `context`/`plan` are summaries; the GitHub issue
// body remains the full requirement, as for every other issue.

const PRD = `
> ### docs/PRD.md (revision 2)
> Reconciles the Jev-centred agentic software factory PRD with PLAN.md. The multi-account
> control plane collapsed to a single provider endpoint, but per-route quota tracking
> survives: the proxy hides accounts, not their quotas.
`;

export default [
  {
    key: "prd-route-identity",
    title: "Track availability, caps and outcomes per route (provider+model), not per model id",
    milestone: "M2",
    labels: ["stage:2", "type:feature", "area:models", "area:storage"],
    planRef: "§3.D, §5; docs/PRD.md §2, §3.4",
    todoRef: "n/a (PRD-derived)",
    context: `
Pi \`models.json\` provider keys are arbitrary user-chosen names with their own \`apiKey\`, so a
user with two subscriptions to one vendor has the same model id under two providers backed by
two independently rate-limited quotas. Keying caps on model id alone mis-attributes a rate
limit across those accounts (Jev 0.86), and \`(provider, model)\` is not stable because provider
keys are renameable (Jev 0.22).

Worse than a lost route: PLAN §3.D pauses the phase when it believes all candidates are capped,
so one account's 429 could stall a workflow with a healthy alternative idle. The author's proxy
setup has one provider per model and structurally cannot reproduce this.
`,
    plan: PRD,
    scope: [
      "Opaque `routeId` identifying a rate-limited route, derived from Pi provider id and model id.",
      "Key `ModelAvailability` and `ModelOutcome` on `routeId`.",
      "Caps, availability, health and outcome history are per route; model cards stay per model.",
      "Selection and fallback rank routes, so the same model under a second provider is a valid fallback.",
      "Decide and document rename behaviour (Jev 0.58 — a genuine trade-off, choose deliberately).",
      "`/korwf models` and `/korwf status` disambiguate two routes for one model id.",
    ],
    deliverables: [
      "`routeId` in `src/storage/records.ts` and the storage schema, with migration if needed.",
      "Route-aware cap/availability handling in `src/models/`.",
      "ADR or `docs/config-reference.md` section recording the rename decision.",
    ],
    acceptance: [
      "Two providers exposing the same model id are tracked as two distinct routes.",
      "A cap on one route does not mark the other capped, and the healthy route stays eligible.",
      "`ModelOutcome` history is attributed per route.",
      "A single-provider user sees no behavioural change and no new required configuration.",
      "The rename behaviour is implemented, documented, and covered by a test.",
      "Works with Jev disabled — route identity and cap attribution are deterministic.",
    ],
    verification: ["`npm run typecheck && npm run build`", "`npm test`"],
    files: ["src/storage/records.ts", "src/models/*", "test/models/*", "test/storage/*"],
    deps: ["m2-package"],
  },
  {
    key: "prd-output-budget",
    title: "Output-token budget awareness: size tasks by maxTokens and classify truncation as a harness failure",
    milestone: "M3",
    labels: ["stage:3", "type:feature", "area:workflow", "area:workers"],
    planRef: "§2.3, §3.C, §3.E; docs/PRD.md §3.3",
    todoRef: "n/a (PRD-derived)",
    context: `
Every turn has a hard output-token ceiling (16384 on every model in the registry), shared with
reasoning at high thinking. A turn asked to produce a large artifact in one tool call is
truncated at \`stopReason: "length"\` BEFORE the tool call is emitted, so nothing is written.

This is the dominant harness failure observed building this repo: six attempts on #14 and three
on #11, ~400k tokens, zero files — all presenting to the gate as "worker overclaims, criteria
unmet", the opposite of the truth. Planning currently sizes tasks by context window;
\`maxTokens\` was the binding constraint.
`,
    plan: PRD,
    scope: [
      "Planner sizes tasks against the selected model's `maxTokens`, not only `contextWindow`.",
      "Worker contracts instruct incremental production: short write, successive edits, commit per file, minimal narration.",
      "Controller detects `stopReason: \"length\"` and classifies it as a harness failure.",
      "A truncated attempt does not consume the task's attempt budget and does not feed 'criteria unmet' feedback.",
      "Repeated truncation is bounded separately so it cannot loop forever.",
    ],
    deliverables: [
      "Task sizing in `src/context/` or `src/workflow/`.",
      "`stopReason` capture and classification in `src/workers/`.",
      "Worker-contract wording in `resources/roles/`.",
    ],
    acceptance: [
      "A task whose expected output exceeds a documented fraction of `maxTokens` is decomposed or flagged at planning time.",
      "`stopReason: \"length\"` is recorded and classified as a harness failure, distinct from a quality failure.",
      "A truncated attempt does not decrement the attempt budget; its feedback describes truncation.",
      "Repeated truncation is bounded and surfaces as a distinct failure, not an infinite retry.",
      "Worker role contracts instruct incremental writes and per-file commits.",
      "Behaviour holds with Jev disabled.",
    ],
    verification: ["`npm run typecheck && npm run build`", "`npm test`"],
    files: ["src/workflow/*", "src/workers/*", "resources/roles/*", "test/workflow/*", "test/workers/*"],
    deps: ["m2-package"],
  },
  {
    key: "prd-route-health",
    title: "Per-model route health and circuit breaking (excluded after repeated failure, not just quota caps)",
    milestone: "M5",
    labels: ["stage:5", "type:feature", "area:models"],
    planRef: "§3.D; docs/PRD.md §3.1",
    todoRef: "n/a (PRD-derived)",
    context: `
PLAN §3.D detects quota caps but has no equivalent for a model that is available but failing
(malformed output, timeouts, 5xx). Jev ranks on task fit, and the task does not change between
attempts, so a failing model keeps winning the ranking — observed on #14, where one model was
selected six consecutive times while failing identically.

Health must be a hard eligibility filter applied AFTER Jev ranks, never an input Jev weighs,
and keyed on route (prd-route-identity) so one account's failures do not exclude a healthy
route for the same model id.
`,
    plan: PRD,
    scope: [
      "Per-route rolling health: success rate over a window, consecutive failures, error classification.",
      "Circuit breaker closed -> open -> half-open -> closed with cooldown and single probe.",
      "Health is a hard filter applied after Jev ranks; Jev can never re-open a breaker.",
      "Breaker state surfaced in `/korwf status` and `/korwf models`, recorded for `/korwf why`.",
      "Harness failures (truncation, crash, timeout) open a breaker only on repetition, not first occurrence.",
      "Owner-approved provisional thresholds: 3 consecutive failures, or >50% of last 10, 15 min cooldown — configurable and documented as pending calibration.",
    ],
    deliverables: [
      "Health tracking in `src/models/` alongside availability/cap code.",
      "Thresholds under the `fallback` section of `src/config/schema.json`.",
    ],
    acceptance: [
      "A route failing N consecutive times is excluded from eligibility without any Jev call.",
      "An excluded route is re-probed once after the cooldown and restored only on success.",
      "A breaker open on one route leaves the same model id on another route eligible.",
      "Breaker state and exclusion reason appear in status output and the decision record.",
      "`stopReason: \"length\"` is classified as a harness failure and does not consume the attempt budget.",
      "With Jev disabled, health filtering still works.",
      "Thresholds are configurable, documented as provisional, with no machine-specific defaults.",
    ],
    verification: ["`npm run typecheck && npm run build`", "`npm test`"],
    files: ["src/models/*", "src/config/schema.json", "test/models/*"],
    deps: ["prd-route-identity", "m5-workers"],
  },
];
