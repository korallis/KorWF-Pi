/**
 * `src/git/status.ts` (issue #33): repository identity detection.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { detectRepoIdentity, normaliseRemoteUrl, type GitRunner } from "../../../src/git/status.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const dirs: TempDir[] = [];
afterEach(() => {
  while (dirs.length > 0) dirs.pop()?.cleanup();
});

function initRepo(): string {
  const dir = makeTempDir("korwf-git-");
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir.path });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir.path });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir.path });
  return dir.path;
}

describe("AC1/AC2: detectRepoIdentity distinguishes existing repo from greenfield", () => {
  it("reports greenfield for a directory with no git repo at all", () => {
    const dir = makeTempDir("korwf-empty-");
    dirs.push(dir);
    const result = detectRepoIdentity(dir.path);
    expect(result.kind).toBe("greenfield");
  });

  it("reports greenfield for a git repo with zero commits", () => {
    const repo = initRepo();
    const result = detectRepoIdentity(repo);
    expect(result.kind).toBe("greenfield");
  });

  it("reports existing with the correct base revision once a commit exists", () => {
    const repo = initRepo();
    execFileSync("git", ["commit", "--allow-empty", "-m", "root", "-q"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const result = detectRepoIdentity(repo);
    expect(result.kind).toBe("existing");
    if (result.kind === "existing") {
      expect(result.identity.rootCommit).toBe(head);
      expect(result.identity.remoteUrl).toBeNull();
      expect(result.dirty).toBe(false);
    }
  });

  it("reports dirty:true without blocking, when the working tree has changes", () => {
    const repo = initRepo();
    execFileSync("git", ["commit", "--allow-empty", "-m", "root", "-q"], { cwd: repo });
    execFileSync("node", ["-e", `require("fs").writeFileSync(process.argv[1], "x")`, `${repo}/dirty.txt`]);
    const result = detectRepoIdentity(repo);
    expect(result.kind).toBe("existing");
    if (result.kind === "existing") expect(result.dirty).toBe(true);
  });

  it("uses an injected GitRunner instead of spawning a real process", () => {
    const calls: string[][] = [];
    const fakeRunner: GitRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return "/repo";
        if (args[0] === "rev-parse" && args.includes("HEAD")) return "a".repeat(40);
        if (args[0] === "remote") return "https://example.com/repo.git";
        if (args[0] === "status") return "";
        throw new Error("unexpected");
      },
    };
    const result = detectRepoIdentity("/anywhere", fakeRunner);
    expect(result.kind).toBe("existing");
    if (result.kind === "existing") {
      expect(result.identity.rootCommit).toBe("a".repeat(40));
      expect(result.identity.remoteUrl).toBe("https://example.com/repo.git");
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("normaliseRemoteUrl strips embedded credentials", () => {
  it("removes user:pass from an https remote", () => {
    expect(normaliseRemoteUrl("https://user:secret@example.com/repo.git")).toBe(
      "https://example.com/repo.git",
    );
  });

  it("leaves an scp-style remote untouched (no credentials to strip)", () => {
    expect(normaliseRemoteUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });

  it("returns null for null input", () => {
    expect(normaliseRemoteUrl(null)).toBeNull();
  });
});
