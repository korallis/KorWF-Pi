# ADR 0007 — Jev is optional at runtime: every Jev-assisted decision has a deterministic fallback

- **Status:** Accepted (Stage 1, issue #17).
- **Date:** 2026-09-21
- **Design authority:** PLAN §3.J "Runs without a Jev key: deterministic workflow (plan,
  tasks, worktrees, gates, static routing) fully functional; Jev features off with a
  clear message."; §6 last bullet; §3.D "Jev unavailable: use the static fallback
  ordering"; AGENTS.md §4 "The system must work with no Jev key."
- **Related:** ADR 0003 (transport is not constructed without a key), `docs/gates.md` §5
  (C2 `JEV_DISABLED_FALLBACK`), `docs/config-reference.md` §8 (`jev.enabled: false`,
  V9), `docs/threat-model.md` B2, B5, R4.

## Context

Jev is a paid, remote, rate-limited dependency the user may not have, may not want to
pay for, or may lose mid-workflow (threat-model T4). PLAN makes Jev the judge for
narrow semantic questions — task profile, model ranking, evidence gaps, coupling, memory
classification — but never the source of authority (PLAN §1). If any workflow step
*required* a Jev answer, then a missing key, an outage, or a compromised proxy would
either stop the product or force a bypass; both are unacceptable (AGENTS.md §4:
deterministic checks cannot be waived, and no "test-only" bypasses).

The question this ADR settles is therefore not *whether* Jev is optional (PLAN decides
that) but **what "optional" must mean for every consumer of a Jev answer**, so that
Stage 2+ issues implement one pattern rather than N ad-hoc ones.

## Decision

Every Jev-assisted decision is defined as a **pair**: a Jev question (versioned, PLAN
§6) and a **deterministic fallback** that is specified, tested, and recorded as such.
"Optional mode" is a first-class state of the `jev/` module, not an error path.

### Rules

1. **Optional mode is entered deterministically** when any of: `jev.enabled: false`
   (shipped default); `jev.enabled: true` but `keySource` does not resolve (V9: warning,
   not error); the circuit breaker is open after repeated `jev.unavailable` /
   `jev.overloaded` / `jev.quota_exhausted` (ADR 0003 rule 6). The user sees **one**
   clear message per session stating which features are off and why (PLAN §3.J), and
   `/korwf status` shows `jev: optional (<reason>)`.
2. **Every question in `decisions/` declares its fallback** in the same versioned
   definition: `{ question, schema, fallback: { action, rationale } }`. A question
   without a fallback fails the `decisions/` registry test at load time. Fallbacks are
   pure functions of the same state the question would have seen.
3. **The fallback is recorded, never skipped.** A `Decision` row is written with
   `action = deterministic_fallback`, `questionVersion`, `stateHash`, and the reason
   (`no_key | disabled | unavailable | timeout | malformed | error`), so `/korwf why`
   and replay (`evaluation/`) can distinguish "Jev said X" from "Jev was absent"
   (`docs/gates.md` §5 truth table — C2 requires exactly one recorded branch).
4. **Fallbacks are conservative.** They may only narrow: abstain, treat as "unknown",
   route to review, use the static order. Table of the Stage 1 question families and
   their fallbacks:

   | Question family (PLAN §6) | Deterministic fallback |
   |---|---|
   | Intake classification | Ask the user via questionnaire (ADR 0001 row 12); default `feature` |
   | Passage relevance / staleness / contradiction | Lexical + path-ownership ranking; staleness by revision distance; no contradiction signal (surface "unchecked") |
   | Task atomicity / coverage / readiness | Schema checks only (`docs/gates.md` `task-ready` preconditions); readiness = dependencies done ∧ checks registered |
   | Task profile | `TaskKind` from the task's declared kind; risk class from config default |
   | Model selection / fallback ranking | `fallback.staticOrder` (empty ⇒ Pi registry order ∩ allowlist), pins honoured |
   | Semantic coupling | Declared-ownership overlap only; **serial when uncertain** (PLAN §3.E) |
   | Completion-claim support / evidence gap / test-exercises-requirement | `JEV_DISABLED_FALLBACK` predicate (`docs/gates.md` §5): all registered checks `pass` ∧ evidence provenance intersects ownership; otherwise gap |
   | Review-finding severity | Every finding is `needs_changes` until a human or independent reviewer downgrades |
   | Memory classification | `temporary_observation` with `pinned: false`; required instructions remain deterministic pins (PLAN §3.H) |

5. **No Jev term in a required gate.** C1 and C3 (`docs/gates.md`) and every high-risk
   approval class contain no Jev variable; disabling Jev removes advisory signal only.
6. **Optional mode is tested as a first-class configuration.** Every Stage 2+ test
   suite that touches a Jev question runs twice: with the mocked transport and with
   `jev.enabled: false`. Mocked tests never make live requests (AGENTS.md §4).
7. **Re-enabling is safe.** When a key appears or the breaker closes, subsequent
   decisions use Jev; earlier `deterministic_fallback` rows are not re-evaluated
   retroactively (freshness rules in `docs/records.md`); cache keys include
   `jev.model` so answers from different versions never mix (PLAN §6).

## Consequences

- `src/jev/optional-mode.ts` owns the mode state and the single user message;
  `src/decisions/` owns the question+fallback registry and its load-time test.
- The product is demonstrably usable with `{}` config (`docs/config-reference.md`
  "Empty config"): shadow mode, no Jev, registry-order routing.
- Threat-model R4 is bounded: a hostile Jev can degrade to the fallback but not
  beyond it.
- Calibration (PLAN §6) needs Jev *on*; optional mode produces no calibration data —
  documented in the first-use disclosure.
- ADR 0003's "to be confirmed when #17 implements the adapter" note is superseded by
  this ADR's rules 1–3 and the Stage 2 adapter issue; ADR 0003 remains the transport
  decision.
EOF
git add -A && git commit -qm "docs(adr): 0007 Jev-optional design (#17)" && echo ok