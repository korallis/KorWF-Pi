# Pi model registry: runtime field set and allowlist interaction

Empirical record for issue #10 (PLAN §3.D "Model cards — layer 1" and "Allowlist";
TODO §1). Everything below was captured on 2026-09-21 with Pi 0.86.1 using the throwaway
extension `scripts/probe/model-registry.ts`, run headless:

```bash
KORWF_PROBE_OUT=/tmp/model-registry.json PI_OFFLINE=1 \
  pi --mode rpc --no-session -e scripts/probe/model-registry.ts </dev/null
```

No model request was made; the probe reads `ctx.modelRegistry.getAvailable()`,
`ctx.scopedModels`, `ctx.model`, `ctx.thinkingLevel` at `session_start`, redacts anything
that looks like a URL, hostname, key, or auth header, and calls `ctx.shutdown()`.
The test data is the author's dev machine: 18 available models across two providers,
12 of them behind the proxied `mac-mini` provider (`enabledModels: ["mac-mini/*"]`).

## 1. Field set of a runtime `Model` (`getAvailable()` entries, `scopedModels[].model`, `ctx.model`)

`fieldStats` from the probe, across all 18 entries:

| Field | Type | Present | PLAN §3.D layer 1? | Notes |
|---|---|---|---|---|
| `id` | `string` | 18/18 | yes | Model id as configured (e.g. `gpt-5.5`). Not globally unique — the same id exists under two providers here. Key models by `provider/id`. |
| `provider` | `string` | 18/18 | yes | Present on every runtime entry (the `ProviderModelConfig` docs omit it; runtime adds it). |
| `name` | `string` | 18/18 | yes | Equal to `id` for models.json-defined models (no display name configured). |
| `reasoning` | `boolean` | 18/18 | yes | `true` for all 18 here. |
| `thinkingLevelMap` | `object` (`Record<level, string \| null>`) | 11/18 | yes — **optional** | Absent (undefined) on 7 of the 12 proxied models. Values remap Pi levels to provider strings (`minimal → "low"`), and `null` disables a level (`off: null` on `gpt-6-astra`). Absent map ⇒ Pi's default levels apply unchanged. |
| `input` | `string[]` (`"text"`, `"image"`) | 18/18 | yes | Never empty; `["text"]` or `["text","image"]`. |
| `contextWindow` | `number` | 18/18 | yes | Configured cap, not upstream truth (proxied models: 128000 / 272000). |
| `maxTokens` | `number` | 18/18 | yes | Configured cap (proxied: 16384; direct: 128000). |
| `cost` | `object` `{input, output, cacheRead, cacheWrite, tiers?}` | 18/18 | yes | Object always present. **All four numbers are `0` for every proxied model** — zero is "unknown", not "free" (PLAN §3.D already anticipates this). Direct-provider entries carry real USD/MTok values and may add `tiers[]` (`{inputTokensAbove, input, output, cacheRead, cacheWrite}`). |
| `api` | `string` | 18/18 | no (extra) | e.g. `openai-completions`, `openai-codex-responses`. Useful for compat decisions. |
| `baseUrl` | `string` | 18/18 | no (extra) | **Sensitive** — proxy endpoint. Never log, persist, or surface. Redacted by the probe. |
| `compat` | `object` | 18/18 | no (extra) | Provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsStrictMode`, `maxTokensField`, `supportsToolSearch`, …). Keys vary by provider. |
| `inputLimits` | `object` | 5/18 | no (extra, optional) | Only on image-capable direct models (`{images:{resize:{maxWidth,maxHeight,maxBytes,jpegQuality}}}`). Absent on all proxied models even when `input` includes `"image"`. |
| `promptCache` | — | 0/18 | no | Documented in `ProviderModelConfig` but **absent** on every runtime entry here (treat as optional). |
| `headers` | — | 0/18 | no | Absent on every entry (would be sensitive if present; the probe redacts it). |

**Verdict on PLAN §3.D layer 1:** every named field — `id`, `provider`, `name`, `reasoning`,
`thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`, `cost` — is confirmed present at
runtime, with two qualifications the catalog must handle:

1. `thinkingLevelMap` is optional (`undefined`), so level filtering must default to Pi's
   standard level set when it is missing and must honour `null` as "level unavailable".
2. `cost` is always an object but is all-zero for proxied/local models, so zero cost must be
   modelled as *unknown* for spend policy, never as free.

Other API facts confirmed:

- `ctx.modelRegistry.getAvailable()` is **synchronous** (`getAvailableIsPromise: false`) and
  returns an array. Awaiting it is harmless (closes gap 2 in `docs/pi-integration-map.md`).
- "Available" means configured **and** authenticated: the direct provider appears because
  OAuth credentials exist on this machine; providers without resolvable auth are not listed.
- `ctx.scopedModels[]` entries are `{ model: Model, thinkingLevel?: ThinkingLevel }`; `model`
  has the identical field set above.
- `ctx.thinkingLevel` is the active level string; `ctx.model` is a full `Model`.

## 2. Sample redacted dump (two entries; whole dump is 18 entries)

```json
{
  "probe": "korwf issue #10 model-registry",
  "mode": "rpc",
  "getAvailableIsPromise": false,
  "counts": { "available": 18, "scoped": 12 },
  "active": { "model": { "provider": "mac-mini", "id": "gpt-5.5" }, "thinkingLevel": "medium" },
  "scoped": [
    { "thinkingLevel": null, "model": { "provider": "mac-mini", "id": "claude-fable-5-1" } },
    { "thinkingLevel": null, "model": { "provider": "mac-mini", "id": "gpt-5.5" } }
  ],
  "available": [
    {
      "id": "claude-fable-5-1",
      "name": "claude-fable-5-1",
      "api": "openai-completions",
      "provider": "mac-mini",
      "baseUrl": "<redacted>",
      "reasoning": true,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 128000,
      "maxTokens": 16384,
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsStrictMode": false,
        "maxTokensField": "max_tokens"
      }
    },
    {
      "id": "gpt-6-astra",
      "name": "gpt-6-astra",
      "api": "openai-completions",
      "provider": "mac-mini",
      "baseUrl": "<redacted>",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null, "minimal": "low", "low": "low", "medium": "medium",
        "high": "high", "xhigh": "xhigh", "max": "max"
      },
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 272000,
      "maxTokens": 16384,
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsStrictMode": false,
        "maxTokensField": "max_tokens"
      }
    }
  ]
}
```

(`scoped[].thinkingLevel` serialises as `null` because the probe copies an `undefined`
optional into a JSON object; it is `undefined` at runtime.)

## 3. How `enabledModels` / `--models` scoping behaves

Observed by re-running the probe with different `--models` values (the `enabledModels`
setting uses the same pattern syntax; `--models` overrides it for the process):

| Patterns | `scoped` result | Observation |
|---|---|---|
| *(none; setting `["mac-mini/*"]`)* | 12 of 18 | Provider glob on `provider/id`. Only the setting's provider is scoped. |
| `mac-mini/gpt-*:high` | 5, each `thinkingLevel: "high"`; active level became `high` | `:level` suffix pins a level per pattern and is applied to the startup model. |
| `gpt-5.5` (bare id) | 1 — the **direct** provider's `gpt-5.5`, not the proxied one | A bare id matches by id across all providers, but yielded only the first provider's copy. Bare ids are ambiguous when ids collide; **always use `provider/id`**. |
| `*/gpt-5.5` | 2 — both providers' `gpt-5.5` | Provider glob does match across providers. |
| `gpt-5.*` | 9 across both providers | Bare glob matches both providers' ids. |
| `mac-mini/kimi-k3,mac-mini/gpt-6-astra:max` | 2; only the second has `thinkingLevel: "max"` | Comma-separated list; per-pattern pins. |
| `nonexistent/*` | 0, plus a stderr `Warning: No models match pattern` | Empty scope **does not** fail startup; `scopedModels = []`, which Pi treats as "no scoping ⇒ all available models usable". |

Consequences for KorWF:

- `scopedModels` is a **subset of `getAvailable()`** — it never adds models; it only
  narrows what Pi's picker/cycling offers and can pin a thinking level.
- `scopedModels.length === 0` is ambiguous at the API level (means either "not configured"
  or "configured but matched nothing"). Pi treats both as "everything available". KorWF
  must **not** treat an empty scope as "no restriction" if it came from a configured
  pattern that matched nothing; see the composition rule.
- Scope is resolved once at session start; `ctx.scopedModels` does not change after
  `/model` switches. Re-read it in `session_start`.
- Pattern-pinned levels are a *hint* on the entry, not a cap: `pi.setThinkingLevel` can
  still change the level. KorWF should treat a pinned level as the default for that model
  and never exceed a level the `thinkingLevelMap` marks `null`.

## 4. Allowlist composition rule

```
eligible = configured ∩ enabledModels ∩ allowlist
```

where, in Pi terms:

| Term | Source | Semantics |
|---|---|---|
| `configured` | `ctx.modelRegistry.getAvailable()` | Models Pi has a definition **and resolvable auth** for. |
| `enabledModels` | `ctx.scopedModels` (from `enabledModels` setting ∪ `--models`) | If non-empty, the user's Pi-level scope. If empty, equals `configured` (Pi's own rule) — **except** that KorWF must consult the raw `enabledModels`/`--models` patterns: if patterns are set but matched nothing, KorWF treats the scope as empty, not as everything. |
| `allowlist` | KorWF config (`models.allowlist`, patterns in the same `provider/id` minimatch syntax) | Optional. Absent ⇒ identity (all of `configured ∩ enabledModels`), per PLAN §3.D "Default: all configured models". |

Rules and deviations, all in the conservative direction:

1. **Pure intersection; nothing widens.** The allowlist can never add a model Pi has not
   configured or the user has scoped out. KorWF never calls `pi.setModel` / `streamSimple`
   with a model outside `eligible` (PLAN §3.D "never uses a provider or model outside the
   allowlist"; AGENTS §4 "never weakens its own allowlist").
2. **Key by `provider/id`, never bare id.** Bare ids collide across providers (shown above),
   and a bare-id match silently picked a different provider than the user's default. KorWF's
   allowlist patterns are matched against `provider/id` only; a bare pattern without `/` is
   treated as `*/<pattern>` and logged as ambiguous.
3. **Empty result is a hard stop, not a fallback.** If `eligible` is empty, KorWF reports the
   three sets and stops; it does not fall back to `ctx.model` or to `configured`.
4. **Empty scope from a non-matching pattern is empty.** Deviation from Pi's own behaviour
   (Pi widens to all models with only a warning). Rationale: a configured restriction that
   matches nothing is a configuration error, and widening would weaken policy.
5. **Thinking level.** The effective level for a model is
   `min(allowlist pin, scopedModels pin, requested level)` restricted to levels not `null`
   in `thinkingLevelMap`. A `:level` in the KorWF allowlist caps; a `:level` in
   `enabledModels` is the default; neither is ever raised by KorWF.
6. **Cost `0` is unknown.** Proxied models report all-zero `cost`; spend policy must treat
   these as unpriced (require explicit per-model cost in a layer-2 model card before any
   spend limit is considered satisfied), not as free.
7. **Dev policy (PLAN §11, AGENTS §4)** is implemented entirely by this rule: the author's
   `enabledModels: ["mac-mini/*"]` plus a matching KorWF allowlist entry yields the 12
   proxied models. No provider name is hardcoded in shipped code.

## 5. Sensitive fields — handling

`baseUrl` (always present) and `headers` (possible) are the only sensitive fields on a
`Model`. Any KorWF code that logs, persists (SQLite/artifacts), or shows a `Model` must
strip or redact them; the catalog (Stage 5) should copy only the layer-1 fields listed in §1
into model cards. `ctx.modelRegistry.getProviderAuth()` output is never stored.
