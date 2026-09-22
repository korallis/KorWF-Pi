# Failure taxonomy and stall detection

Issue #52 · PLAN §3.G · Code: `src/workflow/failure.ts`, `src/workflow/failure-classify.ts`,
`src/workflow/stall.ts`, `src/decisions/questions/failure.ts`.

## 1. Categories

| Category | Meaning | Deterministic signals |
| --- | --- | --- |
| `implementation` | The change itself is wrong | `error TS####`, `SyntaxError`, parse errors |
| `environment` | Machine/toolchain/permissions not as required | exit 127, "command not found", `ENOENT`/`EACCES`/`ENOSPC`/`EADDRINUSE`, verification status `unavailable` |
| `missing_information` | Undecidable without information nobody supplied | explicit worker markers (`Missing information:`, `requirement is ambiguous`) |
| `dependency` | A prerequisite artefact is not ready | `Cannot find module`, `could not resolve`, unmet peer dependency |
| `test_expectation` | The test asserts something the requirement never implied | obsolete/mismatched snapshot |
| `service` | A remote service failed or was unreachable | HTTP 5xx, `ECONNRESET`/`ENOTFOUND`/`ETIMEDOUT`, `socket hang up`, TLS/DNS |
| `quota` | Rate limit, token quota or spend cap | HTTP 429/402, "rate limit", "quota exceeded", "insufficient credit" |
| `harness` | The harness failed, not the work | **from `src/workers/truncation.ts` (#124)**: `stopReason: "length"`, timeout kill, worker process death |
| `unknown` | Nothing above is supported by the evidence | — |

Two categories are **folded in, not redefined**:

- `harness` is whatever `classifyTurn` (#124) already calls a harness failure. `classifyFailureByRules`
  consults it *first* and adopts its verdict verbatim. A truncated turn has no output to judge, so
  reading its text for taxonomy signals is exactly the mistake #124 exists to prevent. Its
  `capped` kind maps to `quota`, because that is a fact about the route, not the harness.
- `service` is only a *label* here. Retry bounds and the circuit breaker live in
  `src/jev/resilience.ts` (#26) and are not duplicated.

## 2. `unknown` asks for evidence

`unknown` is a real category with `needsEvidence: true` and a non-empty `evidenceRequests`
list derived from what the signal was *missing* ("re-run and record the exit code", "capture
stderr", "re-run at the same revision to establish reproducibility"). Nothing downstream may
treat an `unknown` as a diagnosis. Jev answering `unknown` produces the same shape.

## 3. Order of classification

1. `classifyTurn` (#124) if a worker turn was supplied.
2. `FAILURE_RULES`, first match wins — confidence 1, `source: "rule"`, `needsEvidence: false`.
3. `unknown` with `needsJev: true`. `classifyFailureWithJev` may then ask `failure.classify@1`;
   its deterministic fallback (no key, transport error, abstention, out-of-band choice) is
   `unknown`. A Jev answer can never overturn a rule match.

## 4. Quota events

A `quota` classification yields a `QuotaEvent` keyed by **route** (`providerId::modelId`), not by
model id. AGENTS.md §4: two subscriptions to one vendor appear as two providers exposing the same
model id with separate quotas; keying on the model id alone mis-attributes the limit and can pause
a healthy route. `Retry-After` is parsed when present. A service failure yields `null`, never a
speculative pause.

## 5. Stall signals

| Kind | Fires when | Threshold |
| --- | --- | --- |
| `repeated_failure` | the same check fails with the same signature N times | `repeatedFailures` (default 3) |
| `repeated_approach` | N attempts share an approach fingerprint | `repeatedApproaches` (default 2) |
| `no_progress` | N consecutive attempts make no measurable progress, or one attempt makes many tool calls and changes no file | `noProgressAttempts` (2) / `toolCallsWithoutChange` (12) |
| `scope_drift` | any write lands outside the task's declared ownership | 1 |

Rules the detector holds to:

- **Harness failures never count.** A truncated or timed-out turn is a turn the worker never got
  to take; counting three of them as three failures was the #14/#11 defect. They contribute to
  neither `repeated_failure` nor the no-progress streak.
- **Measurable progress** is a file actually changing, or a failing **verifying** check starting
  to pass. Whether a check is verification is `isVerifyingCheck` (#44) and nothing else — a
  `true`/`echo ok` check flipping to pass is explicitly *not* progress, and the event says so.
- **Drift is structural**, not a judgement: it maps to the existing `write_outside_ownership`
  approval class (#15).
- Each kind fires **once** per task per state. A stall event asks for a recovery decision;
  re-raising it every attempt would drown the decision it asks for. Stall events are advisory —
  they never stop work themselves.

## 6. Questions

- `failure.classify@1` — options are exactly `FAILURE_CATEGORY_DESCRIPTIONS`, so prompt and code
  cannot drift. Fallback `unknown`.
- `stall.repeated_approach@1` — for "different diff, same idea"; the identical-fingerprint case is
  already structural. Fallback `not_repeated`: with no key the only supportable claim is the
  fingerprint comparison that already said the attempts differ, and falling back to `repeated`
  would halt a task on no evidence. (The issue names it `stall.repeatedApproach@1`; the registry's
  lower-snake-case rule in `docs/questions.md` §1 is enforced in code, so the id follows it.)
