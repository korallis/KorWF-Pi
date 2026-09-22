/**
 * Real-git fixture for the session-reconciliation tests (issue #42).
 *
 * `src/git/` is the only module allowed to run git, and reconciliation is
 * about *live* repository state, so these tests drive an actual repository in
 * a temp directory rather than a stubbed runner. Nothing here touches the
 * user's project tree or any configured identity: the repo gets its own
 * local `user.name`/`user.email`.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, type TempDir } from "./temp-dir.ts";

export interface TestRepo {
  readonly path: string;
  readonly cleanup: () => void;
  git(...args: string[]): string;
  head(): string;
  /** Write a file and commit it; returns the new HEAD. */
  commitFile(relativePath: string, contents: string, message: string): string;
  /** Write a file without committing, so the tree is dirty. */
  writeDirty(relativePath: string, contents: string): void;
}

/** Create a temp git repository with one root commit. */
export function makeTestRepo(prefix = "korwf-repo-"): TestRepo {
  const dir: TempDir = makeTempDir(prefix);
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "KorWF Test");
  git("config", "commit.gpgsign", "false");

  const repo: TestRepo = {
    path: dir.path,
    cleanup: dir.cleanup,
    git,
    head: () => git("rev-parse", "HEAD"),
    commitFile(relativePath, contents, message) {
      writeFileSync(join(dir.path, relativePath), contents);
      git("add", relativePath);
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },
    writeDirty(relativePath, contents) {
      writeFileSync(join(dir.path, relativePath), contents);
    },
  };

  repo.commitFile("README.md", "root\n", "root commit");
  return repo;
}
