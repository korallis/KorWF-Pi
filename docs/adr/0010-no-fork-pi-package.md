# ADR 0010 — KorWF ships as a Pi package; Pi is never forked or patched

- **Status:** Accepted (Stage 1, issue #17).
- **Date:** 2026-09-21
- **Design authority:** PLAN §4 "Modular TypeScript Pi package, no fork."; §3.J
  "Distributed as a Pi package per `docs/packages.md`; install/upgrade/disable/uninstall
  through Pi's mechanism"; §4 "Pi integration surfaces to validate".
- **Related:** ADR 0001 (examples are copied with attribution, not depended on), ADR 0002
  (`extension/` is the only module importing `ExtensionAPI`), ADR 0004 (workers are
  stock `pi --mode rpc` processes), `docs/pi-integration-map.md` (every Pi surface KorWF
  relies on, with its documented contract), `docs/threat-model.md` §7 (Pi's own trust
  model is out of scope because it is not modified).

## Context

Some of PLAN's requirements press against Pi's public surface: per-worker policy
inside `tool_call` (the event does not expose the issuing message id —
`docs/pi-integration-map.md` §6 item 5), extensions compiled into the binary that
survive `--no-extensions` (ADR 0004, threat-model R6), no per-extension unload, no
sibling tool results in parallel gates. Each is a temptation to patch Pi, vendor a
modified build, or monkey-patch internals at load time.

The cost of doing so is structural: a fork must track every Pi release (0.86.0 → 0.86.1
happened during Stage 1); users install Pi themselves and would need *our* Pi; a
patched runtime invalidates Pi's own security documentation (`docs/security.md`) that
the threat model relies on; and packages.md's install/upgrade/disable/uninstall path
only works for unmodified Pi.

## Decision

**KorWF is a standard Pi package (`package.json` → `pi.extensions`) that uses only the
documented extension, TUI, RPC and SDK surfaces of an unmodified Pi install.** No fork,
no vendored Pi, no patching of `@earendil-works/*` at runtime, no reliance on
undocumented internals.

### Rules

1. **Surface allowlist.** Everything KorWF calls in Pi is listed in
   `docs/pi-integration-map.md` with the document that specifies it. Using a Pi API not
   in that map requires adding it there in the same PR, citing Pi's docs; using
   something Pi's docs do not describe is a review failure.
2. **One import boundary.** Only `src/extension/` imports
   `@earendil-works/pi-coding-agent`'s `ExtensionAPI`; domain modules receive
   capabilities as injected interfaces (ADR 0002). Workers are launched as plain `pi`
   processes with documented flags (ADR 0004); KorWF never spawns a modified binary.
3. **Version pinning, not modification.** `package.json` declares the Pi version range
   KorWF is tested against; `docs/pi-integration-map.md` records the version examined.
   A Pi upgrade is handled by re-validating the map, never by patching Pi to keep old
   behaviour.
4. **Gaps are handled on our side or raised upstream.** When a documented surface is
   insufficient, the options are, in order: (a) implement the need in KorWF using what
   exists (e.g. correlate `tool_call` to a worker via the RPC process identity rather
   than a message id); (b) record it as a residual risk in the threat model with a
   mitigation; (c) open an upstream issue/PR against Pi and track it in TODO.md. Never
   (d): patch, fork, or reach into internals.
5. **No session-wide side effects the user did not ask for.** KorWF does not replace
   built-in tools (the reason `sandbox/` is not bundled, ADR 0001 row 3), does not
   register providers, and namespaces everything `korwf` (ADR 0002). Disabling the
   package (`pi` package mechanism) leaves the user's Pi exactly as it was, plus the
   `.korwf/` store on disk.
6. **Examples are copied, never imported.** ADR 0001's copy manifest and attribution
   headers stand; the examples directory is not a dependency (it is not published).
7. **Trust model inherited unchanged.** Project trust (`ctx.isProjectTrusted()`),
   extension discovery and the "extensions run as the user" rule are Pi's; the threat
   model relies on them precisely because KorWF does not alter them.

## Consequences

- Install is `pi install <package>` (or the documented npm/git forms); upgrade,
  disable and uninstall are Pi's; `docs/platform-support.md` states OS support in
  terms of Pi's.
- Known Pi limitations become explicit residuals (threat-model R6) or KorWF-side
  workarounds, both visible in docs, rather than invisible patches.
- Stage 2 (#19) validates that `npm pack` of this repository produces a package Pi loads
  with `--no-extensions -e <package>` and that nothing in `dist/` references Pi
  internals outside the map.
- If Pi ever ships a capability KorWF re-implemented (e.g. a per-extension unload or a
  `tool_call` message id), the map is updated and the KorWF code retired — the boundary
  in rule 2 makes that local.
EOF
git add -A && git commit -qm "docs(adr): 0010 no-fork Pi package (#17)" && echo ok