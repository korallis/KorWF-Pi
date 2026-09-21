# Decision 0001 — Authorization to implement

- **Status:** Granted
- **Date:** 2026-09-21
- **Decided by:** Lee (repository owner)
- **Issue:** [#1](https://github.com/korallis/KorWF-Pi/issues/1)
- **Design authority:** `PLAN.md` §0 "Status and authorization", §11

## Statement

Verbatim, from the owner in session:

> there are no limits. you have my authorisation to merge and continue

## What this authorizes

1. **Implementation of all stages**, M2 through M8 — not only the Stage 1–2 work that
   PLAN.md §0 originally scoped. PLAN.md §0 said only the project folder and planning
   documents were authorized; that restriction is lifted by this decision.
2. **Merging agent work to `main`** without per-PR owner approval, subject to the
   evidence gate and merge review continuing to pass.
3. **No spend, token, request or concurrency caps** on development runs. This resolves
   the substance of [#4](https://github.com/korallis/KorWF-Pi/issues/4) (live test
   budgets).
4. **Sandbox setup and additional dependencies** as the work requires. This resolves the
   substance of [#6](https://github.com/korallis/KorWF-Pi/issues/6).
5. **Live Jev and model requests during development**, through the `mac-mini` provider
   and the owner's TypeSafe key, using the approved secret mechanism (`~/Projects/.env`,
   never committed).

## What this does not change

This is an authorization for the **build**. It is not a change to what the **product**
enforces, and the two must not be conflated (PLAN.md §7 scope note; ADR 0005).

- **Deterministic checks remain non-waivable** (PLAN §2.4). "No limits" is a statement
  about budget and authority, not permission to merge failing work. A failing test still
  blocks a merge.
- **The shipped system still never weakens its own permission, allowlist or spending
  policy** (PLAN §3.H).
- **Nothing machine-specific enters shipped code** (PLAN §2.4, §11). `mac-mini` remains
  in the author's local config and must not appear in shipped defaults.
- **A diff that weakens a security control still escalates to the owner**
  (`.pi/skills/jev-orchestration/SKILL.md` §1.1a). Authorization to implement is not
  authorization to remove the rail that protects the product's future users — and that
  rail is the thing most worth keeping when everything else is unlimited.
- **The remaining M0 issues stay open** where they record decisions this statement does
  not settle: [#2](../../issues/2) (key mechanism detail),
  [#3](../../issues/3) (pilot repository and data-sharing restrictions),
  [#5](../../issues/5) (default operating mode and approval classes for the pilot).
  Those concern what the product does on *someone's repository*, which unlimited build
  authority does not answer.

## Consequences

- The `m0_blocks_m2` gate (`scripts/orchestrate/milestone-order.mjs`, p=0.91) is cleared.
  M2 work may begin.
- `#4` and `#6` may be closed with a reference to this decision.
- Orchestration continues autonomously: pick, select model, dispatch real agents, verify,
  merge — escalating only what the owner alone can resolve.
