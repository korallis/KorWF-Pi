# Versioned questions and composition policy

**Design authority:** [PLAN.md](../PLAN.md) §6 "Jev decision design" · **Issue:** #27 ·
**Code:** [`src/decisions/`](../src/decisions/)

Every Jev question the product asks is a shipped, versioned artefact. This document is
the policy; `src/decisions/` is the implementation and `test/unit/decisions/` is the
proof. It builds on the Jev transport and response validation (#24, #25,
[`src/jev/`](../src/jev/)) and on the store (#23, [`src/storage/`](../src/storage/)) —
neither is re-implemented here.

## 1. Naming and versioning

- **Id:** `family.question`, lower snake case, at least one dot —
  `task.atomic`, `passage.relevant`, `review.severity`. Enforced by
  `assertQuestionNaming`, so a malformed id throws at definition time.
- **Version:** a positive integer string (`"1"`, `"2"`). Not semver: there is no such
  thing as a backwards-compatible change to a question's wording.
- **Key:** `id@version` (`example.echo@1`). This is the registry key, and it is what is
  recorded on every `Decision` row (`questionId` + `questionVersion`).

**The version rule.** Each definition carries a `contentHash`: sha256 over its id, type,
prompt, options/levels, and abstention policy. A registry entry may pin the hash it was
reviewed at. Editing any of that content changes the hash, the pin no longer matches, and
registration throws — so a prompt cannot change without a version bump. Two versions of a
question may be live at once (one in shadow, one in force); the registry keeps both and
`latest(id)` names the newest.

When you change a question: add the new version alongside the old one, register it with
its new hash, and leave the old definition registered until nothing reads its recorded
decisions any more. Never edit a published version in place.

## 2. What a definition must contain

`defineNoul` / `defineChoice` / `defineScore` in
[`question.ts`](../src/decisions/question.ts) all require:

| Part | Why |
|---|---|
| **One narrow prompt** | PLAN §6 "narrow, versioned questions". One criterion per question. |
| **Minimal state** (`state(input)`) | Only the fields that bear on this question (PLAN §6 "minimal relevant state per evaluation"). Smaller state also means a more stable cache key. |
| **`decide`** | Maps a *validated* answer (from `src/jev/validate.ts`) to a typed result plus the policy rule and action recorded on the Decision. |
| **`fallback`** | Deterministic answer for when Jev is disabled, unreachable, cancelled, malformed or abstaining. **Mandatory** (PLAN §2.4). It must compute from the input alone — no network, no model, no clock-dependent guesswork. |
| **`boundaries`** | At least one explicit boundary case with its expected *fallback* result. Checked at registration, so the no-key path is exercised by construction. |
| **An abstention policy** | `abstainBand` for noul, `minConfidence` for choice/score. Answers inside the band or under the floor are not answers. |
| **A none/unknown option** | Choice questions must offer one. A choice without it forces a guess (PLAN §6 "none/unknown outcomes"). |

`replay` is optional: it rebuilds the typed result from a recorded `Decision.action` so a
decision whose state hash still matches can be replayed rather than re-asked
([docs/records.md](records.md) §10 rule 4). Reuse is an optimisation; a question that
cannot replay is simply asked again.

## 3. Asking: batching and staging

[`ask.ts`](../src/decisions/ask.ts) is the only path from a question to an answer.

- **`ask(ctx, question, input)`** — one question. Never throws.
- **`askAll(ctx, items, { concurrency })`** — **independent** questions. Items whose
  minimal state is identical are merged into one multi-question request (the API takes
  one state and many questions); distinct states go out concurrently, capped at
  `concurrency` (default `DEFAULT_CONCURRENCY = 4`). Results keep the item order,
  whatever order the responses arrived in.
- **`askStaged(ctx, carry, stages)`** — **dependent** questions. Stages run in order,
  each internally batched, each folding its results into the carry the next stage builds
  from. A stage may declare `stopWhen` to halt the chain — a later stage that a gate has
  already decided against is never asked, and never billed.

Independent means *the answers do not inform each other*. If question B's wording or
state depends on A's answer, they are two stages, not one batch.

## 4. Composition: ask narrow, combine in code

The bootstrap orchestrator in `scripts/orchestrate/` (a reference, not product code)
learned this the expensive way: **a single existential question over a large scope
deflates with scope size.** "Is anything wrong anywhere in this diff?" scores lower the
larger the diff, for reasons that have nothing to do with the diff. Its question sets
therefore ask one bounded question per criterion and take the conjunction in code.

[`compose.ts`](../src/decisions/compose.ts) makes that the cheap option:

| Combinator | Use |
|---|---|
| `allTrue(parts)` | One question per criterion, conjunction in code. Over zero parts it is **false**, never vacuously true. |
| `anyTrue(parts)` | "Is any of these a blocker?" |
| `majority(parts)` | Returns `null` on a tie rather than guessing. |
| `rankBy(candidates, { threshold })` | One independent question per candidate, then sort and threshold **in code**. Adding a candidate cannot change another candidate's score — which is exactly what a single "pick one" question fails to guarantee. Returns `null` for "none adequate". |
| `conservative(composed)` | A permit built on a degraded part is denied unless the caller explicitly allows it (PLAN §6 "conservative defaults and abstention"; AGENTS.md §4). |

Every combinator reports `degraded` and `fellBack`, so a caller can always tell how much
of a verdict rests on fallbacks rather than answers.

Arithmetic, counting, graph reachability, schema checks and threshold comparison stay in
code (PLAN §6). Jev answers judgment questions; code does the maths.

## 5. Recording

Every `ask`, on every path including disabled mode, appends a `Decision` through the
store (#23; [docs/records.md](records.md)). The fields PLAN §5 requires are filled as
follows:

| Field | Value |
|---|---|
| `stateHash` | sha256 over `{ key, contentHash, model, state }` — the complete versioned key (PLAN §6 "cache only with complete versioned keys"). Any change to the question text, the Jev model, or the state is a different hash. |
| `questionId` / `questionVersion` | From the definition. |
| `jevModelVersion` | The model string from the response; **`null` on every fallback path.** |
| `rawDistribution` | Exactly as returned. Noul is recorded as `{ true: p, false: 1-p }`. `{}` when no answer was received at all; the distribution is still recorded for an abstention, because the abstention *is* the observation. |
| `confidence` | As returned for choice/score; `null` for noul and for fallbacks. |
| `policyRule` | The question's rule on the Jev path; exactly **`"fallback"`** for an unqualified fallback, or `fallback:<rule>` when the fallback names its own rule. |
| `action` | What code will do with the result. |
| `usage` | Zero-cost for a fallback (no request was made); one request with `costBasis: "unknown"` for a Jev call the adapter could not price (#30). |

Decisions are append-only. A changed input produces a new row with a new state hash; a
correction is a new row, never an edit.

## 5.1 Caching (issue #29)

[`cache.ts`](../src/decisions/cache.ts) is a separate, optional layer on top of
`ask`'s recording: it lets a caller reuse a `Decision` that was already computed for
the exact same complete versioned key, instead of a fresh `ask`/`askAll` call.

The key (`cacheKeyOf`) is a sha256 over `questionId`, `questionVersion`, `contentHash`,
`jevModelVersion`, `policyVersion` (`Workflow.policyVersion`, docs/records.md §5) and
`stateHash`, plus `repoRevision` — but **only** when the question declares
`revisionSensitive: true`. That flag is per-question, not per-call: a question whose
answer cannot change as the repository changes (e.g. "is this string a question or a
statement?") does not fragment the cache on every commit; a question whose answer can
(e.g. anything reading file contents at a path) declares `revisionSensitive: true` and
every commit is a fresh key.

Two rules make a cache hit across a boundary structurally impossible rather than merely
unlikely:

- **Any key component changing is a different key.** There is no partial match, no
  "close enough" state, and no separate invalidation pass to keep in sync — a stale
  question version, a re-pinned Jev model, a bumped policy version, a changed minimal
  state, or (for a revision-sensitive question) a new commit all produce a cache miss by
  construction, because the key literally is not the same key.
- **Approval questions never enter the cache at all.** `isApprovalQuestion` recognises
  the `approval.` family prefix; `cacheStore` and `cacheLookup` are no-ops for it
  regardless of `revisionSensitive`, `enabled`, or TTL — PLAN §6's "never reuse a stale
  approval" is enforced before the key is even computed.

Backed by `decision_cache` (`src/storage/migrations/0003-decision-cache.sql`), a
separate table from `decision` itself: a cache row only points at the `Decision` row
that is its answer (`decisionId`, `ON DELETE RESTRICT`), so it carries no independent
truth, is not audited, and may be overwritten or deleted — the append-only guarantee
still applies only to `decision`. TTL (`config.jev.cache.ttlSeconds`) is a ceiling on top
of key freshness, not a substitute for it: `ttlSeconds: 0` means "no time limit", never
"no key check".

## 6. Fallback reasons

`FallbackReason` is a closed set, and every one of them is recorded:

`disabled` (no key / Jev off) · `transport_error` · `cancelled` · `invalid_response`
(failed #25 validation) · `missing_answer` · `abstained` (inside the band or under the
confidence floor) · `answer_type_mismatch`.

There is no "unknown" reason. If a new failure mode appears, it gets a name.

## 7. Adding a question family

1. Write the definitions in `src/decisions/<family>.ts` using the builders. One narrow
   question per criterion.
2. Give each a deterministic fallback and at least one boundary example per interesting
   case — including the empty/degenerate one.
3. Register them into `questionRegistry` with a pinned hash, and record the hashes in the
   family's own `*_HASHES` constant (see [`examples.ts`](../src/decisions/examples.ts)).
4. Add a test asserting `registry.diffManifest(HASHES)` is empty, so a later edit without
   a version bump fails CI.
5. Compose the answers with `compose.ts`; never ask one broad question in their place.

`example.echo@1`, `example.classify@1` and `example.length@1` in `examples.ts` are the
worked reference. They are registered into a separate `exampleRegistry` and are never
reachable from product code.
