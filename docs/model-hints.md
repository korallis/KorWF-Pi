# Bundled aptitude hints

**Issue:** #58 · **Design authority:** PLAN.md §3.D "Model cards", layer 2.

## What this is

`resources/hints.json` is a small, shipped, versioned file mapping model
*families* — matched by an id **pattern**, not an exact id — to short
aptitude descriptions (front-end/UI, deep reasoning, large refactors, tool
use, speed, ...). `src/models/hints.ts` loads it and resolves it into the
`HintLookup` that `src/models/cards.ts` (#57) merges as layer 2 of the
four-layer model card.

## Hints are advisory, never exclusionary

This is the rule PLAN §3.D states and #57's merge enforces: **registry
metadata excludes candidates; hints, overrides, and outcomes rank them.**
`hints.ts` has no path to remove a model from the catalog or from Jev's
candidate set — it can only attach (or fail to attach) an aptitude tag to a
model that #56's catalog already admitted. An id that matches no pattern
gets no hint at all, which #57 renders as `rated: false` — an explicit
"unrated" card, never a fabricated aptitude, so Jev can see the gap and
falls back to the static order (`fallback.staticOrder`) for that model.

## Why pattern matching, not exact ids

A user who proxies `claude-sonnet-5` under a name of their own choosing
(their Pi provider config might expose it as `mycorp/sonnet` or anything
else) must still get Claude's family hints — the hint file cannot enumerate
every possible proxy name. So matching happens against the **bare model
id**, after two normalisations (`normalizeForMatch` in `hints.ts`):

1. **Strip the provider prefix.** `provider/model-id` → `model-id`. The
   provider segment is never matched against — it is the one part of the id
   a user is guaranteed to have renamed.
2. **Strip cosmetic suffixes.** Release dates (`-2025-06-20`, `-20250620`),
   quantisation/build tags (`-q4_k_m`, `-int8`, `-gguf`, `-awq`, ...), and
   generic markers (`-latest`, `-preview`, `-instruct`, `-chat`, `-base`) are
   stripped repeatedly from the end, so `llama-3-70b-q4_k_m-latest` still
   matches the `llama` family pattern.

Each shipped entry's `pattern` is then tested (case-insensitively) as a
regular expression against what remains. First match in file order wins;
entries are kept few and broad on purpose so collisions are rare and easy to
spot in review.

## File shape

```json
{
  "version": 1,
  "entries": [
    {
      "pattern": "claude",
      "family": "Claude",
      "aptitudes": ["deep-reasoning", "large-refactors", "tool-use"],
      "caveats": ["Slower and costlier than lighter models for simple, small edits."]
    }
  ]
}
```

- `pattern` — a JS regular expression source, matched case-insensitively
  against the normalised bare id (see above). Keep patterns broad
  (`"claude"`, not `"claude-sonnet-5-20250929"`) so proxied and future
  variants of a family still match.
- `family` — short, human-readable family name, surfaced as the aptitude's
  `detail` in the merged card.
- `aptitudes` — short tag strings (`front-end-ui`, `deep-reasoning`,
  `large-refactors`, `tool-use`, `speed`, `large-context`, ...). Free text,
  but keep the vocabulary small and reuse existing tags rather than
  inventing near-duplicates.
- `caveats` — optional, free-text limitations worth surfacing alongside the
  aptitude (e.g. "slower for small edits").

## Validation and failure behaviour

`hints.ts` validates the parsed file's structure before using it
(`validateHintsFile`): `version` must be a positive integer, `entries` an
array of objects each with a non-empty `pattern` that compiles as a regex, a
non-empty `family`, and a string array `aptitudes` (`caveats`, if present,
must also be a string array). A missing file, unparsable JSON, or a
structural violation does **not** throw — `loadHints()` returns
`{ enabled: false, disabledReason }`, and every model is then `unrated` by
this layer (#57's merge is unaffected; user overrides and outcomes still
rank normally). This mirrors the rest of the package's rule that a
deterministic check degrades visibly rather than crashing the session.

## Proposing an update

1. Add or edit an entry in `resources/hints.json`. Keep the pattern as broad
   as the family genuinely is — over-narrow patterns (pinned to one dated
   release) are the most common way a hint silently stops matching.
2. Never reference a specific provider name, hostname, or a personal/local
   proxy alias (e.g. the author's own proxy id) in the shipped file — those
   are machine- and account-specific (PLAN §2.4) and belong in a user's own
   `models.overrides`, not here.
3. Add the new id(s) to the pattern test table in
   `test/models/hints.test.ts`, including at least one proxied/renamed form,
   and run `npm test -- hints`.
4. Bump `version` only when the *shape* of an entry changes in a
   backward-incompatible way (adding a new optional field does not require
   a bump; changing `pattern`'s semantics would).
5. Keep the file small. This is a coarse, low-maintenance signal — not a
   benchmark database. When there is real evidence about how a specific
   model performs, that belongs in measured outcomes (layer 4), not here.

## Review rules

- No exact/dated model ids as patterns — family-level patterns only.
- No provider hostnames, API endpoints, or credentials.
- No machine- or account-specific aliases (the file ships to every user).
- Every new/changed entry needs a row in the pattern test table.
- Hints only ever add an aptitude tag; a PR that makes `hints.ts` capable of
  excluding a model from the catalog or from Jev's candidates is out of
  scope for this file and violates PLAN §3.D.
