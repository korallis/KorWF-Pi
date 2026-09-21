# A Jev-Centred Agentic Software Factory — PRD (revision 2)

**Status:** revision of the original multi-subscription orchestration PRD, updated for the
mac-mini proxy and reconciled against [PLAN.md](../PLAN.md), which remains the design
authority for anything shipped.

**Revision date:** 2026-09-21 · **Supersedes:** PRD revision 1 (multi-account control plane)

---

## 0. What changed in this revision, and why

Revision 1 was written before all personal model subscriptions were routed through the
mac-mini proxy. It assumed the orchestrator would hold many provider credentials and
schedule across them. That assumption is now wrong in one specific way and still right in
another, and the distinction drives this whole document.

| Revision 1 assumed | Now | Consequence |
| --- | --- | --- |
| Orchestrator holds N provider credentials | One endpoint, one credential, N upstream models | `RouteSlot = Model × Account × Host × PiProfile` collapses to **`Model`** |
| Per-account quota tracking in the scheduler | Proxy hides accounts, **not their quotas** | Cap tracking **stays**, keyed on model id, not account |
| Per-account Pi profile isolation (`PI_CODING_AGENT_DIR`) | One provider, one profile | Profile isolation is **dropped** from the product |
| Mac mini control plane, Omarchy worker host, SSH runner | Both are the author's machines | **Never ships.** Dev-environment concern only |
| Jev as routing decision plane | Unchanged | **Confirmed and already built** |

Judgments recorded with Jev (raw probes in `.orchestrate/decisions.jsonl`):

- The PRD's multi-account/multi-host routing layer is genuinely absent from PLAN, not a
  rewording of existing model selection — **0.94**.
- The proxy does *not* make cap machinery unnecessary; a 429 on one upstream subscription
  is invisible as an account event, so per-model availability tracking is still required
  — **0.87** (and the inverse framing scored **0.22**).
- Shipped code must **not** contain SSH execution against named hosts — **0.07**.
- Account as a first-class shipped scheduling dimension — **0.33**, i.e. genuinely
  optional. Treated below as a deferred extension, not core scope.

## 1. The validated claim

> **Is KorWF-Pi already the agentic software factory this PRD describes?**

**Substantially yes, for the single-provider case** — which, with the proxy, is now the
real case. The control loop the PRD asks for is specified and being built:

```text
Jev → deterministic controller → scheduler → Herdr → Pi workers → external verification
```

maps onto PLAN as:

| PRD component | KorWF-Pi | State |
| --- | --- | --- |
| Jev decision plane | PLAN §6, `src/decisions/`, `src/jev/` | Specified; bootstrap version running |
| Deterministic controller | PLAN §2.4 gate, §3.F, `src/verification/` | Specified; gate formulas merged (#14) |
| Scheduler | PLAN §3.D/E, `src/models/`, `src/workflow/` | Specified, not yet built (M5/M6) |
| Herdr session layer | Bootstrap orchestrator; product uses Pi subprocesses | Partly — see §3.2 |
| Pi workers | PLAN §3.E, ADR 0004 (RPC subprocess) | Decided, not yet built (M5) |
| External verification | PLAN §2.4/§2.5, `src/verification/` | Specified; task/phase gates merged |
| Telemetry / evaluation | PLAN §3.I, §9, `src/telemetry/`, `src/evaluation/` | Specified (M7/M8) |

**The core rule is already the architecture, almost verbatim:**

> PRD: *"Jev recommends what should happen. Deterministic code decides whether it may
> happen. Pi performs the work. External evidence decides whether it succeeded."*
>
> PLAN §1: *"Jev is not a generative coding model, a security boundary, or a final
> correctness oracle."* §2.4: *"Jev cannot waive (1) or (3). A worker's assertion cannot
> set `done`."*

**What is genuinely new and must be added:** §3 below. **What must be rejected:** §4.

## 2. Inventory model, corrected for the proxy

A schedulable route is **one provider entry × one model id**, not a four-way product
(Account/Host/Profile remain rejected, §4). Through the proxy this collapses to one route
per model; for a downloaded user with two subscriptions to one vendor it is two (§3.4).

```text
Route = Provider entry × Model id      (v1, #125 — see §3.4; one route per model in the proxy case)
```

Entities the shipped product needs, all already in PLAN §5 or §3.D:

| Entity | Fields | Status |
| --- | --- | --- |
| Model card | id, provider, context window, maxTokens, modalities, reasoning, cost, aptitude hints | PLAN §3.D — 4-layer merge, built (#10) |
| `ModelAvailability` | route id (provider + model id), cap kind, detected at, estimated reset, last probe | PLAN §5 — record defined (#12), keyed per route (#125) |
| `ModelOutcome` | route id, model, task profile, result, cost, latency | PLAN §5 — feeds card refinement (M7 #88), attributed per route (#125) |
| Task profile | domain, modality needs, reasoning depth, context size, risk | PLAN §3.D — built |
| Policy | data classification, risk class, network/deployment permission | PLAN §7, config schema (#11, merged) |

**Dropped from revision 1:** Account, Host, Pi profile, provider-level circuit breaker
keyed on account, `PI_CODING_AGENT_DIR` isolation, monetary cap per subscription.

**Retained and confirmed:** discovering models through Pi rather than a hardcoded
catalogue (PLAN §3.D "Allowlist"); treating capacity as scarce; cap detection with
estimated reset and anti-oscillation dwell (PLAN §3.D "Caps and fallback").

**Quota pressure.** Revision 1 proposed `max(0, consumed_fraction − elapsed_fraction)²`.
This stays a **hypothesis, not a shipped formula**: through the proxy the orchestrator
cannot observe `consumed_fraction` per upstream subscription. What it *can* observe is a
429/quota error and a reset estimate, which is exactly what `ModelAvailability` records.
Do not implement the formula until something can measure its inputs.

## 3. What the PRD adds that PLAN does not yet cover

These are the real gaps. Each needs a new issue.

### 3.1 Route health and circuit breaking (**new**)

PLAN has cap detection per model but no **error-rate circuit breaker**. A model that is
not quota-capped but is failing — malformed output, timeouts, 5xx — will be selected
again by Jev, because Jev ranks on task fit, not recent health.

This is not hypothetical: it is the mechanism behind the `claude-fable-5-1` loop on
issue #14, where the same model was re-selected six times while failing identically.
The bootstrap orchestrator now has a crude fix (switch family after two failures);
the product needs the real thing.

**Requirement.** Track per-model rolling health (success rate, error classes, consecutive
failures). Open a breaker after a threshold; exclude from eligibility while open;
half-open probe after a cooldown. Health is a **hard filter applied after Jev ranks**,
never an input Jev is asked to weigh.

### 3.2 Worker visibility as a product concern (**new**)

PLAN treats workers as subprocesses (ADR 0004) and says nothing about the operator being
able to *see* them. Building this repo proved that matters: headless workers are invisible
in Herdr's Agents panel, and a healthy run is indistinguishable from a dead one. Six
attempts on #14 wrote nothing while appearing to run.

**Requirement.** Every running worker must be observable without reading logs: a named,
inspectable session surfaced in the host UI where one exists, with its task, model,
elapsed time and current activity. Already recorded in ADR 0004 §"Worker visibility" and
on issue #68; listed here because it is a PRD-level property, not an implementation note.

### 3.3 Output-budget awareness in task decomposition (**new**)

Neither PLAN nor revision 1 anticipates the dominant *harness* failure mode observed:
a turn hits the output-token ceiling (16384, shared with reasoning at high thinking) and
is cut off **before emitting its tool call**, so nothing reaches disk. This destroyed six
attempts on #14 and three on #11 — roughly 400k tokens — and presented as "worker
overclaims, criteria unmet", which is the opposite of the truth.

**Requirement.** (a) The planner must size tasks against the selected model's `maxTokens`,
not only its context window. (b) Worker contracts must instruct incremental writes and
per-file commits. (c) The controller must detect `stopReason: "length"` and classify it as
a **harness** failure that does not consume the task's attempt budget and does not feed
"you failed the criteria" back to the model. All three are implemented in the bootstrap
orchestrator and validated; they belong in the product.

### 3.4 Per-route identity — **core, not deferred** (corrected 2026-09-21)

**This section originally deferred multi-account support. That was wrong, and the error is
instructive: it generalised from the author's setup to everyone's.**

The author routes every subscription through one proxy, so each model appears exactly
once and account never matters. A **downloaded user** has no such proxy. Pi's
`models.json` provider keys are arbitrary user-chosen names, each with its own `baseUrl`
and `apiKey`, so two subscriptions to one vendor are configured as two providers:

```json
{ "providers": {
    "anthropic-work":     { "apiKey": "$WORK_KEY",     "models": [ { "id": "claude-sonnet-5" } ] },
    "anthropic-personal": { "apiKey": "$PERSONAL_KEY", "models": [ { "id": "claude-sonnet-5" } ] } } }
```

One model id, **two independently rate-limited quotas**. Jev, asked bounded questions:

- Keying caps on model id alone **mis-attributes a rate limit across those accounts** —
  **0.86**.
- `(provider id, model id)` is **not a stable identifier**, because provider keys are
  renameable — **0.22**.
- Whether history should survive a provider rename — **0.58**: a genuine trade-off, so
  #125 asks the implementer to choose deliberately and document the failure mode.

The failure is not merely a lost route. PLAN §3.D pauses the phase when it believes all
candidates are capped, so one account's 429 could stall a workflow that had a healthy
alternative sitting idle.

**Therefore:** an opaque `routeId` derived from provider + model is **v1 scope** (#125),
and cap detection (#62) and health/breakers (#123) are keyed on it. Model *cards* stay
per model — aptitude does not vary by account — while *availability, health and outcomes*
are per route.

Still rejected, unchanged: per-account Pi profile directories, credential fan-out,
monetary caps per subscription, and any requirement that users declare accounts. The
provider list already in their Pi config is the only source of truth.

**Method note.** The author's environment structurally cannot reproduce this bug, which
is exactly the class of defect PLAN §2.4 exists to prevent. When assessing a feature,
ask what it does for a user whose configuration does not resemble the author's — and
write the test, because local confirmation is impossible.

### 3.5 Evaluation harness for routing (**partially covered**)

PLAN §9 compares three configurations (normal Pi / KorWF no-Jev / KorWF with Jev) and M8
issues #95–#100 cover baselines, ablations and calibration. The PRD adds two metrics worth
adopting explicitly: **Jev route-family accuracy** and **routing regret** against the best
retrospective choice. Add to #100 rather than creating a new issue.

## 4. Explicitly rejected — and why

| Revision 1 proposal | Verdict |
| --- | --- |
| SSH runner, mac-mini control plane, Omarchy build host in shipped code | **Rejected** (Jev 0.07). PLAN §2.4/§10: nothing shipped may depend on the author's machines. These are dev-environment facts, and belong in PLAN §11 only. |
| `LocalHerdrRunner` / `SshHerdrRunner` abstraction in the product | **Rejected.** The product runs where Pi runs. Herdr is the author's harness, not a dependency for users. |
| Per-account Pi profile directories | **Rejected** for v1 — one provider, one profile. |
| `agent-fabric/` monorepo (`apps/orchestratord`, 8 packages) | **Rejected.** KorWF-Pi is a Pi package (PLAN §3.J, ADR 0002), not a standalone daemon. A separate control-plane service is a second product. |
| Kubernetes, message broker, vector DB, universal inference proxy | **Rejected** — already PRD non-goals, and unchanged. |
| Controller availability SLO of 99.9% | **Not applicable.** There is no always-on service to be available; the package runs inside a Pi session. |
| Jev decision latency p50 < 200 ms / p95 < 800 ms | **Retained as an observation target**, not an SLO. Measured p50 here is ~250–1200 ms for batched question sets; a target must be calibrated per question family, not asserted. |

## 5. Corrected target architecture

```text
                    Pi session (the user's)
                              │
                  /korwf plan · run · status
                              │
                    Workflow coordinator
        ┌────────────┬────────┴────────┬──────────────┐
   policy engine  phase/task store  worker supervisor  model router
   (deterministic)   (SQLite)      (Pi subprocesses)   (Jev-ranked)
        │                                 │                  │
        │                          worktree isolation   model cards
        │                                 │              + health (§3.1)
        │                                 │              + availability
        └──────────── Jev adapter ────────┴──────────────────┘
                     (optional; every decision
                      has a deterministic fallback)
                              │
                 external verification: build, test,
                 lint, typecheck, independent review
```

Single machine. Single provider endpoint. No daemon, no SSH, no broker. The "software
factory" property comes from the **loop** — plan → route → execute → verify → learn — not
from distribution.

## 6. Delivery plan against existing milestones

No new milestones. The gaps in §3 map onto existing stages:

| Gap | Milestone | Issue | State |
| --- | --- | --- | --- |
| §3.1 route health / circuit breaker | M5 | **#123** | blocked by #125 |
| §3.2 worker visibility | M5 | #68 | amended |
| §3.3 output-budget awareness | M3 + M5 | **#124** | agent-ready |
| §3.4 per-route identity | M2 | **#125** | agent-ready — **core**, unblocks #123/#62 |
| §3.5 routing regret metrics | M8 | #100 | amended |
| §3.4 consequence: cap attribution | M5 | #62 | amended, blocked by #125 |

`#125` is the critical path: `#62` and `#123` both depend on route identity existing
before they can attribute caps and health correctly.

Current state: **11 issues closed, 100 open**; M0 (6 approval gates) and M1 (2 remaining)
are the near-term path. M1 has #15 and #17, both currently blocked by nothing that is
still open — see §7.

## 7. Immediate next actions

1. Open the three new issues in §6 with full context, per AGENTS.md §3.
2. Amend #68 (worker contracts) and #100 (routing metrics) with the criteria above.
3. Re-check `blocked` labels on #15 and #17: #11 merged, so #15's only blocker is closed,
   and #17's blockers (#8, #9, #11, #14, #16) are now all closed. Both are likely stale.
4. Leave M0 alone. Those six are `type:approval` — owner-only decisions that no agent may
   close (PLAN §11 "Decisions needed before implementation").

## 8. Open questions for the owner

- ~~**Multi-account (§3.4):** confirm deferral.~~ **Resolved 2026-09-21.** The owner has
  no second subscription behind the proxy, but downloaded users will. Deferral withdrawn;
  per-route identity is v1 scope (#125).
- ~~**Health thresholds (§3.1):**~~ **Resolved.** Owner accepted the proposed defaults:
  3 consecutive failures, or >50% over the last 10 calls, 15 min cooldown — explicitly a
  calibration starting point, recorded as such in #123, not asserted as correct.
- **Evaluation budget:** PLAN §9 and #101 need an approved spend before any live
  comparison run. Still outstanding (M0 #4).
