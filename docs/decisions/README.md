# Decision log

Owner decisions that govern the build, recorded in the repository rather than in chat
(AGENTS.md §7: "Do not rely on chat history for requirements").

These are distinct from [ADRs](../adr/): an ADR records a *technical* decision made by
whoever is building; a decision here records a choice **only the repository owner can
make** — authorization, budgets, data-sharing, operating policy.

| # | Decision | Status | Date | Issue |
|---|---|---|---|---|
| [0001](0001-authorization.md) | Authorization to implement — all stages, no build limits | Granted | 2026-09-21 | [#1](https://github.com/korallis/KorWF-Pi/issues/1) |

## Adding one

1. The owner states the decision on its M0 issue.
2. An agent writes `NNNN-<slug>.md` quoting the statement **verbatim**, then records what
   it authorizes, what it deliberately does not change, and the consequences.
3. Add a row above, in the same PR.
4. Never infer an owner decision from silence, from chat, or from a related decision.
