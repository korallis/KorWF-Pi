import { defineConfig } from "vitest/config";

// Two test runners coexist in this repo, deliberately.
//
// Specification issues (#13 state transitions, #14 gates) write executable assertion
// suites with Node's built-in `node:test`, so a spec can be checked with no dependencies
// at all. #19 then introduced vitest for the package's unit tests. Vitest's default glob
// picks up the `node:test` files, cannot find a suite in them, and fails the run — even
// though those files pass under their own runner.
//
// So: vitest owns test/**, except the node:test suites, which `npm test` runs separately
// (see package.json). Do not "fix" this by deleting either runner — both sets of tests
// must keep running.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.mts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/workflow/**"],
  },
});
