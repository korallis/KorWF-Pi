# Configuration reference

Status: **draft** (issue #11, Stage 1). Authority: `PLAN.md` §3.J, §3.D, §2.6, §7.
Schema: [`src/config/schema.json`](../src/config/schema.json) (JSON Schema draft 2020-12).
Types: [`src/config/types.ts`](../src/config/types.ts).

KorWF-Pi reads one config file. **Every key has a default, and an empty file (`{}`) is a
complete, working configuration**: no Jev key, shadow mode, every model Pi already has
configured is eligible, nothing leaves the machine except what the user later opts into.
Loading, layered merge and the validator itself are issue #21; this document is the
contract they implement.

Rules that apply everywhere:

- **Unknown keys are rejected** (`additionalProperties: false`) so a typo cannot silently
  disable a policy.
- **Config can only tighten shipped policy, never loosen it** (AGENTS.md §4). Fields that
  would loosen it are pinned with `const` in the schema and marked *fixed* below.
- **No secrets in config.** `jev.keySource` names *where* a key lives, never the key.
- **No machine-specific defaults.** No default contains a user path, hostname, or provider
  name. The only hostname in the shipped defaults is the public TypeSafe API origin.
  (The author's development allowlist, PLAN §11, lives in a local, uncommitted file.)

Table columns: **Key** · **Type** · **Default** · **Why the default is safe**.

## Contents

1. [Root](#1-root)
2. [`models`](#2-models)
3. [`budgets`](#3-budgets)
4. [`mode`](#4-mode)
5. [`approvals`](#5-approvals)
6. [`privacy`](#6-privacy)
7. [`fallback`](#7-fallback)
8. [`jev`](#8-jev)
9. [`notifications`](#9-notifications)
10. [`storage`](#10-storage)
10a. [`recovery`](#10a-recovery)
10b. [`verification`](#10b-verification)
11. [Validation rules beyond types](#11-validation-rules-beyond-types)
12. [Worked examples](#12-worked-examples)
13. [Loading, layered merge, and environment overrides](#13-loading-layered-merge-and-environment-overrides)
14. [First-use disclosure](#14-first-use-disclosure)
15. [Credential resolution and redaction](#15-credential-resolution-and-redaction)

## 1. Root

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `$schema` | string | — (optional) | Editor tooling only; ignored by the loader. |
| `configVersion` | integer, `const 1` | `1` | Lets the loader refuse or migrate files from a different schema generation instead of misreading them. |
| `models` | object | `{}` | See §2. |
| `budgets` | object | `{}` | See §3. |
| `mode` | enum | `"shadow"` | See §4. |
| `approvals` | object | `{}` | See §5. |
| `privacy` | object | `{}` | See §6. |
| `fallback` | object | `{}` | See §7. |
| `jev` | object | `{}` | See §8. |
| `notifications` | object | `{}` | See §9. |
| `storage` | object | `{}` | See §10. |
| `recovery` | object | `{}` | See §10a. |
| `verification` | object | `{}` | See §10b. |

## 2. `models`

PLAN §3.D: eligible models are whatever the user's Pi has configured, filtered by an
optional allowlist. The system never uses a provider or model outside the allowlist.

### 2.1 `models.allowlist`

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `providers` | `string[]`, unique | `[]` | Empty = every provider Pi has configured. Pi's own provider config is the user's existing trust decision; the product adds a filter, not new providers. Naming a default provider here would be a machine-specific default (forbidden). |
| `models` | `ModelRef[]` (`<provider>/<modelId>`), unique | `[]` | Empty = every model of an eligible provider. Same reasoning as `providers`. |
| `pins` | `{ [TaskKind]: ModelRef }` | `{}` | No pins: Jev (or static order) selects per task. A pinned model is never overridden by fallback without asking (PLAN §3.D), so pins are a deliberate user choice, never a shipped one. |

`TaskKind` = `default | plan | implement | test | review | docs | refactor | research`.

### 2.1.1 Routes: the same model id under two providers (#125)

Pi provider keys are user-chosen names, each with its own `baseUrl` and `apiKey`, so a
user with two subscriptions to one vendor lists the same model id under two providers.
The product treats each `(provider, model)` pair as a separate **route** with its own
opaque `routeId`; caps, health and outcome history are tracked per route, while model
cards stay per model id. **No configuration is required**: the provider list already in
Pi's `models.json` is the only source of truth, and a single-provider setup has exactly
one route per model. `fallback.staticOrder` refs name a provider, so listing
`<provider-b>/<model>` after `<provider-a>/<model>` makes the second account a legitimate
fallback when the first is rate-limited. **Renaming a provider key creates a new route
and does not carry over its history** — see `docs/adr/0011-route-identity.md`.

### 2.2 `models.overrides`

`{ [ModelRef]: { notes?: string (≤ 2000), aptitudes?: string[], disabled?: boolean } }`, default `{}`.
Card layer 3 (PLAN §3.D). Empty by default because bundled aptitude hints and registry
metadata already give every model a card; user notes only refine ranking. `disabled: true`
removes the model from the effective allowlist (tightening only).

## 3. `budgets`

PLAN §2.6: per-phase and per-workflow caps with **hard stop**. Every cap uses the
`Budget` record shape from `docs/records.md` (`maxSpendUsd`, `maxTokens`, `maxRequests`,
`maxConcurrency`, `maxElapsedMs`; each `number ≥ 0 | null`, `null` = no cap of that kind).
Exceeding a cap stops that scope and leaves a resumable state; it is never a silent degrade.

| Key | Default | Why the default is safe |
|---|---|---|
| `workflow` | `{ maxSpendUsd: 10, maxTokens: null, maxRequests: null, maxConcurrency: 2, maxElapsedMs: null }` | A first unattended `run` cannot spend more than a small, visible amount before the user raises it; two concurrent workers bound machine load and worktree churn. Token/request caps are `null` because spend already bounds them and local models report zero cost — elapsed is uncapped because a paused phase waiting on a cap must not be counted as failure. |
| `phase` | all `null` | Phases inherit the workflow cap; a per-phase cap is a refinement the user sets once they know their phase sizes. |
| `task` | `{ maxSpendUsd: null, maxRequests: 200, maxConcurrency: 1, maxElapsedMs: 3600000, …null }` | A runaway task is stopped after 200 model requests or one hour, well inside the workflow spend cap; one worker per task matches the worker contract (ADR-0004). |
| `jev` | `{ maxSpendUsd: 1, maxConcurrency: 4, …null }` | Jev spend is metered separately so a decision loop cannot eat the model budget; $1 at $0.042/Mtok is ~24M input tokens. Ignored when Jev is disabled. |
| `costEstimateBeforeRun` | `true` | PLAN §2.6 requires a cost estimate before `run` begins. |

Validator rules V2–V3 (§11) require task ≤ phase ≤ workflow where both sides are non-null.

## 4. `mode`

`"shadow" | "advisory" | "supervised" | "bounded_autonomous"` — identical to `WorkflowMode`
in `docs/records.md`. Default **`shadow`**.

| Mode | Behaviour |
|---|---|
| `shadow` | Observe, plan and record decisions; **no mutation** of the repository. Produces calibration data (PLAN §6). |
| `advisory` | Propose tasks, models and reviews; never act. |
| `supervised` | Act only after explicit approval for each queued class (§5). |
| `bounded_autonomous` | Act within budgets and pre-approved classes; high-risk classes still stop. |

Shadow is the default because it is the only mode that cannot change the user's repository
or spend on workers, and it is the mode the calibration strategy needs first. A workflow
records its mode on the `Workflow` row; changing config does not retroactively change a
running workflow (gates § invariants).

## 5. `approvals`

PLAN §2.6: per approval class and mode, one of **`auto`** (pre-approved for the mode),
**`queue`** (block this task, continue other ready tasks, notify), **`stop`** (stop the phase
and wait for the user). This is unattended-operation policy; it never replaces the task
gate's `Approval` record (`docs/gates.md` C3), which a `policy` actor cannot satisfy.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `queueTimeoutMinutes` | integer ≥ 0 | `0` | `0` = a queued item waits indefinitely. A timeout can only mark the task *blocked*; nothing is ever auto-approved on timeout. |
| `classes` | object | see below | Every class has an explicit per-mode decision. |

### 5.1 `approvals.classes` defaults

The full vocabulary, per-class rationale and the deterministic classifier are in
[approval-classes.md](approval-classes.md) (issue #15); `src/workflow/approval-classes.ts`
is the data authority and a test fails if this schema's defaults drift from it.
Columns are modes: shadow / advisory / supervised / bounded_autonomous.

| Class | shadow | advisory | supervised | bounded_autonomous | Tier |
|---|---|---|---|---|---|
| `read_repository` | auto | auto | auto | auto | configurable |
| `edit_worktree` | stop | stop | queue | auto | configurable |
| `delete_file` | stop | stop | queue | auto | configurable |
| `write_outside_ownership` | stop | stop | queue | queue | configurable |
| `modify_project_config` | stop | stop | queue | queue | configurable |
| `run_checks` | stop | stop | auto | auto | configurable |
| `run_shell` | stop | stop | queue | queue | configurable |
| `run_migration` | stop | stop | queue | queue | configurable |
| `install_dependencies` | stop | stop | queue | queue | configurable |
| `add_dependency` | stop | stop | queue | queue | configurable |
| `network_access` | stop | stop | queue | queue | configurable |
| `local_commit` | stop | stop | queue | auto | configurable |
| `push_own_branch` | stop | stop | queue | auto | configurable |
| `spawn_worker` | stop | stop | queue | auto | configurable |
| `model_fallback` | auto | auto | queue | auto | configurable |
| `model_substitute_more_expensive` | auto | auto | queue | queue | configurable |
| `spend_over_estimate` | auto | auto | queue | queue | configurable |
| `complete_task` | stop | stop | queue | auto | configurable |
| `scope_change` | stop | stop | queue | queue | never `auto` (V11) |
| `replan` | stop | stop | queue | queue | never `auto` (V11) |
| `destructive_cleanup` | **stop** | **stop** | **stop** | **stop** | **high-risk, fixed (V10)** |
| `destructive_git` | **stop** | **stop** | **stop** | **stop** | **high-risk, fixed (V10)** |
| `remote_push` | **stop** | **stop** | **stop** | **stop** | **high-risk, fixed (V10)** |
| `deployment` | **stop** | **stop** | **stop** | **stop** | **high-risk, fixed (V10)** |
| `publishing` | **stop** | **stop** | **stop** | **stop** | **high-risk, fixed (V10)** |
| `credential_access` | **stop** | **stop** | **stop** | **stop** | **high-risk, fixed (V10)** |
| `modify_policy` | **stop** | **stop** | **stop** | **stop** | **high-risk, fixed (V10)** |

High-risk rows use `$defs/HighRiskPolicy`, whose four properties are each `const: "stop"`.
A config that sets any of them to `auto` or `queue` fails schema validation — the system
never weakens its own permission policy (AGENTS.md §4). `scope_change` and `replan` use
`$defs/NoAutoPolicy` (`enum: ["queue", "stop"]`). The configurable rows may be set to any
decision; validator rule V4 additionally forbids `auto` for mutation classes in `shadow` and
`advisory`, because those modes are defined as non-mutating. `remote_push` means a push to a
ref the workflow does not own; the agent's own task branch is `push_own_branch`
(PLAN §7, ADR 0005).

## 6. `privacy`

PLAN §7 data policy: default-deny outbound for secrets and sensitive paths, minimal
snippets, raw payload logging opt-in. "Outbound" means anything sent to TypeSafe, to a
model provider, to a notification channel, or written to a log.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `denyPaths` | `string[]` (globs), unique | shipped minimum (§6.1) | Files matching a deny glob are never read into outbound context or logs. The schema requires the list to **contain every shipped entry** (`allOf: [{contains: {const: …}}]`), so config can add globs but cannot remove or replace the minimum. |
| `denyPatterns` | `string[]` (ECMAScript regex, flags `iu`, per line), unique | shipped minimum (§6.2) | A matching line is redacted before any outbound request or log write. Same superset constraint as `denyPaths`. |
| `allowPaths` | `string[]` (globs), unique | `[]` | Explicit per-project carve-outs (e.g. `docs/fixtures/.env.example`). Empty by default; a carve-out may not be broader than the entry it relaxes (V7), and never applies to logging. |
| `outbound.maxSnippetBytes` | integer ≥ 0 | `4096` | Bounds the largest single excerpt; passage selection must justify anything larger. |
| `outbound.maxSnippetsPerRequest` | integer ≥ 0 | `16` | Bounds fan-out per request. |
| `outbound.maxRequestBytes` | integer ≥ 0 | `262144` | Hard cap (256 KiB) on any outbound body, independent of snippet counts. |
| `outbound.sendFilePaths` | boolean | `true` | Project-relative paths are needed for useful decisions; absolute paths are never sent regardless of this flag. |
| `outbound.sendRepoIdentity` | boolean | `false` | Only a hash of the repo identity leaves the machine unless the user opts in. |
| `rawLogging.enabled` | boolean | `false` | Raw request/response bodies are not written anywhere by default. |
| `rawLogging.retentionDays` | integer 1–365 | `7` | Short retention once enabled; deletion is automatic. |
| `rawLogging.redactBeforeWrite` | `const true` | `true` | Deny patterns always run before a raw log write. *Fixed.* |
| `firstUseDisclosure` | boolean | `true` | Which data classes go to TypeSafe and to model providers is shown before the first outbound request. |

### 6.1 Shipped minimum `denyPaths` (`$defs/ShippedDenyPaths`)

| Group | Globs |
|---|---|
| Environment files | `**/.env`, `**/.env.*` |
| Key material | `**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/*.jks`, `**/*.keystore`, `**/id_rsa*`, `**/id_ed25519*`, `**/id_ecdsa*`, `**/.ssh/**`, `**/.gnupg/**` |
| Credential stores | `**/.aws/**`, `**/.azure/**`, `**/.config/gcloud/**`, `**/.kube/config`, `**/.netrc`, `**/.npmrc`, `**/.pypirc`, `**/.docker/config.json`, `**/.git/config`, `**/.git/credentials`, `**/.git-credentials`, `**/credentials.json`, `**/service-account*.json`, `**/secrets.*`, `**/*.secret` |
| Product state | `**/.korwf/**` |
| Dependencies and build output | `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/out/**`, `**/target/**`, `**/.next/**`, `**/coverage/**` |
| Logs and databases | `**/*.log`, `**/*.sqlite`, `**/*.sqlite3`, `**/*.db` |

Globs are matched against project-relative paths with `**` semantics (dotfiles included).

### 6.2 Shipped minimum `denyPatterns` (`$defs/ShippedDenyPatterns`)

PEM private-key headers; `key/secret/token/password = value` assignments; common API key
shapes (`sk-…`, AWS `AKIA…`, GitHub `gh?_…`, Slack `xox?-…`, Google `AIza…`); JWTs;
`Bearer` tokens; and `scheme://user:pass@` URLs. The exact regexes are in the schema and
are tested to compile with flags `iu`. Patterns redact the matching line, not the file.

## 7. `fallback`

PLAN §3.D caps and fallback. Applies when the selected model is capped
(`ModelAvailability.capKind` ∈ `quota_exhausted | rate_limited | budget_cap | unavailable`).

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `midTaskPolicy` | `{ default: MidTaskPolicy, [TaskKind]?: MidTaskPolicy }` | `{ default: "handoff" }` | `handoff` keeps the worktree intact and passes an explicit handoff packet; `restart` discards partial work. Hand-off is the PLAN default and never loses evidence. `default` is always present (the schema supplies it). |
| `dwell` | `remainder_of_task \| remainder_of_phase \| minutes` | `"remainder_of_task"` | Anti-oscillation minimum on the fallback model; PLAN default. |
| `dwellMinutes` | integer ≥ 0 | `30` | Used only when `dwell = "minutes"`. |
| `preferWaitIfResetWithinMinutes` | integer ≥ 0 | `0` | `0` = never wait; the workflow keeps moving on the next eligible model and the workflow budget bounds the extra cost. Users who prefer cheaper-but-slower set this. |
| `retryPrimaryAtTaskBoundary` | `const true` | `true` | Retry the primary at the next task boundary once the cap is estimated cleared; never re-probe every task. *Fixed.* |
| `staticOrder` | `ModelRef[]`, unique | `[]` | Used when Jev is unavailable or answers none/unknown. Empty = Pi registry order filtered by the allowlist, so a no-Jev configuration works without naming any model. Must be ⊆ the effective allowlist (V1). |
| `allCappedBehaviour` | `const "pause_phase"` | `"pause_phase"` | All candidates capped → pause the phase, surface state, resume when a cap clears. Not a failure. *Fixed.* |
| `overridePins` | `const false` | `false` | Pins are never overridden by fallback without asking. *Fixed.* |

## 8. `jev`

TypeSafe/Jev transport contract from `docs/adr/0003-jev-transport.md`. **With no key the
product runs in optional mode**: planning, tasks, worktrees, gates and static routing all
work; Jev-assisted decisions take their deterministic fallback and the user sees one clear
message.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `enabled` | boolean | `false` | Nothing is sent to TypeSafe unless the user turns it on **and** a key resolves. `true` without a key behaves as `false` with a warning. |
| `baseUrl` | string, `format: uri`, `^https://` | `"https://api.typesafe.ai"` | The public API origin (the only hostname in shipped defaults). HTTPS is required so a proxy override cannot downgrade transport. |
| `keySource.kind` | `env \| pi_secrets \| none` | `"env"` | Names a mechanism, never a value. |
| `keySource.name` | `^[A-Z][A-Z0-9_]*$` | `"TYPESAFE_API_KEY"` | Conventional variable name; the transport itself never reads `process.env` — only the secret resolver does. |
| `model` | `^jev-\d+\.\d+\.\d+$` | `"jev-1.13.0"` | Pinned version (ADR-0003 rule 1). `jev-latest` fails validation so calibrated thresholds cannot drift silently. |
| `timeoutMs` | integer ≥ 100 | `10000` | Per-decision deadline including retries; a stuck decision falls back rather than blocking the workflow. |
| `maxRetries` | integer 0–5 | `2` | ADR-0003 rule 5. |
| `pricePerMillionInputTokensUsd` | number ≥ 0 | `0.042` | Known-cost accounting (ADR-0003 rule 8). |
| `cache.enabled` | boolean | `true` | Cache keys are complete and versioned (PLAN §6), so caching is safe and saves spend. |
| `cache.ttlSeconds` | integer ≥ 0 | `86400` | One day; revision-sensitive evidence is never served from cache regardless. |

## 9. `notifications`

PLAN §2.6 notification hooks. Only the in-Pi channel is on by default; nothing leaves the
machine unless a channel is configured.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `events` | `NotificationEvent[]`, unique | `approval_queued, phase_stopped, budget_exhausted, all_models_capped, workflow_completed, workflow_failed` | Every event that needs the user is on; `model_fallback` is off because it is routine and already visible in status. |
| `channels.ui.enabled` | boolean | `true` | Pi's own `notify`/`setStatus`; no-op in print/RPC mode (`ctx.hasUI === false`). |
| `channels.desktop.enabled` | boolean | `false` | OS notifier availability varies by platform (`docs/platform-support.md`); opt-in. |
| `channels.command.enabled` / `argv` | boolean / `string[]` | `false` / `[]` | Runs a user executable with a JSON event on stdin. Off; when on it is treated as `run_shell` for approvals. |
| `channels.webhook.enabled` / `url` | boolean / `https://…` or `null` | `false` / `null` | HTTPS POST of the redacted event. Off, no URL. |
| `quietHours.enabled` / `start` / `end` | boolean / `HH:MM` | `false` / `22:00` / `07:00` | Off; when on, non-stop events are batched until `end`. `stop` events are never suppressed. |

## 10. `storage`

See `src/storage/paths.ts`. State lives under one namespaced directory; nothing is written
into the source tree outside it.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `path` | string or `null` | `null` | `null` = `<project>/.korwf`. Relative overrides resolve against the project root. No absolute default, so no machine path is shipped. |
| `allowOutsideProject` | boolean | `false` | An absolute `path` outside the project root is rejected (V8) unless the user says so explicitly. |
| `artifactRetentionDays` | integer ≥ 1 | `30` | Evidence artifacts are kept long enough to replay a workflow, then deleted. |
| `lockTimeoutMs` | integer ≥ 0 | `5000` | A second instance on the same project fails fast instead of corrupting SQLite. |

## 10a. `recovery`

PLAN §3.G bounded recovery. When a task fails, the response is drawn from a fixed menu —
`gather_evidence`, `retry`, `fallback_model`, `replan`, `change_worker`, `request_review`,
`ask_user`, `stop` — by `src/workflow/recovery.ts`, from the failure category that
`src/workflow/failure.ts` assigned. **Every count below is a ceiling**, and the ladder always
ends on a terminal response. The failure this section exists to prevent is an unbounded
retry loop.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `maxAttemptsPerTask` | integer 1–10 | `3` | Hard ceiling on attempts for one task, counting the first. On reaching it the only responses left are `ask_user`/`stop`; nothing may raise it mid-task. |
| `maxAttemptsPerPhase` | integer 1–10 | `2` | Same bound for a phase gate, which recovers by re-running tasks and so must be tighter. |
| `maxEvidenceGatherings` | integer 0–3 | `1` | Gathering evidence indefinitely is a stall wearing a recovery costume; after this many, the response advances. |
| `maxReplans` | integer 0–3 | `1` | A second replan on the same task means the plan is not the problem. |
| `maxModelFallbacks` | integer 0–3 | `1` | Which route to fall back to is `fallback` (§7); how many times recovery may reach for one is here. |
| `maxWorkerChanges` | integer 0–3 | `1` | Changing worker/profile twice on one task is churn, not recovery. |
| `requireReconciliationBeforeRetry` | `const true` | `true` | A step that may have had side effects is never retried until its outcome is reconciled (PLAN §3.G). *Fixed* — a switch here would be a supported way to cause a double effect. |
| `unreconcilableSideEffect` | `ask_user \| stop` | `"ask_user"` | When a side-effecting step has no reconciliation probe, or the probe itself failed, the outcome is unknown. Both options are terminal; `retry` is not an option at all. |
| `finalResponse` | `ask_user \| stop` | `"ask_user"` | What the exhausted ladder returns. Unattended runs that must not queue a question set `stop`. |

## 10b. `verification`

Condition 2 of the task gate (PLAN §2.4 (2), §3.F; issue #47): the completion-claim,
evidence-gap and test-exercises-requirement evaluators in
`src/verification/evaluate.ts`, backed by the versioned questions in
`src/decisions/questions/verify.ts`.

Three properties hold whatever is configured here, and none of them is a key:

- **Nothing here waives a deterministic check.** Conditions 1 and 3 of the gate are
  computed from `Evidence`, `Approval` and `CheckDefinition` rows and read no `Decision`
  at all, so no value in this section can reach them.
- **An override may only tighten a threshold.** A config that tries to lower a floor is
  ignored on that field; the shipped default stands. A bad value can never open the gate.
- **With Jev disabled the mapping rule still applies.** Every acceptance criterion needs
  at least one *linked passing check* and at least one *passing evidence item* attributed
  to it. The semantic dimensions then report `not_evaluated` — visible, never a silent pass.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `thresholds.<low\|medium\|high>.claimConfidence` | number 0–1 | `0.6` / `0.7` / `0.8` | Minimum confidence for a `supported` completion-claim answer. Below it the answer is an abstention, and an abstention is a gap. Higher risk demands more confidence. |
| `thresholds.<class>.gapCeiling` | number 0–1 | `0.35` / `0.25` / `0.15` | Highest probability-of-gap that still counts as "no gap". Expressed as a ceiling on the *gap* side on purpose: a noul near the middle is not evidence of absence. |
| `thresholds.<class>.testExercisesMinLevel` | integer 0–3 | `2` / `2` / `3` | Lowest `verify.test_exercises@1` level that credits a test as exercising its criterion. Level 0 is "would still pass if the criterion were unimplemented". |
| `thresholds.<class>.requireExercisingTest` | boolean | `false` / `true` / `true` | Whether a criterion whose linked tests are all below the level floor is a gap on its own. Off for `low` so a task with no tests at all is judged by the mapping rule rather than blocked twice. |
| `maxExcerptBytes` | integer 200–20000 | `2000` | Largest test-file or evidence excerpt put into a question state. The evaluator's own ceiling, so the full diff is never the input; `privacy.outbound` caps again afterwards. |

### 10b.1 `verification.review` — independent review contexts

Condition 3 of the task gate (PLAN §2.4 (3), §3.F; issue #48): which changes require an
independent coding-model review, run in a fresh context that never sees the worker's claim
of success. Three properties hold whatever is configured here:

- **Configuration can only tighten.** Configured `rules` are *added* to the shipped rules in
  `src/verification/review.ts`; a rule that reuses a shipped id is ignored in favour of the
  shipped one. There is deliberately no key that makes a review optional, and a high-risk
  task is reviewed whatever this section says.
- **A review is evidence, never authority.** It feeds condition 3 and can only *withhold*
  completion; nothing here can set `done`, and a review is recorded as `model` evidence so it
  can never stand in for a deterministic check under condition 1.
- **An unresolved blocking finding refuses the gate**, and is cleared only by a recheck at a
  strictly newer revision — not by a claimed fix, and not by a Jev severity downgrade.

| Key | Type | Default | Why the default is safe |
|---|---|---|---|
| `review.reviewEverything` | boolean | `false` | Require a review for every change. Turning it on only tightens; turning it off removes no rule. |
| `review.rules[].id` | string 1–64 | — | Stable rule id, reported as the reason review was required. A shipped id cannot be redefined. |
| `review.rules[].changeClasses` | string[] | `[]` | Change classes (from `src/git/`) the rule fires for. Empty means any class, i.e. broader. |
| `review.rules[].paths` | string[] | `[]` | Repository-relative path prefixes. Empty means any path, i.e. broader. |
| `review.rules[].minRiskClass` | `low\|medium\|high` | `"low"` | Lowest risk class the rule fires at. `low` is the broadest setting. |
| `review.preferDifferentModelFamily` | boolean | `true` | Prefer a reviewer from a different family than the author's. A same-family review is still recorded, with a caveat on its evidence row, so a single-family configuration can still review at all. |

## 11. Validation rules beyond types

The schema enforces types, enums, ranges, `const` pins, the deny-list floor, and unknown-key
rejection. The validator (issue #21) additionally enforces the rules below. Each has a stable
id so error messages and tests can reference it. Any violation is a **load error**: the
product refuses to start a workflow with an invalid config; it never falls back to a
weaker interpretation.

| Id | Rule | Why |
|---|---|---|
| V1 | `fallback.staticOrder` ⊆ effective allowlist (providers ∩ models, minus `overrides[*].disabled`). Every entry must also be a model Pi has configured; unknown refs are an error, not ignored. | Static order is the no-Jev path; it must not route outside the allowlist. |
| V2 | All `Budget` numbers ≥ 0 (schema `minimum: 0`); `null` means no cap. | Negative caps are meaningless; `0` is a valid "nothing allowed" cap. |
| V3 | Where both sides are non-null: `budgets.task.x ≤ budgets.phase.x ≤ budgets.workflow.x` for each cap kind `x`. | A child cap larger than its parent is unreachable and hides a mistake. |
| V4 | `approvals.classes[c][m] ≠ "auto"` for any mutation class `c` (`MUTATION_CLASSES` in `src/workflow/approval-classes.ts`: every class except `read_repository`, `model_fallback`, `model_substitute_more_expensive`, `spend_over_estimate`) when `m ∈ {shadow, advisory}`. | Those modes are defined as non-mutating. |
| V5 | `privacy.denyPaths` ⊇ shipped minimum and `privacy.denyPatterns` ⊇ shipped minimum. Enforced in-schema (`allOf` of `contains`/`const`) **and** re-checked by the validator after layered merge, so a higher-precedence file cannot drop entries by replacing the array. | The deny list can be extended, never reduced. |
| V6 | Every `privacy.denyPatterns` entry compiles as an ECMAScript regex with flags `iu`. | A broken pattern must fail loudly, not silently match nothing. |
| V7 | Each `privacy.allowPaths` entry must be a literal file path or a glob strictly narrower than a deny entry it intersects; `**`, bare directories and anything matching `**/.env` / key-material globs are rejected. `allowPaths` never applies to logging. | Carve-outs are for specific fixtures, not for re-opening a class. |
| V8 | `storage.path`, if absolute and outside the project root, requires `allowOutsideProject: true`. | Keeps state next to the project unless explicitly moved. |
| V9 | `models.allowlist.pins[*]` values and `models.overrides` keys must be in the effective allowlist. `jev.enabled: true` with an unresolvable key **downgrades to optional mode with a warning**, not an error. | Pins outside the allowlist would contradict it; a missing key must never prevent the deterministic workflow from running. |
| V10 | `approvals.classes[c][m] = "stop"` for every high-risk class `c` and mode `m`; re-checked after layered merge by `validateApprovalClasses`. | PLAN §7: high-risk classes cannot be set to `auto`. |
| V11 | `approvals.classes[c][m] ≠ "auto"` for `c ∈ {scope_change, replan}`. | PLAN §3.C: no silent scope expansion or replan. |
| V12 | Every class present in `approvals.classes` has a decision for all four modes. | A partial row must not silently take an unseen default. |

## 12. Worked examples

**Empty config** — `{}` validates. Resolved highlights: `mode: shadow`, `jev.enabled: false`,
`models.allowlist.{providers,models}: []` (everything Pi has configured),
`fallback.staticOrder: []` (registry order), 40 deny globs, 10 deny patterns,
`storage.path: null`.

**Restrict to one provider and run supervised** (provider name is illustrative):

```json
{
  "mode": "supervised",
  "models": { "allowlist": { "providers": ["my-provider"] } },
  "fallback": { "staticOrder": ["my-provider/model-a", "my-provider/model-b"] }
}
```

**Enable Jev from a Pi secret and add a deny glob**:

```json
{
  "jev": { "enabled": true, "keySource": { "kind": "pi_secrets", "name": "TYPESAFE_API_KEY" } },
  "privacy": { "denyPaths": ["<…the shipped minimum…>", "docs/private/**"] }
}
```

`denyPaths` must list the shipped minimum plus additions; the loader exposes the current
minimum as `SHIPPED_DENY_PATHS` / `SHIPPED_DENY_PATTERNS` (`src/config/defaults.ts`) so
users can paste it rather than retype it.

**Rejected configs** (verified against the schema with ajv 2020 strict):
`{"privacy":{"denyPaths":["**/.env"]}}` (floor), `{"privacy":{"denyPatterns":[]}}` (floor),
`{"budgets":{"workflow":{"maxSpendUsd":-1}}}` (V2),
`{"approvals":{"classes":{"remote_push":{…,"bounded_autonomous":"auto"}}}}` (high-risk const),
`{"jev":{"baseUrl":"http://…"}}` (https only), `{"jev":{"model":"jev-latest"}}` (pin),
`{"nope":1}` (unknown key).

## 13. Loading, layered merge, and environment overrides

Implemented in `src/config/` (issue #21): `defaults.ts` (shipped defaults materialised
from the schema), `schema-check.ts` (dependency-free draft 2020-12 checker for the subset
the schema uses), `validate.ts` (rules V1–V12) and `load.ts` (`loadConfig`).

### 13.1 Files and precedence

| Layer | Source | Precedence |
|---|---|---|
| shipped defaults | `src/config/schema.json` (`properties[*].default`, recursively) | lowest |
| user | `<pi config dir>/korwf/config.json`, where the Pi config dir is `$PI_CODING_AGENT_DIR` or `~/.pi/agent` | ↑ |
| project | `<project>/.korwf/config.json` | ↑ |
| environment | the documented variables in §13.3 only | highest |

Objects merge key by key; **arrays and scalars are replaced wholesale** by the higher
layer. Because a higher layer can replace an array, the privacy floors are re-checked
*after* the merge (V5), so no layer can drop a shipped deny entry by replacing the list.
A missing file is not an error — a project with no config runs entirely on the defaults.
A `$schema` key in a config file is ignored (editor tooling only), not treated as unknown.

### 13.2 Result shape

`loadConfig(projectDir, options)` never throws on user input. It returns either

- `{ ok: true, config, layers, warnings }` — `config` is fully defaulted, validated and
  **deep-frozen** (`Object.freeze` recursively, so no later code can mutate policy); or
- `{ ok: false, errors, warnings, layers, message }` — every error carries `rule`
  (`schema`, or `V1`…`V12`), `path` (e.g. `budgets.task.maxSpendUsd`, or the config file
  path for parse failures) and a reason. An invalid config is a refusal, never a fallback
  to a weaker interpretation.

Unreadable files, truncated JSON, a top-level array and an empty file are all reported
as path-qualified errors rather than exceptions, so a bad config cannot crash Pi.

### 13.3 Environment overrides

Only these variables are read. None of them can weaken policy: they select a mode
(schema-validated), toggle a feature off, or name a key *source* — never a key value.

| Variable | Sets | Notes |
|---|---|---|
| `KORWF_MODE` | `mode` | Validated against the mode enum like any other value. |
| `KORWF_JEV_ENABLED` | `jev.enabled` | `1/true/yes/on` and `0/false/no/off`. |
| `KORWF_JEV_BASE_URL` | `jev.baseUrl` | Still `https://`-only. |
| `KORWF_JEV_KEY_ENV` | `jev.keySource.name` | The *name* of the variable holding the key. |
| `KORWF_STORAGE_PATH` | `storage.path` | Still subject to V8. |

### 13.4 V9 downgrade

If the merged config has `jev.enabled: true` but `keySource.kind` is `none`, or the named
environment variable is absent, the loader **downgrades `jev.enabled` to `false`** in the
resolved config and records a `V9` warning. Loading still succeeds: a missing key must
never prevent the deterministic workflow from running (PLAN §3.J). Only the *presence* of
the named variable is inspected; its value is never read into config, logs or payloads.

## 14. First-use disclosure

`src/extension/disclosure.ts`. Before any outbound request — TypeSafe (edge 1), a model
provider (edge 2) or a notification channel (edge 3) — the project must have accepted the
data disclosure.

- `buildDisclosure(config)` composes the text from the **effective** config, so the user
  is told what their configuration actually does. It names the three edges, what each
  carries, and the never-leaves list from `docs/threat-model.md` §4.1.
- `DISCLOSURE_VERSION` versions the text. Acceptance stores
  `{ disclosureAcceptedAt, disclosureVersion, packageVersion }` in the project's storage
  root (`<project>/.korwf/disclosure.json` by default). The disclosure is shown **once per
  project per version**: bumping `DISCLOSURE_VERSION` re-shows it everywhere.
- `assertOutboundAllowed` / `guardOutbound` are the gate. `guardOutbound` wraps a
  transport so the wrapped function is never invoked while the disclosure is pending;
  the gate throws `DisclosureRequiredError` rather than returning a value a caller could
  ignore. A corrupt or unreadable record counts as "not accepted" — the safe direction.
- Declining, and running with no UI (print/RPC mode), both leave the gate shut. Nothing
  is auto-accepted on the user's behalf; the deterministic workflow continues with no
  outbound calls.
- `privacy.firstUseDisclosure: false` is the user explicitly opting out of the *prompt*
  (threat model §4.2, "shown, or explicitly disabled"). It changes no filter.

`/korwf config` prints the effective config, its layers and any warnings;
`/korwf disclosure` prints the disclosure text and this project's acceptance state;
`/korwf jev` prints credential resolution (§15).

## 15. Credential resolution and redaction

`src/security/secrets.ts` and `src/security/redact.ts` (issue #22). This section is the
mechanical counterpart of the rule at the top of this document: **`jev.keySource` names
where a key lives, never the key.**

### 15.1 `resolveJevKey(config, options)`

Resolution is **lazy** (nothing is read until it is called), **total** (it never throws
and never logs) and **never returns a string**. The result is:

| Field | Meaning |
|---|---|
| `status` | `resolved` · `jev_disabled` · `no_key_source` · `key_absent` · `secrets_unavailable` |
| `secret` | a `Secret`, or `null`. Never a string. |
| `jevEnabled` | true only when a key resolved **and** `jev.enabled` is true |
| `source` | the configured `jev.keySource` (names only) |
| `message` | one clear sentence for the user; contains no value |

Lookup order for `keySource.kind`:

- **`env`** — the variable named by `keySource.name` (default `TYPESAFE_API_KEY`), then
  the documented development fallback `JEV_API_KEY`. The configured name always wins; the
  fallback can be switched off with `allowFallbackNames: false`. A blank or whitespace-only
  value counts as absent.
- **`pi_secrets`** — Pi's secrets facility, supplied by the extension as a narrow
  `SecretsPort` (`src/security/` never imports the Pi API; ADR 0002). No port ⇒
  `secrets_unavailable`. A facility that throws is treated as "no key", because the thrown
  object may quote the value it failed on.
- **`none`** — nothing is looked for.

`jev.enabled: false` short-circuits before any lookup: a user who turned Jev off does not
have their environment read. `applyKeyResolution(config, resolution)` returns the config
with `jev.enabled` forced to `false` when no key resolved — the same tightening the loader
applies as the §13.4 V9 downgrade, and it can only ever turn Jev *off*.

**A missing key is a state, not an error.** There is no failure variant and nothing throws;
the deterministic workflow runs in full and each Jev-assisted decision takes its documented
fallback (PLAN §3.J, ADR 0007). `/korwf jev` prints the resolution: source kind and name,
where it resolved from, key length and a non-reversible fingerprint — never the key.

### 15.2 The `Secret` wrapper

`toString`, `toJSON`, `valueOf`, `Symbol.toPrimitive` and Node's inspect hook all return
`[redacted]`, so template literals, string concatenation, `JSON.stringify`, `console.log`
and `util.inspect` are all safe. The instance is frozen and the value lives in a private
field reachable only through `expose()` or `withValue(fn)`; `authorizationHeader(secret)`
is the one place it becomes a plain string, immediately inside the object handed to
`fetch`. `fingerprint()` gives a stable, non-reversible id for traces and cache keys.

### 15.3 The global redactor

Two layers, because either alone is insufficient:

1. **Registered values.** Constructing a `Secret` registers its literal value. That exact
   string — and its percent-encoded, JSON-escaped and base64 forms — is replaced wherever
   it appears. The registry is module-private: `redactedValues()` reports a count only.
2. **Shape patterns.** Credential-shaped text is redacted whether or not this process
   resolved it: `apikey_…`, `sk-…`, `gh[pousr]_…`, `AKIA…`, `xox?-…`, `AIza…`, JWTs, PEM
   headers, `Bearer`/`Authorization`/`x-api-key` headers, `key|secret|token|password = …`
   assignments, and `scheme://user:pass@` URLs. The set is a strict superset of
   `scripts/check-secrets.sh` and of the shipped `privacy.denyPatterns` minimum, asserted
   by `test/unit/security/scanner-parity.test.ts`.

Entry points: `redactString`, `redactValue` (structure-aware — sensitive keys are dropped
whole, cycles and depth are bounded, a getter that throws yields `[unreadable]`),
`redactedStringify` (use instead of `JSON.stringify` for anything written to disk or sent
to a trace), `redactError` (in place, so the class and `instanceof` survive) and
`formatError`. Every logger comes from `createLogger`, whose sink is wrapped
unconditionally, so there is no code path that writes an unredacted string.

In the extension, `redactedUi(ctx.ui)` and `guardHandler` are the boundary: every `/korwf`
message is redacted, and anything thrown inside a handler is redacted, reported as one
line, and swallowed rather than taking the Pi session down.

Nothing in the redactor throws. A redactor that failed would push callers back towards
logging the raw value.
