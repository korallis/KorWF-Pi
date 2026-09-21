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

- Node.js 22.6 or later (`engines.node` in `package.json`). Required by `node --experimental-strip-types`, which runs the `node:test` specification suites directly from TypeScript.
- A Pi install compatible with `@earendil-works/pi-coding-agent` (peer dependency; see
  `package.json`).

## Storage

KorWF-Pi stores its state under `<project>/.korwf/` by default (overridable by config in
a later issue). This directory is added to the project's `.gitignore` and is never
written to any location outside it.
