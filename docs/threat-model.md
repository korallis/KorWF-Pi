# KorWF-Pi threat model

- **Status:** Accepted (Stage 1, issue #17). Revise in the same PR as any change to
  `src/security/`, `src/workers/`, `src/git/`, `src/jev/`, or the privacy defaults in
  `src/config/schema.json`.
- **Date:** 2026-09-21
- **Design authority:** PLAN §1 (responsibility boundaries), §3.E (worktrees are not
  security isolation), §7 (provider, privacy, security), §4 (tool-call hooks are policy
  gates, not sandboxing).
- **Inputs:** ADR 0001–0005; ADR 0006–0010 (this issue); `docs/config-reference.md` §6
  (privacy) and §8 (jev); `src/config/schema.json`; `docs/gates.md`; `docs/records.md`;
  `docs/pi-integration-map.md`.

This is the document an agent consults when an issue's security implications are
unclear. It names what is trusted, what is not, and why; every boundary in PLAN §7 has a
row in §5 with its mitigation and its residual risk. Nothing here is enforcement — the
enforcement lives in the modules named in each row, and a boundary without a named
module is a gap to fix, not a feature to describe.

## Contents

1. [Scope and method](#1-scope-and-method)
2. [Assets](#2-assets)
3. [Actors](#3-actors)
4. [Data-flow diagram](#4-data-flow-diagram)
5. [Trust boundaries and mitigations](#5-trust-boundaries-and-mitigations)
6. [Residual risks](#6-residual-risks)
7. [What this model does not cover](#7-what-this-model-does-not-cover)

## 1. Scope and method

**In scope:** the KorWF-Pi package running inside a user's Pi session on their machine,
the worker Pi subprocesses it spawns (ADR 0004), the SQLite store under
`<project>/.korwf/` (ADR 0006), the git worktrees it creates (ADR 0009), and the two
outbound channels it can open — TypeSafe (Jev, ADR 0003) and the model providers the
user has already configured in Pi.

**Out of scope:** Pi itself, the operating system, the user's model-provider accounts,
and the policy governing the agents that *build* this repository (AGENTS.md §4, ADR 0005
— PLAN §7's scope note draws that line).

**Method.** Assets (§2) × actors (§3) give the attack surface; the data-flow diagram (§4)
shows where each byte can go; §5 walks every trust boundary from PLAN §7 and names the
module that enforces its mitigation; §6 lists what remains after mitigation. A row in §5
is *complete* only when a Stage 2+ test name or spec predicate is cited; "code will
check" without a citation is a follow-up, and is listed as one.

Two rules from PLAN §1 shape everything below:

- **Jev is not a security boundary.** It sees only the text sent to it, returns a
  probability, and its confidence is not a guarantee. No Jev answer ever *widens* what
  the system may do; at most it narrows (flags, abstains, ranks lower).
- **Permissions come from user-approved rules and execution isolation, not semantic
  confidence** (PLAN §7). The approval classes (`docs/config-reference.md` §5), the
  allowlist (§2), the deny lists (§6) and the gate predicates (`docs/gates.md`) are the
  only sources of authority.

## 2. Assets

| Id | Asset | Why it matters | Where it lives |
|---|---|---|---|
| A1 | **User repository** — committed history, branches, remotes | The product exists to change it; an incorrect or malicious change is the primary harm | Working tree, `.git/`, worktrees under the store (ADR 0009) |
| A2 | **User's uncommitted work** — dirty tree, stash, untracked files | Cannot be recovered from a remote; PLAN §3.G "preserve uncommitted user work" | The user's checkout (never a worker's) |
| A3 | **Credentials** — provider keys in Pi's config/secrets, `TYPESAFE_API_KEY`, anything matching the shipped deny lists | Exfiltration is irreversible; PLAN §7 "never stored in the repo, transcripts, or logs" | Env vars, Pi secrets facility, files matched by `privacy.denyPaths` |
| A4 | **Budgets** — Jev spend, model spend, worker concurrency, wall-clock | Runaway spend is real money; PLAN §3.D/§3.E limits | `budgets.*` config; `Attempt.usage`; `Decision` rows |
| A5 | **Policy configuration** — allowlist, approval classes, deny lists, mode | Everything else's authority derives from it; PLAN §3.H "never weakens its own policy" | `src/config/` layered merge; schema `const` pins |
| A6 | **KorWF store** — records, evidence, decisions, audit log | Integrity of the gate (`docs/gates.md`) depends on evidence not being forged or edited | `<project>/.korwf/korwf.sqlite`, artifacts dir (ADR 0006) |
| A7 | **Source and instruction text** — project instructions, skills, role prompts, PLAN | Instruction sources are trusted; anything that can impersonate them can steer the model | `resources/`, `AGENTS.md`, `.pi/`, Pi's context files |
| A8 | **The user's Pi session** — its transcript, its extensions, its TUI | A worker crash or a runaway tool must not take it down or alter it (ADR 0004) | The orchestrator process |

## 3. Actors

| Id | Actor | Capability | Intent assumed |
|---|---|---|---|
| T1 | **Malicious repository content** — files, comments, test fixtures, git hooks, `package.json` scripts, `.pi/` project files in a cloned repo | Read by every role; executed if any check or install runs; can contain instructions that look like ours | Hostile. A repo the user opens may have been crafted to steer or exfiltrate. |
| T2 | **Prompt injection via tool output** — command stdout/stderr, fetched pages, dependency READMEs, error messages, Jev responses | Enters the model's context as if it were an observation; may contain "ignore previous instructions", fake approval text, fake evidence | Hostile. Indistinguishable from T1 in effect; differs in that it arrives at run time. |
| T3 | **Misbehaving worker** — a Pi subprocess whose model has been steered (by T1/T2), is confused, or is simply wrong | Full tool access of its role within its worktree; can claim completion, write fake evidence, spawn processes, try to spawn workers | Non-malicious but untrusted. Treated as adversarial for authorisation purposes (PLAN §3.F "independent review contexts"). |
| T4 | **Jev outage or compromise** — TypeSafe unreachable, rate-limited, returning malformed data, or a proxy in the path returning attacker-chosen answers | Can delay, deny, or *shape* every Jev-assisted decision | Outage: benign. Compromise: hostile — assume responses are attacker-controlled. |
| T5 | **Buggy policy** — a defect in KorWF's own `security/`, `workflow/approvals`, `config/` merge, or gate code; a config file that validates but is wrong | Can silently widen what is allowed | Non-malicious. The system must fail closed when the policy layer is absent or errors. |
| T6 | **Model provider** — the endpoints the user's Pi already talks to | Sees whatever context Pi sends; may log it | Trusted by the user already (PLAN §3.D: "whatever the user's Pi has configured"); KorWF adds no provider and must not widen what is sent. |
| T7 | **Second instance / concurrent process** — another Pi session, a stale orchestrator, an editor, `git` run by the user | Can write the store or the worktree concurrently | Benign. Guarded by ADR 0006 (single writer) and ADR 0009 (integration owner). |

Not modelled as actors: the user (owns everything), Pi (trusted runtime; extensions run
as the user — Pi `docs/security.md`), the OS.

## 4. Data-flow diagram

What leaves the machine, to whom, and what never does. Every edge that crosses the
machine boundary is labelled with the config key that governs it and its **shipped
default** (`src/config/schema.json`; prose in `docs/config-reference.md` §6, §8, §9).
The diagram is normative: an edge not drawn here is a defect.

```text
                       ┌─────────────────────── user's machine ───────────────────────┐
                       │                                                               │
  untrusted inputs     │   ┌──────────────┐    tool_call gate     ┌──────────────────┐ │
  ─────────────────    │   │ user's Pi    │◄──────────────────────│ security/        │ │
  repo files (T1) ────►│   │ session +    │   (block/allow, no    │ execution-policy │ │
  tool stdout (T2) ───►│   │ korwf ext.   │    prompting in RPC)  │ data-boundaries  │ │
                       │   └──┬─────┬─────┘                       └────────┬─────────┘ │
                       │      │     │ spawn (ADR 0004)                     │ pure fns  │
                       │      │     ▼                                      │           │
                       │      │  ┌──────────────┐  own worktree (ADR 0009) │           │
                       │      │  │ worker Pi    │◄─────────────────────────┘           │
                       │      │  │ --mode rpc   │  --no-extensions, role --tools       │
                       │      │  └──────┬───────┘                                      │
                       │      │         │ records, evidence, decisions                 │
                       │      ▼         ▼                                              │
                       │   ┌──────────────────────────────┐   ┌─────────────────────┐  │
                       │   │ <project>/.korwf/ (ADR 0006) │   │ git worktrees       │  │
                       │   │ korwf.sqlite · artifacts ·   │   │ (change isolation   │  │
                       │   │ lockfile · NO raw payloads   │   │  only, ADR 0009)    │  │
                       │   │ unless privacy.rawLogging.   │   └─────────────────────┘  │
                       │   │ enabled=true (default false) │                            │
                       │   └──────────────────────────────┘                            │
                       │                                                               │
                       │   outbound filter (security/data-boundaries), applied to      │
                       │   EVERY edge below, in this order:                            │
                       │     1. privacy.denyPaths  → file never read into context     │
                       │     2. privacy.denyPatterns → matching line redacted         │
                       │     3. absolute paths stripped (always); project-relative     │
                       │        paths only if privacy.outbound.sendFilePaths (true)    │
                       │     4. repo identity → hash unless sendRepoIdentity (false)   │
                       │     5. size caps: maxSnippetBytes 4096 · maxSnippetsPerRequest│
                       │        16 · maxRequestBytes 262144                            │
                       │     6. privacy.firstUseDisclosure (true) shown before edge 1  │
                       └───────┬───────────────────────────┬───────────────────────────┘
                               │                           │
        edge 1 ────────────────┘                           └──────────────── edge 2
        TypeSafe /v1/systemone                              model providers
        jev.enabled=false (default: NOTHING SENT)           Pi's own configured endpoints
        jev.baseUrl https:// only (default api.typesafe.ai)  (allowlist: models.allowlist,
        key from jev.keySource (env|pi_secrets|none),        default = all of Pi's;
        never in body, never logged (ADR 0003 r.3, r.7)      KorWF adds none)
        body: question text + minimal state snippets         body: whatever Pi sends for
        (PLAN §6 "minimal relevant state")                   the worker's turn, after the
        never: secrets, deny-path content, absolute          same filter 1–5; never deny-
        paths, raw diffs beyond caps, the key                path content or secrets

        edge 3 (off by default): notifications.channels.webhook (enabled=false, url=null),
        .command (enabled=false), .desktop (enabled=false) — redacted event JSON only.
```

### 4.1 Never leaves the machine

| Data | Reason it stays | Enforced by |
|---|---|---|
| Files matching `privacy.denyPaths` (40 shipped globs: `.env*`, key material, credential stores, `node_modules`, build output — `config-reference.md` §6.1) | Never read into outbound context or logs; the list is a floor (schema `allOf/contains`, validator V5) | `security/data-boundaries`; schema; V5 |
| Lines matching `privacy.denyPatterns` (10 shipped: PEM headers, `key/secret/token/password =`, known API-key shapes) | Redacted before any outbound request or log write; `rawLogging.redactBeforeWrite` is `const true` | `security/data-boundaries`; schema `const`; V6 |
| The TypeSafe key and any provider key | Read only by the secret resolver; sent only as an `Authorization` header; never in a body, trace, cache key, or log | ADR 0003 rules 3, 4, 7; `jev/` |
| Absolute filesystem paths | Stripped regardless of `sendFilePaths` | `security/data-boundaries` |
| Repository identity (remote URL, path) | Only a hash unless `sendRepoIdentity: true` | `security/data-boundaries` |
| Raw request/response bodies | Not written anywhere unless `rawLogging.enabled` (default `false`); then redacted, then deleted after `retentionDays` (default 7) | `telemetry/`; schema |
| The KorWF store (`korwf.sqlite`, artifacts, audit log) | Local only; `storage.path` has no absolute default and `allowOutsideProject` is `false` | ADR 0006; V8 |
| Worktrees and the user's checkout | Git operations are local; `remote_push` is a fixed `stop` in every mode | `git/`; schema `HighRiskPolicy` |
| Decision traces, usage, cost | Local records (`Decision`, `Attempt.usage`); "sanitised responses" for replay are local files | `telemetry/`, `evaluation/` |

### 4.2 Leaves the machine only when

| Edge | Precondition (all must hold) | Default state |
|---|---|---|
| 1 · TypeSafe | `jev.enabled: true` **and** a key resolves via `jev.keySource` **and** `firstUseDisclosure` has been shown (or explicitly disabled) **and** the body passed filters 1–5 | **Closed** (`jev.enabled: false`) |
| 2 · Model provider | The model is in the effective allowlist (§2.1, V1) **and** the role's turn passed filters 1–5 **and** the approval class for the action was `auto` or approved | **Open only to what Pi already has configured**; KorWF never introduces a provider (the `mac-mini` author setup is a local uncommitted config, PLAN §11) |
| 3 · Notification channels | The channel is enabled in config; `command` is treated as `run_shell` for approvals; `webhook` must be `https://` | **Closed** (all three off) |

### 4.3 Consistency check against the schema

The table above was derived from `src/config/schema.json` `$defs` and `default` values at
the commit that introduced this document. Any change to `privacy.*`, `jev.enabled`,
`jev.baseUrl`, `notifications.channels.*`, or `storage.*` defaults **must** update §4 in
the same PR; the Stage 2 config tests (#21) should assert the defaults this section
quotes (`jev.enabled=false`, `rawLogging.enabled=false`, `sendRepoIdentity=false`,
`sendFilePaths=true`, `maxRequestBytes=262144`, all notification channels off,
`storage.allowOutsideProject=false`) so the diagram cannot silently drift.

## 5. Trust boundaries and mitigations

Each row is one boundary named or implied by PLAN §7 (plus §1, §3.E, §4 where they
sharpen it). Columns: which actors cross it, what the mitigation is, **which module or
spec enforces it**, and the residual risk id (§6). "Enforced by" names code that exists
or is assigned to a Stage 2+ issue; prose alone never closes a row.

### B1 — Untrusted repository/tool content vs instruction and policy sources

*PLAN §7: "Untrusted repository/tool content isolated from instruction and policy
sources."* Actors: T1, T2, T3.

| Aspect | Mitigation | Enforced by | Residual |
|---|---|---|---|
| Content read from the repo or returned by a tool can **never** become an instruction or a policy input | Instruction sources are a closed set: `resources/roles/*.md` and `resources/prompts/` (shipped, versioned, read-only at runtime — ADR 0002), the user's own Pi context files, and KorWF's `before_agent_start` injection. Policy inputs are config (A5) and records (A6). Repo content reaches the model only as *observations* inside tool results, and reaches Jev only as *state snippets* labelled as such in the question body (PLAN §6). Nothing parses instructions out of repo files. | `context/` (passage selection emits data, not prompts); `decisions/` (question templates separate `instruction` from `state`); `resources/` read-only | R1 (models can still be steered by observations — that is why B2–B4 exist) |
| Project-local Pi files (`.pi/extensions/`, `.pi/settings.json`, a project-level KorWF config) in a cloned repo | Loaded only when Pi reports `ctx.isProjectTrusted()`; KorWF applies a project config layer only under trust (ADR 0001 row 3 salvages the layered merge *with* the trust gate the `sandbox/` example lacks); even when trusted, project config can only **tighten** (deny lists are a floor, V5; high-risk classes are `const stop`) | `config/` merge (#21); schema `HighRiskPolicy`, `allOf/contains`; V5 | R2 (trust is a user decision; a trusted malicious repo can widen the *configurable* rows) |
| Git hooks, `package.json` scripts, test commands inside the repo | Running them is `run_checks` / `run_shell` / `install_dependencies`, each an approval class with its own per-mode default (`config-reference.md` §5.1): `run_shell` and `install_dependencies` are never `auto`; checks run inside a worker's worktree, never the user's checkout (ADR 0009) | `workflow/approvals`; `security/execution-policy`; schema V4 | R3 (a check that the user approved runs arbitrary repo code as the user — see B6) |
| Content claiming to be evidence, approval, or a gate result | The gate reads only `Evidence`/`Approval`/`Decision` **rows** with `reviewer.kind`/`actor` set by the engine, never text; trivial checks are rejected at `task-ready`; a `policy`/`engine` actor cannot satisfy C3 (`docs/gates.md` B5, B8) | `verification/` gate predicates; `docs/gates.md` §2, §3, §8 | — |

### B2 — Jev prompt-injection signals are not an authorisation mechanism

*PLAN §7: "Jev prompt-injection signals never authorise execution or data release."
PLAN §1: "Jev is not … a security boundary."* Actors: T2, T4, T5.

| Aspect | Mitigation | Enforced by | Residual |
|---|---|---|---|
| A Jev "this content looks safe / is not injection" answer | Such a signal may only **add** a flag, lower a rank, or trigger abstention. No code path maps a Jev answer to `allow`, to an `Approval` row, to a change in an approval class, or to the release of data past the outbound filter. The C1 and C3 gate terms contain no Jev variable at all (`docs/gates.md` §3: "Jev cannot waive them"). | `decisions/` composition policies (no `allow` action type); `verification/` C1/C3; `security/` pure functions take (call, role, mode, config) — no Jev input in the signature (ADR 0002) | — |
| A Jev "this is injection" answer | Treated as advisory: recorded on the `Decision`, surfaced in status/`/korwf why`, may route a task to review. It does not block a user-approved action either — blocking is also a policy decision, and policy comes from config. | `decisions/`, `telemetry/` | R4 (an attacker who controls Jev's answer — T4 — can cause spurious reviews or abstentions: denial of service, never escalation) |
| Jev compromised via a proxied `jev.baseUrl` | Only `https://` accepted; the model is pinned; responses are schema-validated; the worst a hostile answer can do is what the row above allows — narrow, never widen. Deterministic fallback (ADR 0007) means a Jev that lies "unavailable" only degrades to static routing. | schema (`^https://`, `^jev-\d+\.\d+\.\d+$`); ADR 0003 rule 9 validation; ADR 0007 | R4 |

### B3 — Permissions come from user-approved rules and execution isolation, not semantic confidence

*PLAN §7 execution policy, first bullet.* Actors: T3, T5.

| Aspect | Mitigation | Enforced by | Residual |
|---|---|---|---|
| Source of authority for any mutating or spending action | Exactly three: (1) the approval class table (`auto`/`queue`/`stop` per mode, `config-reference.md` §5.1), (2) an `Approval` row with `actor.kind = user` for high-risk tasks (`docs/gates.md` C3), (3) execution isolation (ADR 0004 process boundary + ADR 0009 worktree + role `--tools`). Model output, worker claims, Jev confidence and telemetry are never inputs to the allow decision. | `workflow/approvals`; `security/execution-policy` (pure: (call, role, mode, config) → decision); `docs/gates.md` | — |
| Policy cannot be weakened at runtime | High-risk classes are `const "stop"` in the schema; deny lists are floors; `retryPrimaryAtTaskBoundary`, `allCappedBehaviour`, `overridePins`, `redactBeforeWrite` are `const`; a layered merge is re-validated after merge so a higher-precedence file cannot drop a floor (V5). `/korwf off` disables assistance, never controls (PLAN §4 UI). No record has a waiver field (`docs/gates.md` §7 "No waiver field"). | `src/config/schema.json`; validator V4/V5/V7 (#21); `docs/gates.md` §7 | R5 (the *user* can loosen configurable rows; that is their right, and the first-use disclosure and `/korwf status` make it visible) |
| Non-UI contexts (workers in `--mode rpc`, `-p`) where a gate would otherwise prompt | Block by default (`ctx.hasUI === false` ⇒ `{ block: true }`); a worker's `extension_ui_request` is routed to the orchestrator's approval policy and **times out to denial** (ADR 0004 "Approvals") | `security/execution-policy`; `workers/`; `docs/pi-integration-map.md` §4 "Non-UI modes" | — |
| Approvals surviving fork/resume/rewind or plan changes | `Approval` rows are scoped to task + plan revision and expire; invalidated on revision change; fork/resume "never resurrects obsolete approvals" (PLAN §5); the only mutable field is `invalidation` (`docs/records.md` §4) | `docs/state-machine.md`; `docs/records.md`; `workflow/recovery` | — |
