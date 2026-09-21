# ADR 0012 — Test harness, formatter, and CI toolchain

- **Status:** Accepted (Stage 2, issue #20).
- **Date:** 2026-09-21
- **Design authority:** PLAN §8 Stage 2 "Package and adapter foundation" — "test harness"
  as a Stage 2 deliverable, exit criterion "loads in an isolated Pi session; offline
  tests pass; works with no Jev key; failures cannot hang Pi or leak credentials."
- **Related:** ADR 0002 (source layout: `test/unit/`, `test/integration/`,
  `test/scenarios/` mirror `src/`); #13/#14 (specification suites that predate this
  ADR and fixed the two-runner split); #19 (introduced `vitest.config.ts` and the
  `npm test` script this ADR extends, not replaces).

## Context

By the time this issue landed, #13 and #14 had already shipped executable
specification suites (`test/workflow/*.test.mjs`, `*.types.test.ts`) using Node's
built-in `node:test`, deliberately zero-dependency so a specification can be checked
without `npm install`. #19 then added `vitest` for the package's regular unit tests
and wired `npm test` to run both (`vitest run && npm run test:spec`). This ADR records
and completes the rest of the Stage 2 toolchain: a formatter, a linter, a helpers
module, and CI — without disturbing that split.

Dependency ceiling: PLAN §8 Stage 2 requires dependencies stay within the M0-approved
list. No M0 dependency-approval decision has been recorded as of this issue (`docs/
decisions/` has no dependency-list ADR), so this issue adds only devDependencies
already present in `package.json` from #19 (`vitest`, `eslint`,
`@typescript-eslint/*`, `prettier`, `typescript`) plus a flat ESLint config file,
which is configuration, not a new dependency.

## Decision

1. **Two test runners, unchanged.** `vitest` owns `test/**/*.test.ts` /
   `test/**/*.test.mts` except `test/workflow/**`; `node:test` owns
   `test/workflow/*.test.mjs` and `*.test.ts` via `npm run test:spec`. `npm test` runs
   both and fails if either fails. This issue adds `test/integration/` (vitest, real
   `node:fs` I/O against `src/storage/paths.ts`) and `test/helpers/` (vitest unit
   tests for the helpers themselves) under the same vitest scope — no changes needed
   to `vitest.config.ts`'s include/exclude globs.
2. **Formatter: Prettier**, already a devDependency from #19. No project config file
   is added in this issue beyond what ships with Prettier's defaults; `npm run
   format` (`prettier --write .`) is left as-is. Existing source is **not**
   reformatted in this PR — doing so would touch every file in the repository outside
   this issue's scope (AGENTS.md §3 "keep the scope to what the issue says"). A
   follow-up issue should run `prettier --write .` repo-wide in its own PR so the
   diff is reviewable as a formatting-only change.
3. **Linter: ESLint 9 (flat config)**, already a devDependency from #19 but with no
   `eslint.config.js` — `npm run lint` failed outright before this issue. Added a
   minimal flat config (`eslint.config.js`) scoped to `src/**/*.ts`, `test/**/*.ts`,
   `scripts/**/*.ts`, using `@typescript-eslint`'s recommended rules. Two narrow,
   documented exceptions were needed to make `npm run lint` pass on the *existing*
   codebase without weakening rules elsewhere:
   - `test/**/*.types.test.ts` (the #13/#14 type-level assertion suites) disables
     `no-unused-vars`: these files declare types purely so `tsc` fails the build if a
     invariant is violated; the types are never referenced at runtime by design.
   - `scripts/probe/**/*.ts` and `test/config/schema.test.ts` disable
     `no-explicit-any`: probe scripts dump arbitrary RPC payloads for manual
     inspection (Stage 1, out of this issue's scope to retype), and the schema test
     exercises `Ajv`'s untyped validator output.
   No pre-existing file needed edits to satisfy lint; only these narrow exceptions.
4. **`tsc --strict`, unchanged** from #19 (`tsconfig.json`): `strict`,
   `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
   `noFallthroughCasesInSwitch`. `npm run typecheck` and `npm run build` already
   passed cleanly before this issue; this issue changes neither.
5. **`test/helpers/`**: a temp-dir fixture (`makeTempDir`/`withTempDir`, real
   `node:fs`, guaranteed cleanup via `try/finally` even on throw) and a fake clock
   (`FakeClock` with `advance()`/`set()`, plus `systemClock` for production code).
   Both are unit-tested themselves (`test/helpers/*.test.ts`) so the fixtures are
   trustworthy before other suites depend on them.
6. **CI: GitHub Actions**, `ubuntu-latest` and `macos-latest`, Node 22, running
   `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and
   `bash scripts/check-secrets.sh` on every push and pull request. No Jev key or any
   other secret is required or read — the workflow has no `secrets:` block, satisfying
   "works with no Jev key" for CI itself.
7. **Secret scan: `scripts/check-secrets.sh`**, dependency-free (`bash` + `git` +
   `grep` only), matching `apikey_`, `sk-<10+ alnum>`, `ghp_<10+ alnum>`, and
   `JEV_API_KEY=` (word-bounded so it does not false-positive on doc references like <!-- check-secrets:allow -->
   `task-submit`). Supports scanning tracked files (default, used in CI), the git
   index (`--staged`, for local pre-commit use), or a commit range (`--range A..B`).
   A single-line `# check-secrets:allow` opt-out exists for documentation that
   legitimately names the patterns themselves (used once, in `scripts/issues/m2.mjs`,
   which describes this very scan).

## Consequences

- `npm test` now runs 70 vitest tests (13 files, including the new helpers and
  integration suite) plus 20 `node:test` assertions (2 files) — both counted and
  both must pass for `npm test` to exit 0.
- `npm run lint` is enforceable in CI going forward; new code that violates
  `@typescript-eslint`'s recommended rules fails the build, not just a human review.
- The formatting gap (existing files not yet Prettier-clean) is tracked, not hidden:
  CI does not run `prettier --check`, so unformatted legacy files do not block PRs
  until a dedicated formatting PR lands. A later issue should add `prettier --check
  .` to CI once that PR merges; recorded here so it isn't silently forgotten.
- `check-secrets.sh`'s patterns are intentionally loose (fine to false-positive on a
  real-looking string in a comment; not fine to miss a real key). Anyone hitting a
  false positive uses `# check-secrets:allow` on that line, which is visible in
  review — the check cannot be silently disabled per-file or per-repo.
