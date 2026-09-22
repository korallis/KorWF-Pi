/**
 * `src/git/worktree.ts` (issue #70): worktree add/remove/list, and the
 * refusal to ever remove the repository's main tree.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, listWorktrees, removeWorktree, WorktreeError } from "../../../src/git/worktree.ts";
import { makeTestRepo, type TestRepo } from "../../helpers/git-repo.ts";

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

function repo(): TestRepo {
  const r = makeTestRepo("korwf-worktree-");
  repos.push(r);
  return r;
}

describe("addWorktree", () => {
  it("creates a new worktree on a new branch from the given revision", () => {
    const main = repo();
    const path = join(main.path, "..", `wt-${Date.now()}`);
    const created = addWorktree({ repoCwd: main.path, worktreePath: path, branch: "korwf/t1", baseRevision: main.head() });
    try {
      expect(existsSync(path)).toBe(true);
      expect(created.branch).toBe("korwf/t1");
      expect(created.baseRevision).toBe(main.head());
    } finally {
      removeWorktree({ repoCwd: main.path, worktreePath: path, force: true });
    }
  });

  it("refuses when the revision does not exist", () => {
    const main = repo();
    const path = join(main.path, "..", `wt-${Date.now()}`);
    expect(() =>
      addWorktree({ repoCwd: main.path, worktreePath: path, branch: "korwf/t2", baseRevision: "0".repeat(40) }),
    ).toThrow(WorktreeError);
  });

  it("refuses when the target path already exists", () => {
    const main = repo();
    expect(() =>
      addWorktree({ repoCwd: main.path, worktreePath: main.path, branch: "korwf/t3", baseRevision: main.head() }),
    ).toThrow(WorktreeError);
  });
});

describe("removeWorktree", () => {
  it("refuses to remove the repository's main tree", () => {
    const main = repo();
    expect(() => removeWorktree({ repoCwd: main.path, worktreePath: main.path })).toThrow(WorktreeError);
    expect(existsSync(main.path)).toBe(true);
  });

  it("removes a linked worktree it did create", () => {
    const main = repo();
    const path = join(main.path, "..", `wt-${Date.now()}`);
    addWorktree({ repoCwd: main.path, worktreePath: path, branch: "korwf/t4", baseRevision: main.head() });
    removeWorktree({ repoCwd: main.path, worktreePath: path, force: true });
    expect(existsSync(path)).toBe(false);
  });
});

describe("listWorktrees", () => {
  it("lists the main tree plus any linked worktrees", () => {
    const main = repo();
    const path = join(main.path, "..", `wt-${Date.now()}`);
    addWorktree({ repoCwd: main.path, worktreePath: path, branch: "korwf/t5", baseRevision: main.head() });
    try {
      const list = listWorktrees(main.path);
      expect(list.some((w) => w.path === main.path)).toBe(true);
      expect(list.some((w) => w.path === path)).toBe(true);
    } finally {
      removeWorktree({ repoCwd: main.path, worktreePath: path, force: true });
    }
  });
});
