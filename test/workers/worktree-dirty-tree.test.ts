/**
 * #70 AC2: "User's dirty file in main tree unchanged after a full worker
 * run (hash compare)."
 *
 * This drives a real repository, a real attempt worktree created by
 * `src/workers/worktree.ts`, and a real worker subprocess (the same
 * `fake-pi.mjs` fixture #68's tests use) that writes and commits a file
 * *inside its own worktree*. The property under test is what is on disk in
 * the user's main tree afterwards, so nothing here is stubbed.
 */
import { spawn as spawnReal } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { draftToContract, type ContractPolicy } from "../../src/workers/contract.ts";
import { spawnWorker, type WorkerHandle } from "../../src/workers/spawn.ts";
import { createAttemptWorktree, removeAttemptWorktree } from "../../src/workers/worktree.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";
import { makeTestRepo, type TestRepo } from "../helpers/git-repo.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const ALLOWED: ModelRef = "provider-a/model-one";
const allowlist: ModelAllowlist = { providers: [], models: [ALLOWED], pins: {} };
const policy: ContractPolicy = { allowlist };

function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const repos: TestRepo[] = [];
const live: WorkerHandle[] = [];
afterEach(async () => {
  for (const handle of live.splice(0)) {
    if (handle.exit === undefined) await handle.cancel("test cleanup");
  }
  while (repos.length > 0) repos.pop()?.cleanup();
});

describe("AC2: a full worker run leaves the user's dirty main-tree file untouched", () => {
  it("preserves an uncommitted file in the main tree, byte for byte", async () => {
    const main = makeTestRepo("korwf-dirty-worktree-");
    repos.push(main);

    // The user's own uncommitted work in the main tree.
    const dirtyPath = `${main.path}/user-wip.txt`;
    writeFileSync(dirtyPath, "the user's uncommitted work\n");
    const before = hashOf(dirtyPath);

    // The worktree a worker attempt runs in: created from the base revision,
    // never from the (dirty) live HEAD of the main tree.
    const attemptId = "attempt-1";
    const worktree = createAttemptWorktree({
      projectRoot: main.path,
      attemptId,
      baseRevision: main.head(),
    });

    try {
      const contract = draftToContract({
        workerId: "w1",
        role: "implementer",
        task: "write a file in the worktree",
        cwd: worktree.path,
        model: ALLOWED,
      });
      const handle = await spawnWorker(contract, {
        policy,
        piBin: process.execPath,
        spawnFn: ((bin: string, args: readonly string[], opts: Record<string, unknown>) =>
          spawnReal(bin, [FAKE_PI, ...args], opts)) as never,
      });
      live.push(handle);

      // The worker does its work entirely inside its own worktree.
      writeFileSync(`${worktree.path}/worker-output.txt`, "produced by the worker\n");
      await handle.call({ type: "prompt", message: "do the task" }, 15_000);
      await handle.cancel("attempt complete");

      // The user's dirty file in the main tree is untouched: same bytes.
      expect(existsSync(dirtyPath)).toBe(true);
      expect(hashOf(dirtyPath)).toBe(before);
      // And the main tree's HEAD did not move.
      expect(main.head()).toBe(worktree.baseRevision);
      // The worker's output landed in its own worktree, not the main tree.
      expect(existsSync(`${worktree.path}/worker-output.txt`)).toBe(true);
      expect(existsSync(`${main.path}/worker-output.txt`)).toBe(false);
    } finally {
      removeAttemptWorktree({ projectRoot: main.path, attemptId, force: true });
    }
  });
});
