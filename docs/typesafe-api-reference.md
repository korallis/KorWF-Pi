# TypeSafe API reference (verified snapshot)

**Checked:** 2026-09-21, read-only, from public documentation only.
**No TypeSafe API requests were made** (no key was available and none was needed).

Sources (all fetched on 2026-09-21):

| Source | URL |
| --- | --- |
| HTTP API reference | https://docs.typesafe.ai/api |
| Models, limits, pricing | https://docs.typesafe.ai/models |
| Confidence | https://docs.typesafe.ai/confidence |
| Jev 1.13 jaggedness | https://docs.typesafe.ai/model-jaggedness/jev-1.13 (page says "Last reviewed 2026-09-17") |
| Primitives | https://docs.typesafe.ai/primitives/choice, /primitives/score, /primitives/noul |
| JS SDK | https://docs.typesafe.ai/sdk/javascript, https://docs.typesafe.ai/sdk/javascript/api, https://docs.typesafe.ai/sdk/javascript/changelog |
| JS SDK source | https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/{client,types,errors}.ts |
| npm metadata | https://registry.npmjs.org/@typesafe-ai/sdk |
| Legal index | https://docs.typesafe.ai/legal |
| DPA | https://typesafe.ai/legal/data-processing ("Last updated Apr 24, 2026") |
| Privacy policy | https://typesafe.ai/legal/privacy-policy ("Last updated Nov 19, 2025") |

This document is the input for the Stage 2 Jev adapter (#11, #17, #24). Where PLAN.md
assumed something different, the difference is called out under "Deltas vs PLAN".

---

## 1. Endpoint

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

- Single endpoint for all models and all question types. The `model` field selects the model.
- `GET https://api.typesafe.ai/v1/models` lists the names the account can send (currently
  the aliases only; versioned IDs are accepted even if not listed). Response:
  `{ models: [{ name: string, description: string, release_date: string }] }`.
- Base URL is overridable (SDK: `baseURL` option or `TYPESAFE_BASE_URL`; raw fetch: trivially).
  This satisfies PLAN §7 "configurable base URL for users who proxy".
- Request ID header on responses: `x-typesafe-request-id` (SDK exposes it as `requestId`
  on errors). Log it in decision traces.

## 2. Request schema

```jsonc
{
  "state": string | object | array,          // required. Text or JSON. Text only (no images/audio).
  "model": string,                           // required. Alias or versioned ID (see §5).
  "questions": { "<id>": Question, ... }     // required, non-empty map. Keys are chosen by the
                                             // caller, NOT sent to the model, echoed back in answers.
}
```

Shared question fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | `"noul" \| "choice" \| "score"` | yes | discriminator |
| `instructions` | `string \| object \| array` | yes | the judgment. Object form lets you put data in named fields and refer to them in backticks (`` `field` ``). Nested state referenced as `` `ticket.messages[0].text` ``. |
| `criteria` | per type | see below | |

### 2.1 Noul question

```jsonc
{ "type": "noul",
  "instructions": string | object | array,
  "criteria": {                       // optional
    "true":  string | object | array, // what yes (near 1) means
    "false": string | object | array  // what no  (near 0) means
  } }
```

### 2.2 Choice question

```jsonc
{ "type": "choice",
  "instructions": string | object | array,
  "criteria": { "<option>": string | object | array | null, ... } }  // required
```

Bounds: **1..255 options** (doc: "maximum of 255 options per Choice"). `null` = option needs
no description. Docs recommend an explicit `other` / `none_of_the_above` option when the list may
not cover every input (matches PLAN §6 "explicit none/unknown outcomes").

### 2.3 Score question

```jsonc
{ "type": "score",
  "instructions": string | object | array,
  "criteria": [ level0, level1, ... ] }   // required, ordered low→high
```

Bounds: **2..10 levels** ("at least two levels; the API accepts up to 10"). Each level is
`string | object | array` (SDK also allows `null` per level). Level index `i` (0-based) is the
numeric value of that level. **Note:** SDK v0.6.0 (2026-09-15) changed `criteria` from an
integer-keyed dictionary to an ordered array; the HTTP API doc shows the array form.

## 3. Response schema

```jsonc
{
  "model": string,                            // versioned ID that actually answered, e.g. "jev-1.13.0"
  "answers": { "<id>": Answer, ... },         // same keys as request.questions
  "usage": { "input_tokens": integer, "output_tokens": integer }
}
```

### 3.1 Noul answer

| Field | Type | Bounds | Notes |
| --- | --- | --- | --- |
| `type` | `"noul"` | | |
| `noul` | number | `[0, 1]` | probability the answer is yes. **No `confidence` field.** |

### 3.2 Choice answer

| Field | Type | Bounds | Notes |
| --- | --- | --- | --- |
| `type` | `"choice"` | | |
| `choice` | string | must be a key of request `criteria` | highest-probability option |
| `probabilities` | `map<option, number>` | each `[0,1]`, keys = exactly the request options, values sum to 1 (floating point) | **raw distribution — preserve verbatim** |
| `confidence` | number | `[0, 1]` | derived from `probabilities` (see §4) |

### 3.3 Score answer

| Field | Type | Bounds | Notes |
| --- | --- | --- | --- |
| `type` | `"score"` | | |
| `score` | number | `[0, N-1]` for N levels | probability-weighted mean of level indices; may fall between levels |
| `legend` | `map<string, string>` | keys `"0".."N-1"` | level index → level description (as string) |
| `probabilities` | `map<string, number>` | keys `"0".."N-1"`, each `[0,1]`, sum to 1 | **raw distribution — preserve verbatim** |
| `confidence` | number | `[0, 1]` | derived from `probabilities` |

Docs explicitly warn: different distributions give the same `score` (all mass on level 1 vs
half on 0 and half on 2 both give 1.0) — read `probabilities` and `confidence` alongside it.
Do not interpolate `score` to reconstruct a precise number (jaggedness §"Math using score").

### 3.4 Validation rules for the adapter (input to #17 / TODO §2 "Response validation")

Reject (or mark `malformed`) when:

- `answers` is missing a requested key, or contains keys not requested.
- `type` in the answer differs from the question's `type`.
- Any numeric field is outside its bounds above, non-finite, or not a number.
- Choice `choice` is not one of the request options; `probabilities` keys ≠ request option set.
- Score `probabilities`/`legend` keys ≠ `"0".."N-1"`; `score` outside `[0, N-1]`.
- Distribution sums differ from 1 by more than a tolerance (suggest `1e-3`; the docs say "floats
  that sum to 1", so allow rounding).
- Unknown extra fields on an answer: **tolerate and log** (forward-compatibility), never trust.
- `model` absent: reject — the adapter must record which version answered (§5).

## 4. Confidence statistic — what it is and is not

Quoted from https://docs.typesafe.ai/confidence (checked 2026-09-21):

> `confidence` is a statistic computed from the probability distribution the answer already
> gives you. … concentrated on one outcome means a confident answer, spread out means an
> uncertain one.

> We provide `confidence` as a convenient measure that fits most use-cases, but you are never
> locked into our definition … which is exactly why we give you the full `probabilities`.

Facts:

- Present only on **Choice** and **Score**. **Noul has no confidence**; `noul ≈ 0.5` means
  "yes and no similarly likely", not "medium intensity".
- Range `[0, 1]`. 1.0 = all mass on one option/level; lower = flatter.
- The exact formula is not published as normative; the docs' interactive demo approximates
  three-option Choice confidence as `(k·max_p − 1)/(k − 1)` (k = option count). The adapter
  must **not** rely on this formula; it must store the raw `probabilities` and treat
  `confidence` as an opaque, versioned statistic.
- Docs recommend three bands (high → act, medium → confirm/flag, low → don't act), with
  thresholds that "scale with risk" and are tuned on your own data. This aligns with PLAN §6
  (calibrate per evaluator and risk class; conservative defaults + abstention until data exists).

What it does **not** measure (docs + PLAN §1):

- Not correctness of the answer, not task-specific accuracy, not a guarantee the question was
  well-formed, not agreement with a human.
- Not a permission signal (PLAN §7: permissions come from policy, not semantic confidence).
- Not comparable across question types: a threshold tuned on a Noul must not be reused for a
  Choice (jaggedness §"Common-sense structural invariants" shows Noul 0.22 vs Choice
  yes=0.01/conf=0.97 on the same input). `P(noul)` and `1 − P(not noul)` are not guaranteed to
  agree either.
- Not transferable across model versions: "If you have tuned confidence thresholds against a
  specific version, pin that version's ID instead of the alias."

## 5. Models, aliases, and the pin

| Name | Kind | Resolves to (2026-09-21) |
| --- | --- | --- |
| `jev-1.13.0` | versioned ID | itself |
| `jev-latest` | alias | `jev-1.13.0` (SDK default) |
| `jev-preview` | alias | `jev-1.13.0` (no preview build currently) |

**Pinned version for KorWF-Pi: `jev-1.13.0`.**

Rationale: PLAN §6 says "pin tested Jev versions"; the docs say aliases move on release "so the
answers behind it can change without a change on your side" and recommend pinning when
thresholds are tuned. The adapter must:

1. Send the pinned versioned ID in `model` (from config; default `jev-1.13.0`). Never rely on
   the SDK's `jev-latest` default or `TYPESAFE_DEFAULT_MODEL`.
2. Record the response `model` field in every decision trace and cache key.
3. Treat a response `model` ≠ configured pin as a validation warning (not an error — aliases
   are permitted if the user configures one) and include it in cache keys so a moved alias
   invalidates cached decisions.

Note the jaggedness page and SDK examples use `jev-1.13` (no patch) as a model name in
Python examples; the Models page only lists `jev-1.13.0`. Use the fully qualified `jev-1.13.0`.

### Jev 1.13 known limits (from the jaggedness page; relevant to question design)

Literal reading; unreliable counting/arithmetic/numeric comparison; unreliable date ordering;
degrades with indirection and with large irrelevant state ("context rot"); not hardened against
adversarial content in `state`; contradictory instructions vs criteria degrade results; no
guaranteed structural invariants between separate questions; not a generator. All arithmetic,
graph logic, counting, and date math stays in code (PLAN §6 already requires this).

## 6. Limits and pricing (Jev 1.13, checked 2026-09-21)

| Item | Value |
| --- | --- |
| Price | **$0.042 per million input tokens** ($42 per billion). Output tokens free. |
| Rate limit | 250,000 tokens/second **and** 1,200 requests/minute (either exceeded → 429) |
| Context | 64k tokens per request (state + all questions); 32k for state + the single longest question |
| Input | text only (string / JSON object / array of text); no images/audio/video |
| Language | English primary; other languages handled less well |

Docs warning (verbatim): "**Rate limits are adjusting dynamically.** … the limits above can
change without notice". Therefore the adapter must not hardcode these numbers as policy; treat
them as defaults in config and drive behaviour from 429/`retry-after` at runtime.

Cost per call: `input_tokens × $0.042 / 1e6`. A 2,000-token request costs ≈ $0.000084. The
response `usage.input_tokens` is authoritative for accounting (PLAN §I "known/estimated/unknown
cost": known after the response, estimated before from a local token estimate). Output tokens are
reported but priced at zero.

Usage/quota dashboards, monthly caps, and spend quotas are **not documented** in the public
API docs; no `quota exceeded` distinct from 429 is documented. See §7.

## 7. Error taxonomy

Documented HTTP statuses (https://docs.typesafe.ai/api#errors):

| Status | Meaning (docs) | SDK class | Retry? |
| --- | --- | --- | --- |
| 401 | Missing or invalid API key | `AuthenticationError` | no |
| 422 | Request body failed validation; body names the offending field | `UnprocessableEntityError` | no (bug in our request) |
| 429 | Rate limit exceeded; "Back off and retry after a short delay" | `RateLimitError` (has `retryAfterMs`) | yes, exponential backoff, honour `retry-after` / `retry-after-ms` |
| 529 | "TypeSafe is temporarily overloaded. Retry after a short delay." | `InternalServerError` (SDK maps any ≥500) | yes, backoff |

SDK-defined but not documented on the API page (mapping from `errors.ts`): 400 `BadRequestError`,
403 `PermissionDeniedError`, 404 `NotFoundError`, other 5xx `InternalServerError`, plus
transport errors `APIConnectionError`, `APITimeoutError`, `APIUserAbortError`. The SDK's
default retry set is `408, 429, 500–599`.

Error bodies are JSON "describing what went wrong"; the exact body schema is not published.
The adapter must store `status`, `body` (sanitised), `x-typesafe-request-id`, and `retry-after`.

### 7.1 Mapping to PLAN §3.G failure taxonomy

PLAN §3.G lists: implementation, environment, missing information, dependency, test
expectation, service, **quota/rate-limit**, unknown. PLAN §D requires "quota exhaustion, rate
limits, and budget caps" recorded in `ModelAvailability` with an estimated reset.

Proposed Jev-side codes (adapter-level, provider-agnostic names, to be finalised in #17):

| Adapter code | Source | §3.G class | ModelAvailability effect |
| --- | --- | --- | --- |
| `jev.rate_limited` | HTTP 429 | quota/rate-limit | capped; reset = now + `retry-after` if present, else backoff estimate |
| `jev.quota_exhausted` | HTTP 429 whose body/headers indicate an account-level cap, or **local** budget reservation failure | quota/rate-limit | capped; reset = billing period / unknown → pause with visible state |
| `jev.budget_cap` | local spending policy (PLAN §I) — never a server signal | quota/rate-limit | capped by policy; no reset until user raises cap |
| `jev.overloaded` | HTTP 529 | service | transient; retry then optional-mode fallback |
| `jev.unavailable` | 5xx other, connection error, timeout, circuit open | service | transient |
| `jev.auth` | HTTP 401 / 403 | environment | Jev disabled → deterministic fallbacks (PLAN §J) |
| `jev.bad_request` | HTTP 422 / 400 | implementation | our question builder is wrong; never retried |
| `jev.malformed_response` | validation in §3.4 fails | service | treat as unavailable for this decision |
| `jev.cancelled` | AbortSignal | (not a failure) | none |
| `jev.unknown` | anything else | unknown | transient, bounded retries |

Conservative decision: because TypeSafe documents **only** 429 for both rate limiting and any
account cap, `jev.quota_exhausted` cannot be distinguished from `jev.rate_limited` by status
alone. The adapter should treat a 429 with no `retry-after`, or repeated 429s beyond the retry
budget, as `quota_exhausted` (long reset, pause + surface), and a 429 with a short
`retry-after` as `rate_limited`. Revisit if TypeSafe publishes a distinct code.

## 8. Data retention and privacy (quoted, checked 2026-09-21)

Models page (https://docs.typesafe.ai/models#data-handling):

> Jev is not trained on customer requests or responses. See Legal for the Data Processing
> Agreement, the Privacy Policy, and details on zero data retention (ZDR) for enterprise customers.

Legal index (https://docs.typesafe.ai/legal):

> These documents cover how TypeSafe handles your data when you have an account with us,
> including data retention, our commitment not to train models on user data …
> We also offer zero data retention (ZDR) for enterprise customers. Contact privacy@typesafe.ai

Privacy Policy (https://typesafe.ai/legal/privacy-policy, "Last updated Nov 19, 2025"):

> We (1) will not train or fine tune any artificial intelligence or machine learning models on
> Input, and (2) will not disclose any Input to a third party other than our service providers.

> Retention: We retain personal data about you for as long as reasonably necessary to provide
> you with the Services, or otherwise in support of our business or commercial purposes.

Data Processing Addendum (https://typesafe.ai/legal/data-processing, "Last updated Apr 24, 2026"),
Annex "Duration of Processing":

> Customer Personal Data will be retained for as long as necessary taking into account the
> purpose of the Processing, and in compliance with applicable laws, including laws on the
> statute of limitations and Data Protection Law.

Implications for KorWF-Pi:

- **No fixed retention window is published** for API request/response content on the standard
  plan. ZDR is an enterprise-only arrangement. The first-use disclosure (PLAN §7) must say
  that text sent to Jev may be retained by TypeSafe for an unspecified period and is not used
  for training.
- Default-deny outbound lists and minimal-snippet construction (PLAN §7) are the primary
  privacy control, not provider retention terms.
- The SDK's `debug` log level logs request **bodies unredacted** ("Known credential headers are
  redacted; bodies are not") — must never be enabled by default (see ADR-0003).

## 9. JavaScript SDK surface (`@typesafe-ai/sdk` v0.6.0, published 2026-09-15)

| Property | Value |
| --- | --- |
| Package | `@typesafe-ai/sdk` 0.6.0, MIT, **zero runtime dependencies**, `engines.node >= 20`, unpacked ≈ 209 kB (ESM + CJS + `.d.ts`) |
| First public release | v0.5.7 (2026-09-11); v0.6.0 broke `Score.criteria` (dict → array). Young, moving API. |
| Client | `new TypeSafeClient(config?)`; `client.systemOne(request, options?)`; `client.models.list()` |
| Config | `apiKey` (env `TYPESAFE_API_KEY`), `baseURL` (env `TYPESAFE_BASE_URL`, default `https://api.typesafe.ai`), `defaultModel` (env `TYPESAFE_DEFAULT_MODEL`, default `jev-latest`), `timeout` (per attempt, default 10000 ms, **no total budget**), `retry` (Partial\<RetryPolicy\>), `fetch` (injectable — enables mocking), `logger`/`logLevel` (env `TYPESAFE_LOG_LEVEL`, default `warn`), `defaultHeaders`, `dangerouslyAllowBrowser` |
| Retry defaults | maxRetries 2; statuses 408, 429, 500–599; backoff 500 ms doubling to 5000 ms, jitter 0.25; honours `Retry-After`/`retry-after-ms` up to 60 s; retries connection and timeout errors |
| Per-call options | `signal: AbortSignal` (cancels request **and pending retries**), `timeout`, `retry`, `headers` |
| Typing | answer types inferred from question builders `choice()`, `score()`, `noul()`; `ScoreResponse.probabilities`/`legend` keyed by numeric level in TS types (HTTP uses string keys) |
| Errors | `TypeSafeError` → `APIError` (`status`, `body`, `headers`, `requestId`) → per-status subclasses; `RateLimitError.retryAfterMs`; `APIConnectionError`, `APITimeoutError`, `APIUserAbortError` |
| Constructor throws | if API key missing → **the adapter must check key presence itself before constructing** to support no-key optional mode |
| Sends | `User-Agent: typesafe-sdk/<version>`; refuses browser runtime unless `dangerouslyAllowBrowser` |

Decision on SDK vs raw fetch: see `docs/adr/0003-jev-transport.md`.

## 10. Deltas vs PLAN.md

| PLAN assumption | Verified reality | Action |
| --- | --- | --- |
| "pin tested Jev versions" (§6) | Versioned ID `jev-1.13.0`; aliases `jev-latest`/`jev-preview` move | Pin `jev-1.13.0` in config default; record response `model` |
| Quota vs rate-limit distinguishable (§3.G, §D) | Only 429 documented for both; 529 for overload | Adapter heuristic in §7.1; budget caps are local |
| Confidence on all question types | Noul has none | Noul thresholds operate on `noul` directly; per-type calibration |
| Retention terms available to quote | Only "as long as necessary"; ZDR enterprise only; no training on Input | First-use disclosure wording; keep default-deny outbound |
| Configurable base URL (§7) | SDK supports `baseURL` / `TYPESAFE_BASE_URL`; raw fetch trivially | Either path works |
| Score criteria shape | Ordered array (SDK v0.6.0 breaking change) | Question definitions use arrays |
