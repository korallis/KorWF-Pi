/**
 * Test support for `test/unit/context/`: builds a throwaway git repo from
 * `test/fixtures/repo-basic/` plus a `.env` file written at test time (the
 * fixture directory itself cannot carry a real `.env` — `.gitignore` would
 * exclude it from the repo, and shipping a credential-shaped file is exactly
 * what AGENTS.md §4 forbids). The temp copy is a real git repo so
 * `currentRevision`/`ageDaysOf` behave exactly as they do on a real project.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_SRC = join(process.cwd(), "test/fixtures/repo-basic");

export interface TestRepo {
  readonly root: string;
  readonly revision: string;
  cleanup(): void;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Copy the fixture repo into a temp dir, git-init it, add a fake `.env`, commit. */
export function buildTestRepo(): TestRepo {
  const root = mkdtempSync(join(tmpdir(), "korwf-context-"));
  cpSync(FIXTURE_SRC, root, { recursive: true });
  writeFileSync(join(root, ".env"), "SECRET_KEY=do-not-send-me\n"); // check-secrets:allow

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture commit"]);
  const revision = git(root, ["rev-parse", "HEAD"]);

  return {
    root,
    revision,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
