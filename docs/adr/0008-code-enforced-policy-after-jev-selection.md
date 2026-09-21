# ADR 0008 — Jev ranks, code enforces: policy is applied after every Jev selection

- **Status:** Accepted (Stage 1, issue #17).
- **Date:** 2026-09-21
- **Design authority:** PLAN §3.D "Selection. Jev chooses from the eligible candidates
  for the task profile. **Code enforces allowlist, budget, and policy after selection.**";
  §1 responsibility table (workflow engine owns permissions, allowlists, budgets, cap
  detection); §7 "Permissions come from user-approved rules and execution isolation, not
  semantic confidence"; §3.H "never weakens its own permission, allowlist, or spending
  policy".
- **Related:** ADR 0007 (fallback when Jev is absent), `docs/config-reference.md` §2
  (allowlist), §3 (budgets), §5 (approvals), §7 (fallback), `docs/gates.md` §7 "No
  waiver field", `docs/threat-model.md` B2, B3, R4.

## Context

Jev's outputs are probabilities and rankings over candidates *we* give it. Two design
errors would turn it into a security boundary, which PLAN §1 forbids:

1. Letting Jev's candidate set be the authority — e.g. asking "which model?" over all
   models Pi knows and trusting the answer to be in the allowlist.
2. Letting a Jev answer *unlock* something — e.g. "confidence ≥ 0.9 that this bash
   command is safe ⇒ run without approval", or "no evidence gap ⇒ skip the failing
   check".

Both have appeared in comparable systems, and both are the pattern threat-model B2/B3
exist to exclude. The question is where in the pipeline enforcement sits so that no
future issue can accidentally reorder it.

## Decision

**Every Jev-assisted choice passes through a code-enforced policy stage *after* the
answer is received and *before* any effect.** Jev sees only pre-filtered candidates;
policy re-checks the answer anyway. The ordering is fixed:

```text
state ──► [1 hard filter (code)] ──► candidates ──► [2 Jev rank/choose] ──► answer
      ──► [3 validate answer ∈ candidates (code)] ──► [4 policy: allowlist, budget,
          pins, approval class, mode (code)] ──► [5 record Decision + policy rule]
      ──► effect (or block/queue/stop)
```

### Rules

1. **Stage 1 is authoritative for eligibility.** Allowlist (providers ∩ models −
   `overrides[*].disabled`, `docs/config-reference.md` V1), `ModelAvailability` caps,
   hard registry constraints (context window, modality), and budgets remaining are
   applied *before* Jev is asked. Jev never sees an ineligible candidate.
2. **Stage 3 rejects any answer outside the candidate set** (a hallucinated or
   proxied-in id) as `jev.malformed_response` → deterministic fallback (ADR 0007).
3. **Stage 4 re-applies policy even to a valid answer**, because state may have changed
   between stages 1 and 2 (a cap detected mid-flight, a budget consumed by a sibling
   worker, a pin added). Pins are never overridden by fallback without asking
   (`fallback.overridePins` is `const false`); a more expensive substitute is bounded by
   the workflow budget; "all capped" pauses the phase (`allCappedBehaviour` is
   `const "pause_phase"`).
4. **Jev answers can only narrow.** The composition policies in `decisions/` expose the
   action set `{ rank, flag, abstain, route_to_review, none_adequate }` and nothing else.
   There is no `allow`, `approve`, `skip_check`, or `release` action; a policy that needs
   one is a design error to raise on the issue, not implement.
5. **Thresholds are policy, not Jev.** Calibrated thresholds live in versioned policy
   (`Decision.policyRule`, `Workflow.policyVersion`); the same raw distribution can
   yield different actions under different policy versions, and the record keeps both
   (PLAN §6 "preserve raw distributions").
6. **The policy stage is a pure function** `(answer, candidates, config, records) →
   { action, rule }` in `models/` (selection) or `workflow/approvals` (actions), with no
   I/O and no Jev import, so it is testable offline and identical for the main session
   and workers (ADR 0002 "`security/` is consulted, never bypassed").
7. **Every application is recorded** on the `Decision` row (`policyRule`, `action`,
   `override`) and, for model selection, on the `Attempt` (`requestedModel`,
   `usedModel`, `fallbackReason`); `/korwf why` explains from recorded inputs and rules,
   never from a fabricated rationale (PLAN §3.I).

### Worked example — model selection with a cap

1. Allowlist yields `{p/a, p/b, q/c}`; `q/c` is `rate_limited` until 14:05 ⇒ candidates
   `{p/a, p/b}`. Budget remaining permits both.
2. Jev ranks `[p/b 0.71, p/a 0.29]`.
3. `p/b ∈ candidates` ✓.
4. Meanwhile a sibling attempt consumed budget so `p/b`'s estimated cost exceeds the
   task cap ⇒ policy chooses `p/a`, `fallbackReason = budget_cap`; or, if
   `preferWaitIfResetWithinMinutes` covers 14:05, `paused(cap)`.
5. `Decision{ raw:[…], policyRule:"budget-cap-v1", action:"select p/a" }`,
   `Attempt{ requestedModel:p/b, usedModel:p/a }`.

## Consequences

- `models/selection` and `workflow/approvals` each contain a five-stage pipeline with
  the shape above; Stage 2+ tests assert (a) Jev is never called with an ineligible
  candidate, (b) an out-of-set answer falls back, (c) a policy change between stages 1
  and 4 is honoured.
- Jev cost is bounded by stage 1: fewer candidates, smaller prompts (PLAN §6 "minimal
  relevant state").
- Threat-model R4 is bounded to ranking quality; a compromised Jev cannot route outside
  the allowlist, exceed a budget, override a pin, or satisfy a gate.
- Reviewers reject any PR in which a Jev answer reaches an effect without passing stage
  4, or in which a new action type is added to the composition policy set.
EOF
git add -A && git commit -qm "docs(adr): 0008 code-enforced policy after Jev selection (#17)" && echo ok