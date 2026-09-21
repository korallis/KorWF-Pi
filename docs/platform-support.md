# Platform support

KorWF-Pi is a Pi package (see [packages.md](../PLAN.md) and PLAN §3.J) and inherits Pi's
supported platforms plus Node.js.

| Platform | Status |
| --- | --- |
| Linux | Supported. Primary development and CI platform. |
| macOS | Supported. |
| Windows | Untested. No code path deliberately excludes Windows, but nothing in the
build or test process has been verified there (e.g. path separators in
`src/storage/paths.ts`, worktree and process lifecycle in `src/git/` and
`src/workers/`, once implemented). Treat Windows as unsupported until it has
been verified and this file is updated. |

## Requirements

- Node.js 22.13 or later (`engines.node` in `package.json`). Two features set this floor:
  `node --experimental-strip-types` (22.6), which runs the `node:test` specification
  suites directly from TypeScript, and the built-in `node:sqlite` module, which became
  available without `--experimental-sqlite` in 22.13 and is the store's driver
  ([ADR 0006](adr/0006-sqlite-single-writer.md), issue #23). On 22.6–22.12 `node:sqlite`
  throws `ERR_UNKNOWN_BUILTIN_MODULE` unless the flag is passed, so the package would not
  open its own store.
- A Pi install compatible with `@earendil-works/pi-coding-agent` (peer dependency; see
  `package.json`).

## Storage

KorWF-Pi stores its state under `<project>/.korwf/` by default (overridable by config in
a later issue). This directory is added to the project's `.gitignore` and is never
written to any location outside it.

It holds `korwf.sqlite` (the store), `korwf.lock` (coordinator ownership) and
`artifacts/<attemptId>/` (evidence artifacts with a `manifest.json`). The database is
opened in WAL mode, so `korwf.sqlite-wal` and `korwf.sqlite-shm` appear beside it while a
session is running. `node:sqlite` is used with no native build step, so there is no
platform-specific compilation and nothing to prebuild.
