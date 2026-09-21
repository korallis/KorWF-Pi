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
