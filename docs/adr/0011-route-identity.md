# ADR 0011 — Route identity is derived from the provider key; a rename is a new route

Status: accepted (issue #125, 2026-09-21)
Design authority: docs/PRD.md §2, §3.4; PLAN §3.D "Caps and fallback", §5 "Records".

## Context

Pi's `models.json` provider keys are arbitrary user-chosen names, each with its own
`baseUrl` and `apiKey`. Two subscriptions to one vendor are two providers exposing the
same model id, backed by two independently rate-limited quotas. Keying caps on model id
mis-attributes a 429 from one account to the other (Jev 0.86) and can pause a phase that
had a healthy route idle. So availability, health and outcomes are keyed on an opaque
`routeId` derived from `(providerId, modelId)`; model cards stay per model id.

`(provider key, model id)` is not a *stable* identifier (Jev 0.22): the user can rename
a provider key at any time. Whether history should survive such a rename scored 0.58 — a
genuine trade-off the implementer must decide and document.

## Decision

**(a) A renamed provider key is a new route. Its availability row and outcome history are
not carried over.** `routeId = "r1_" + sha256(len(provider):provider|len(model):model)[:32]`,
pure and deterministic. There is no local alias table, no fingerprinting of `baseUrl` or
`apiKey`, and no user-declared account identity.

## Why

1. **The provider list in Pi's config is the only source of truth** (PRD §3.4, issue
   "Out of scope"). Option (b) needs some second source: a persisted mapping from an old
   key to a new one, or a fingerprint of the provider's credentials/endpoint. A mapping
   requires either a UI to declare the rename or a heuristic guess; a fingerprint requires
   reading and hashing `apiKey`/`baseUrl`, which `docs/model-registry-fields.md` marks as
   sensitive and which the product never logs, persists or surfaces.
2. **Wrong carry-over is worse than lost carry-over.** If a heuristic links the new key to
   the wrong old route, an unrelated account's cap or breaker state is applied to a healthy
   route — exactly the mis-attribution this issue removes. Losing a cap row costs at most
   one extra 429 before the new route is capped again; losing outcome history costs some
   layer-4 card refinement confidence, which decays anyway.
3. **Deterministic and Jev-free.** Route identity is recomputable from the registry alone,
   so it works with no key, no store, and across a fresh clone (AGENTS.md §4).
4. **Renames are rare and user-initiated.** The user who renames a key knows they did so;
   a silent identity carry is what would surprise them if it went wrong.

## Failure mode (documented deliberately)

- After renaming `anthropic-work` → `work-anthropic`, the old route's `ModelAvailability`
  row and `ModelOutcome` rows become orphans: they no longer match any registry route.
  `RouteAvailabilityTable.prune(knownRouteIds)` drops the availability row; outcome rows
  are append-only and stay on disk but are no longer selected for the new route.
- If the old route was **capped with an unknown reset** at the moment of the rename, the
  new route starts eligible and will be tried once before being re-capped. That is one
  wasted request, not a stall.
- If the old route had an **open breaker** (#123) the new route starts healthy. Same cost:
  a bounded number of failures before the breaker reopens.
- **Renaming two keys by swapping them** (`a`↔`b`) makes each route inherit nothing; it
  does *not* swap histories, which is the safe outcome.
- There is no way to recover the history for a renamed key short of renaming it back.
  This is accepted; if it turns out to matter, a future ADR can add an *explicit*,
  user-declared `models.routeAliases` mapping. It must stay opt-in and must never guess.

## Consequences

- `ModelAvailability` gains `routeId` (upsert key), `providerId`, `modelId`;
  `ModelOutcome` gains `routeId` (`docs/records.md`). No schema-version bump: no store
  or release had shipped rows in the old shape.
- `/korwf models` and `/korwf status` render `provider/model [routeId8]` per route, so two
  entries for the same model id are distinguishable.
- Cap detection (#62) and health/breakers (#123) key on `RouteId` and must not aggregate
  by model id.
- A single-provider user has exactly one route per model; nothing about selection,
  capping or output changes for them beyond the eight-character route suffix.
