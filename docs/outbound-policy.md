# Outbound data policy

*Implements PLAN §7 "Data policy" and PLAN §6 "minimal relevant state per
evaluation". Code: `src/security/outbound.ts`, `src/security/deny-list.ts`
(issue #28), on top of the redactor (`src/security/redact.ts`, #22) and the
`privacy` config section (`src/config/schema.json`, #21).*

## 1. One enforcement point

Everything bound for TypeSafe or a model provider passes through
`OutboundPolicy`. There is no second path: `JevTransport.evaluate` accepts a
`FilteredRequest`, a branded type that only `OutboundPolicy.filterRequest` can
mint, so sending an unfiltered request does not compile.

```ts
const policy = new OutboundPolicy(config);
const filtered = policy.filter({ state, snippets, paths }, { purpose: "jev.decision" });
// filtered.report says exactly what was removed, truncated and redacted.
```

`src/decisions/ask.ts` applies the policy on every request. A caller that
passes no policy gets `defaultOutboundPolicy()` — the shipped defaults, which
are the *strictest* configuration, because project config can only add deny
entries, never remove them. Forgetting to pass a policy therefore cannot
weaken the policy.

## 2. Order of operations

Fixed, and the order matters:

1. **Minimal state.** Only the fields a question names (`pick`) are built into
   its state at all.
2. **Default-deny paths.** Denied paths are refused on identity, before their
   content is looked at.
3. **Redaction.** Registered literal secrets, credential shapes, and the
   configured `privacy.denyPatterns`.
4. **Byte caps.** Per snippet, then per request.

Redaction before truncation means a truncated snippet cannot end mid-secret.
Truncation last means the request cap is measured on exactly what is sent.

## 3. Default-deny paths

The shipped minimum lives in `schema.json` `$defs/ShippedDenyPaths`, pinned by
`const`, and is documented entry by entry in `SHIPPED_DENY_PATH_NOTES`.
`assertDenyListDocumented()` runs at module load, so an entry can never be
added to the schema without a reason being written next to it, nor removed
from the schema while the code still documents it.

Beyond the globs, three structural refusals apply:

| Rule | What it refuses | Why |
| --- | --- | --- |
| `shipped` | A shipped-minimum glob matched. | PLAN §7 floor; `allowPaths` cannot relax it. |
| `config` | A user-added `denyPaths` glob matched. | Project policy; `allowPaths` *can* carve this out. |
| `absolute` | `/x`, `C:/x`, `~/x`. | An absolute path leaks the user's directory layout; `sendFilePaths` documents that absolute paths are never sent. |
| `traversal` | Any `..` segment. | A path that escapes the project is not project state. |

A path is matched both as given and as each of its trailing sub-paths, so a
glob written for a project-relative path still catches the same file named
from another root.

An object that *names* a denied file is dropped whole, siblings included:
`{ path: ".env", text: "…" }` leaves nothing behind, because keeping the
content and dropping only the label would be the worst of both.

## 4. Size limits

From `privacy.outbound`:

- `maxSnippetBytes` — per snippet. Over it, the snippet is truncated, a
  `[truncated]` marker is appended, and `report.truncated` records
  `keptBytes` and `droppedBytes`.
- `maxSnippetsPerRequest` — excess snippets are removed with reason
  `over_budget`.
- `maxRequestBytes` — measured on the serialised payload. Whole snippets are
  dropped from the end first (a partial snippet is worth less than a complete
  one); only if nothing is left to drop is the state itself truncated.
- `sendFilePaths: false` — paths never leave the process; snippets still go,
  identified only by position.

`OutboundPolicy` also takes per-purpose overrides
(`maxRequestBytesByPurpose`), so a cheap probe can be capped harder than a
decision without changing the user's config.

## 5. The report

`OutboundReport` carries counts, paths and reasons — never removed content —
so it is safe to log, to store, and to attach to a decision trace. It answers:
what was dropped and why, what was truncated and by how many bytes, how many
strings the redactor changed, how many bytes actually went out.

`report.clean === true` means nothing was removed, truncated or redacted:
the payload went out exactly as the caller built it.

## 6. Failure behaviour

Nothing in this module throws on caller data. Cycles, getters that throw,
`BigInt`, functions and symbols are all dropped and counted as `unsupported`.
A deny pattern that fails to compile is skipped and reported through
`invalidPatterns`; the shipped patterns and the global redactor still apply,
so a bad pattern degrades towards *more* redaction, never less. A filter that
threw would push callers towards a bypass, and there is no bypass.
