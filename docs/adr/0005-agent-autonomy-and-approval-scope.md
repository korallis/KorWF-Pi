# ADR 0005 — Agent autonomy and the scope of human approval

- **Status:** Accepted
- **Date:** 2026-09-21
- **Issue:** none (owner-directed maintenance of agent governance)
- **Design authority:** PLAN §2.4, §7, §10 (non-negotiable constraints);
  `.pi/skills/jev-orchestration/SKILL.md` §1 (escalation policy)
- **Amends:** AGENTS.md §4, "High-risk actions" bullet

## Context

AGENTS.md §4 listed the high-risk actions that require explicit approval as
"destructive cleanup, deployment, credential access, publishing, **remote pushes**".

`remote pushes`, unqualified, swallows every ordinary `git push` — including pushing an
agent's own feature branch, which is exactly what AGENTS.md §3 tells agents to do so
another agent can resume their work. In practice an agent completed a skill-file rename,
committed it, and then stopped to ask the owner for permission to push documentation.

That is the failure the escalation policy already names. `jev-orchestration` §1 is
explicit: `needs-human` means **only the repo owner can resolve it** — spend,
credentials, publishing, irreversible acts, permissions, unsettled product decisions —
and it does *not* mean "the agent gave up". Two governing documents therefore
disagreed, and the stricter-sounding one produced worse behaviour: an agent idling on a
reversible, zero-risk action.

The owner's standing instruction is to work agentically and autonomously, using Jev for
judgment, and to involve the human only for what the human alone can do.

## Decision

Narrow the clause to the acts that are genuinely irreversible or genuinely owner-only,
and state the non-examples explicitly so the rule cannot be read the old way:

> **High-risk actions** require explicit approval regardless of mode: destructive
> cleanup, deployment, credential access, publishing or releasing (tags, registries,
> anything consumers receive), force-pushing or rewriting shared history, and changes to
> permission, allowlist or spending policy. Ordinary pushes of the agent's own work to
> this repository are **not** in this list.

Everything else in §4 is unchanged. In particular the absolute constraints stand:
deterministic checks cannot be waived, the system must work with no Jev key, the system
never weakens its own permission/allowlist/spending policy, and mocked tests never
authorise live requests.

## Jev decisions

Probes logged raw to `.orchestrate/probe-decisions.jsonl`
(`push-authority`, `push-route`, `s4-wording`):

| Question | Answer |
|---|---|
| `push_is_human_only` | **0.16** — pushing agent-tooling changes is not owner-only |
| `push_equals_publishing` | **0.14** — a push to the repo's own branch is not "publishing" |
| `s4_rule_overbroad` | **0.70** — the clause as written will keep causing stalls |
| `owner_instruction_is_authorisation` | **0.66** — the standing instruction is the approval |
| `pr_adds_real_review` | **0.15** — no issue, no criteria, self-merged: ceremony, not review |
| `weakens_policy` | **0.15** — narrowing the clause is *not* self-weakening |
| `replacement_preserves_gates` | **0.69** — nothing dangerous becomes ungated |
| `replacement_fixes_stall` | **0.74** — explicit enough to change behaviour |
| `force_push_still_gated` | **0.95** — history rewriting remains gated |
| `agent_may_edit_own_rules` | **0.68** — within remit, given the above |
| `traceability` | **`plus_adr` (conf 0.81)** — record it here, not only in a commit message |

The aggregate "what should happen now" question scored a weak 0.30; decomposing it per
`jev-orchestration` §2 produced the clean signals above. That is the documented artefact
— an existential over a whole scope decays as the scope is itemised — and the response
is to ask sharper questions, not to treat the low score as a verdict.

## Consequences

- Agents push their own branches and ordinary commits without asking. Stalling on a
  reversible action is an orchestrator problem (`orchestrator-stuck`), not a
  `needs-human` one.
- Force-push, history rewriting, releases, deployment, credential access and any change
  to permission/allowlist/spending policy still require the owner.
- This ADR is the precedent for the boundary: **reversible + no credential + no consumer
  impact + not a policy loosening ⇒ the agent acts.** When a case is genuinely unclear,
  ask Jev and log the probe rather than defaulting to escalation *or* to action.
- An agent may clarify a governing rule that demonstrably misfires, provided Jev confirms
  no real gate is removed, and provided the change is recorded in an ADR. It may never
  loosen a gate to make its own work pass.
