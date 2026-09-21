# Decision traces, retention, and raw-payload logging

Issue #31. Design authority: `PLAN.md` §3.I ("decisions explained from recorded
inputs, returned values, and policy rules — never fabricated rationales;
versions recorded: Jev model, question set, policy, schema, package") and §7
("sanitised logs; raw payload logging opt-in with retention and deletion
controls").

This extends what Stage 2 already built. It does not replace any of it.

## 1. What a trace is, and what it is not

| Artefact | Owner | Holds |
|---|---|---|
| `Decision` row (append-only) | `src/storage/` (#23) | The **record**: state hash, question id/version, Jev model version, raw distribution, confidence, policy rule, action, override, freshness, usage, latency. |
| `DecisionTrace` (write-once) | `src/telemetry/trace.ts` (#31) | The **observability**: the five PLAN §3.I versions, latency, retries, breaker state, a sanitised summary of what actually went outbound, and an optional pointer to opt-in raw bytes. |
| `LedgerEntry` (append-only) | `src/telemetry/ledger.ts` (#30) | The **accounting**: reservations and settlements against budget caps. |

A trace never duplicates the Decision and never becomes a second source of
truth about it. Deleting a trace (retention) leaves the Decision untouched;
the `ON DELETE RESTRICT` foreign key makes that structural.

## 2. The honesty invariant

`DecisionTrace` has **no free-text rationale field**. There is nowhere to put
a sentence that nobody recorded. `explainDecision(decision, trace)` builds
every line out of a stored value and labels it with the artefact and field it
came from:

```
Decision dc-7 — task.ready@2
  Question: task.ready@2   [decision.questionId/questionVersion]
  Answered by: jev-2025-06   [decision.jevModelVersion]
  Returned distribution: false=0.0500, true=0.9500   [decision.rawDistribution]
  Policy rule applied: noul_above_threshold   [decision.policyRule]
  Action taken: proceed   [decision.action]
  Versions: package 0.1.0, schema 1, policy 1, questions 3f2a…, Jev model jev-2025-06   [trace.versions]
  Latency: 412 ms   [trace.latencyMs]
  Sent outbound: 1180 bytes for jev.decision (state keys: goal, revision)   [trace.request]
  Raw payload: not stored (privacy.rawLogging.enabled is off)   [trace.rawPayload]
```

Anything absent is reported as a gap under `Not recorded:` — a missing trace
does not become an assumed version, and a missing Decision does not become an
assumed distribution. When no Jev model answered, the line says so explicitly
("the deterministic fallback produced this answer") rather than naming a model
that did not run.

## 3. The five versions

`TraceVersions` carries `package`, `schema`, `policy`, `questionSet` and
`jevModel`. `assertTraceVersions` runs twice — once when a `TraceRecorder` is
constructed (so a misconfiguration surfaces immediately, not halfway through a
workflow) and once per trace — and throws `TraceVersionError` if any of the
first four is missing or blank.

`jevModel` is `null` whenever no Jev model answered. That is a recorded fact,
not a missing field: substituting a placeholder would be exactly the
fabrication §3.I forbids. The type still requires the property, so it cannot
be silently omitted.

## 4. Sanitisation

Every trace field passes the #22 redactor on the way in: the policy rule, the
action, the fallback reason and the distribution's label keys. The outbound
summary is derived from #28's `OutboundReport`, which by construction carries
counts, paths and reasons and never removed content; denied paths are
redacted again on the way into the trace.

Consequence: a trace can be shown to the user, written to disk, and included
in an export without a second sanitising step.

## 5. Raw-payload logging (opt-in)

Off by default (`privacy.rawLogging.enabled: false`). With the shipped
defaults, `createRawPayloadSink` returns `null`, `TraceRecorder` never offers
the bytes to anything, and **no file and no directory is created on disk** —
`test/unit/telemetry/trace-retention.test.ts` asserts that against the real
filesystem.

When the user opts in:

1. Bytes are redacted first (`privacy.rawLogging.redactBeforeWrite` is a
   schema `const: true`; it cannot be turned off). The global redactor runs,
   then the project's own `denyPatterns` via `OutboundPolicy.redact`.
2. `prepareRawPayload` then re-checks the result. If a credential shape
   survived, the write is **refused** (`RawPayloadRefusedError`) and the trace
   is still recorded with `rawPayload: null`. A dropped payload is a
   recoverable gap; a leaked one is not.
3. Surviving bytes are written under the existing artifact store at
   `<storage>/artifacts/raw-payloads/<traceId>.json`, never in the user's
   source tree and never at a machine-specific path.
4. The trace records an artifact-root-relative path, content hash, size and
   `expiresAt = writtenAt + privacy.rawLogging.retentionDays`.

## 6. Retention and deletion

| Entry point | Deletes | Used by |
|---|---|---|
| `purgeExpiredRawPayloads` | Raw bytes whose `expiresAt` has passed. | `/korwf purge`, background sweeps. |
| `purgeRawPayloadsNow` | **Every** stored raw payload, expired or not. | `/korwf purge --all` — the PLAN §7 deletion control. |
| `runRetentionSweep` | The above, plus traces older than `storage.artifactRetentionDays`. | `/korwf purge` when raw logging is on. |

Every entry point takes an injected clock, so retention is tested with a fake
clock rather than by waiting.

Purging raw bytes clears the pointer but keeps the trace row, so `/korwf why`
still explains the decision and says the raw payload is gone rather than
pretending it never existed. Because `decision_trace` is write-once, "clearing
the pointer" is a delete-and-reinsert of the identical row with
`rawPayload: null` — there is no UPDATE path for any connection.

Deleting a trace never deletes the `Decision` row it pointed at.

## 7. Commands

- `/korwf why <decision-id|trace-id>` — renders `explainDecision`. Opens the
  store **read-only**, so explaining a decision cannot mutate anything.
- `/korwf purge [--all]` — runs the retention sweep, or deletes every stored
  raw payload. When raw logging is off but payloads survive from an earlier
  opt-in period, the output points at `--all`.

Stage 8 replaces the rendering with a richer UI; the reconstruction logic in
`explainDecision` stays where it is.
