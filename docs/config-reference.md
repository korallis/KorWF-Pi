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
11. [Validation rules beyond types](#11-validation-rules-beyond-types)
12. [Worked examples](#12-worked-examples)

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
and does not carry over its history** — see `docs/adr/0006-route-identity.md`.

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

Columns are modes: shadow / advisory / supervised / bounded_autonomous.

| Class | shadow | advisory | supervised | bounded_autonomous | Why |
|---|---|---|---|---|---|
| `read_repository` | auto | auto | auto | auto | Reading is what every mode needs; deny paths (§6) still apply. |
| `edit_worktree` | stop | stop | queue | auto | Mutation is impossible in shadow/advisory by definition; supervised asks; autonomous edits its own worktree only. |
| `run_checks` | stop | stop | auto | auto | Deterministic checks are the gate's evidence; they are read-mostly and bounded by budgets. |
| `run_shell` | stop | stop | queue | queue | Arbitrary shell is not pre-approved in any mode; the user opts in per project. |
| `install_dependencies` | stop | stop | queue | queue | Network + arbitrary code execution; queued even when autonomous. |
| `local_commit` | stop | stop | queue | auto | A local commit on a task branch is reversible and never leaves the machine. |
| `spawn_worker` | stop | stop | queue | auto | Workers spend budget; supervised asks, autonomous is bounded by `budgets.workflow.maxConcurrency`. |
| `model_fallback` | auto | auto | queue | auto | Switching within the allowlist is visible and recorded on the Attempt; supervised asks because it may change cost. |
| `complete_task` | stop | stop | queue | auto | In supervised mode the user confirms completion; in autonomous the task gate (C1–C5) is the guard. |
| `destructive_cleanup` | **stop** | **stop** | **stop** | **stop** | High-risk (PLAN §7). *Fixed.* |
| `remote_push` | **stop** | **stop** | **stop** | **stop** | High-risk. *Fixed.* |
| `deployment` | **stop** | **stop** | **stop** | **stop** | High-risk. *Fixed.* |
| `credential_access` | **stop** | **stop** | **stop** | **stop** | High-risk. *Fixed.* |
| `publishing` | **stop** | **stop** | **stop** | **stop** | High-risk. *Fixed.* |

High-risk rows use `$defs/HighRiskPolicy`, whose four properties are each `const: "stop"`.
A config that sets any of them to `auto` or `queue` fails schema validation — the system
never weakens its own permission policy (AGENTS.md §4). The configurable rows may be set
to any decision; validator rule V4 additionally forbids `auto` for mutation classes in
`shadow` and `advisory`, because those modes are defined as non-mutating.

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
| V4 | `approvals.classes[c][m] ≠ "auto"` for any mutation class `c` (`edit_worktree`, `run_shell`, `install_dependencies`, `local_commit`, `spawn_worker`, `complete_task`) when `m ∈ {shadow, advisory}`. | Those modes are defined as non-mutating. |
| V5 | `privacy.denyPaths` ⊇ shipped minimum and `privacy.denyPatterns` ⊇ shipped minimum. Enforced in-schema (`allOf` of `contains`/`const`) **and** re-checked by the validator after layered merge, so a higher-precedence file cannot drop entries by replacing the array. | The deny list can be extended, never reduced. |
| V6 | Every `privacy.denyPatterns` entry compiles as an ECMAScript regex with flags `iu`. | A broken pattern must fail loudly, not silently match nothing. |
| V7 | Each `privacy.allowPaths` entry must be a literal file path or a glob strictly narrower than a deny entry it intersects; `**`, bare directories and anything matching `**/.env` / key-material globs are rejected. `allowPaths` never applies to logging. | Carve-outs are for specific fixtures, not for re-opening a class. |
| V8 | `storage.path`, if absolute and outside the project root, requires `allowOutsideProject: true`. | Keeps state next to the project unless explicitly moved. |
| V9 | `models.allowlist.pins[*]` values and `models.overrides` keys must be in the effective allowlist. `jev.enabled: true` with an unresolvable key **downgrades to optional mode with a warning**, not an error. | Pins outside the allowlist would contradict it; a missing key must never prevent the deterministic workflow from running. |

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

`denyPaths` must list the shipped minimum plus additions; the loader (issue #21) will
expose the current minimum so users can paste it rather than retype it.

**Rejected configs** (verified against the schema with ajv 2020 strict):
`{"privacy":{"denyPaths":["**/.env"]}}` (floor), `{"privacy":{"denyPatterns":[]}}` (floor),
`{"budgets":{"workflow":{"maxSpendUsd":-1}}}` (V2),
`{"approvals":{"classes":{"remote_push":{…,"bounded_autonomous":"auto"}}}}` (high-risk const),
`{"jev":{"baseUrl":"http://…"}}` (https only), `{"jev":{"model":"jev-latest"}}` (pin),
`{"nope":1}` (unknown key).
