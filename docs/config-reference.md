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

<!-- sections appended below -->
