# ADR-0003: Jev transport — raw `fetch` behind our own interface, not the JS SDK

**Status:** Confirmed (Stage 2, issue #24 implements `JevTransport`/`HttpJevTransport`/`MockJevTransport`/`DisabledJevTransport` in `src/jev/`). Optional-mode semantics (rule 3) are fixed by [ADR 0007](0007-jev-optional-design.md) (#17).
**Date:** 2026-09-21
**Governing design:** PLAN §6 (Jev decision design), §7 "Jev transport", §3.G/§3.D (caps,
rate limits), §3.J (Jev optional at runtime).
**Inputs:** `docs/typesafe-api-reference.md` (verified 2026-09-21, no API calls made).

## Context

The Jev adapter (Stage 2) needs: a configurable base URL for proxies, key resolution from env
or Pi's secrets facility with nothing logged, cancellation tied to Pi's `AbortSignal`s,
hard deadlines per decision, bounded retries with backoff and circuit breaking, response
validation against pinned schemas, usage accounting from `usage.input_tokens`, and a
mockable seam so tests never make live requests.

Two options were assessed against the verified API and the `@typesafe-ai/sdk` v0.6.0 surface.

### Option A — `@typesafe-ai/sdk` (v0.6.0)

Pros
- Zero runtime dependencies, MIT, ≈209 kB unpacked, Node ≥ 20 (matches Pi's runtime).
- `baseURL` override, injectable `fetch`, `AbortSignal` that cancels pending retries,
  `Retry-After`/`retry-after-ms` handling, typed answers inferred from question builders,
  typed error subclasses with `requestId` and `retryAfterMs`.

Cons
- **Young and moving**: first public release 2026-09-11; a breaking change four days later
  (v0.6.0 changed `Score.criteria` shape). A pinned dependency will lag or break.
- **Constructor throws when the key is missing.** Optional/no-key mode (PLAN §J) must be
  implemented around the SDK anyway.
- **Environment-driven defaults** (`TYPESAFE_DEFAULT_MODEL` → `jev-latest`, `TYPESAFE_BASE_URL`,
  `TYPESAFE_LOG_LEVEL`) silently affect behaviour. A user's shell could unpin the model or set
  `debug`, which logs **request bodies unredacted**. We would have to override every one.
- **Retry policy owns the loop.** No total time budget ("timeout per attempt, without a total
  retry budget"); retries on all 5xx by default. Our deadline, circuit breaker, and budget
  reservation must wrap it, and double-retry has to be prevented by setting `maxRetries: 0`,
  at which point most of the SDK's value is gone.
- TS `probabilities`/`legend` are keyed by number in the types while the wire uses strings;
  our validator must work on the wire form regardless.
- Auto-generated type inference (`ResultFor<Q>`) is convenient but our questions are
  versioned data definitions (PLAN §6), not TS literals; the inference does not apply.

### Option B — raw `fetch` (global, Node ≥ 20) behind `JevTransport`

Pros
- One endpoint, one JSON POST, no streaming. The whole wire contract fits in
  `docs/typesafe-api-reference.md` §2–§3. No dependency to track.
- Full ownership of: deadline (single `AbortSignal` combining Pi cancellation + timer),
  bounded retries only on 429/529/network with our backoff and `retry-after` parsing,
  circuit breaking, budget reservation before send, model pin, header allowlist, and
  redaction. Nothing reads process env except our own secret resolver.
- Mock seam is the `fetch` function (same seam the SDK offers), so tests are identical in
  cost and never go live.
- Validation is on the raw wire form, the source of truth for pinned schemas.

Cons
- We re-implement ~150 lines: error class mapping, `retry-after` parsing, request-id capture,
  JSON error body handling. Mitigation: copy the documented status table (§7 of the reference)
  and test against recorded fixtures.
- No upstream typed helpers. Mitigation: our versioned question definitions already carry the
  schema; a small local type set (`NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`) suffices.

## Decision

Use **raw `fetch`** behind a small internal `JevTransport` interface:

```ts
interface JevTransport {
  evaluate(req: SystemOneRequest, opts: { signal: AbortSignal; deadlineMs: number }):
    Promise<SystemOneResponseRaw>;   // raw JSON, validated by a separate layer
}
```

Concrete rules the implementation (#17) must follow:

1. **Model pin.** Always send `model` from config; default `jev-1.13.0`. Never `jev-latest`.
   Record the response `model` in the decision trace and cache key.
2. **Base URL** from config (`jev.baseUrl`, default `https://api.typesafe.ai`); path
   `/v1/systemone`. No env var read by the transport itself; the config layer may map an
   env var to config explicitly.
3. **Key** from the approved secret mechanism only (PLAN §7). If absent → transport is not
   constructed and the adapter reports `optional-mode` (no key); no request is attempted.
4. **Headers sent:** `Authorization`, `Content-Type: application/json`, and a product
   `User-Agent` without user-identifying data. Nothing else.
5. **Retries:** at most N (config, default 2) on 429, 529, other 5xx, and network errors;
   exponential backoff with jitter; honour `retry-after` (seconds) and `retry-after-ms`
   capped by the decision deadline. Never retry 4xx other than 429. Never exceed the
   per-decision deadline in total.
6. **Error mapping** to the adapter codes in reference §7.1 (`jev.rate_limited`,
   `jev.quota_exhausted`, `jev.overloaded`, `jev.unavailable`, `jev.auth`, `jev.bad_request`,
   `jev.malformed_response`, `jev.cancelled`, `jev.unknown`), feeding `ModelAvailability`
   and the §3.G failure taxonomy.
7. **Redaction:** never log `Authorization`; raw request/response bodies only under the
   opt-in raw-payload logging with retention controls (PLAN §7).
8. **Accounting:** `usage.input_tokens × price` from config (default $0.042/Mtok) → known
   cost; estimated cost before send from a local token estimate.
9. **Validation** is a separate pure layer over the raw JSON (reference §3.4) so it is
   testable without a transport.
10. **Reconsideration trigger:** if the SDK reaches a stable 1.x with a total-deadline
    option, no env-driven defaults leaking into model selection, and a non-throwing
    no-key construction path, revisit; the `JevTransport` seam makes a swap local.

## Consequences

- No third-party dependency in the Jev path; smaller supply-chain surface.
- All rate-limit/quota behaviour is in our code and testable with fixtures.
- We must keep `docs/typesafe-api-reference.md` current when TypeSafe changes the wire
  format; a fixture-based contract test (Stage 2) should fail loudly on schema drift.
- No live calls are authorised by this ADR; live verification needs a budget approved by
  Lee on the relevant issue (AGENTS.md §4).
