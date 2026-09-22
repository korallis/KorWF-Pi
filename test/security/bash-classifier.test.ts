/**
 * Issue #69 — the bash route specifically.
 *
 * PLAN §7 names `bash` first among the mutation routes. The upstream
 * `plan-mode` classifier (ADR 0001 row 2) anchors its allowlist at the start
 * of the whole command, so `ls && <anything>` passes whenever the denylist
 * happens not to name the second command. These tests pin the difference.
 */
import { describe, it, expect } from "vitest";
import {
  DESTRUCTIVE_RULES,
  SAFE_PATTERNS,
  classifyCommand,
  isSafeCommand,
  splitSegments,
} from "../../src/security/bash-classifier.ts";

describe("read-only commands are recognised", () => {
  const safe = [
    "ls -la",
    "cat README.md",
    "grep -rn foo src",
    "rg --files",
    "find . -name '*.ts'",
    "head -n 20 package.json",
    "wc -l src/a.ts",
    "git status",
    "git log --oneline -20",
    "git diff HEAD~1",
    "git show abc123",
    "sed -n '1,10p' src/a.ts",
    "jq .name package.json",
    "npm ls --depth 0",
    "cat a.ts | grep foo | sort | uniq",
    "NODE_ENV=test ls",
  ];
  for (const command of safe) {
    it(`allows: ${command}`, () => {
      const verdict = classifyCommand(command);
      expect(verdict.safe, `${command} -> ${verdict.rule}: ${verdict.reason}`).toBe(true);
      expect(isSafeCommand(command)).toBe(true);
    });
  }
});

describe("every way of writing a file through bash is refused", () => {
  const mutating: readonly [string, string][] = [
    ["echo x > f", "redirect"],
    ["echo x >> f", "redirect-append"],
    ["cat a 2> b", "redirect-fd"],
    ["echo x | tee f", "tee"],
    ["echo x | tee -a f", "tee"],
    ["sed -i 's/a/b/' f", "sed-in-place"],
    ["sed --in-place 's/a/b/' f", "sed-in-place"],
    ["perl -i -pe 's/a/b/' f", "perl-in-place"],
    ["cp a b", "cp"],
    ["mv a b", "mv"],
    ["rm -rf f", "rm"],
    ["rmdir d", "rmdir"],
    ["mkdir -p d", "mkdir"],
    ["touch f", "touch"],
    ["install -m 755 a /usr/local/bin/a", "install"],
    ["ln -s a b", "ln"],
    ["truncate -s 0 f", "truncate"],
    ["dd if=/dev/zero of=f", "dd"],
    ["chmod +x f", "chmod"],
    ["chown me f", "chown"],
    ["patch -p1 < d.patch", "patch"],
    ["tar xf a.tar", "tar-extract"],
    ["rsync -a a/ b/", "rsync"],
    ["cat <<EOF\nx\nEOF", "heredoc"],
  ];
  for (const [command, rule] of mutating) {
    it(`blocks (${rule}): ${command.split("\n")[0]}`, () => {
      const verdict = classifyCommand(command);
      expect(verdict.safe).toBe(false);
      expect(verdict.rule).toBe(rule);
    });
  }
});

describe("indirection is refused rather than inspected", () => {
  const indirect = [
    "python3 -c \"open('f','w').write('x')\"",
    "node -e \"require('fs').writeFileSync('f','x')\"",
    "ruby -e 'File.write(\"f\",\"x\")'",
    "bash -c 'echo x > f'",
    "sh script.sh",
    "eval \"$CMD\"",
    ". ./setup.sh",
    "source ./setup.sh",
    "xargs rm < list",
    "find . -name '*.ts' -exec sed -i s/a/b/ {} +",
    "find . -delete",
    "echo $(rm f)",
    "echo `rm f`",
    "diff <(cat a) <(rm f)",
  ];
  for (const command of indirect) {
    it(`blocks: ${command}`, () => {
      expect(classifyCommand(command).safe).toBe(false);
    });
  }
});

describe("the allowlist is per segment, not per command line", () => {
  it("blocks a mutation chained after a safe command", () => {
    // The upstream classifier's `^\\s*ls` would match this whole string.
    expect(classifyCommand("ls -la && echo x > f").safe).toBe(false);
    expect(classifyCommand("ls -la; rm -rf src").safe).toBe(false);
    expect(classifyCommand("ls || curl -o f http://x").safe).toBe(false);
  });

  it("blocks an unlisted command chained after a safe one even with no denylist rule", () => {
    const verdict = classifyCommand("ls && frobnicate --write");
    expect(verdict.safe).toBe(false);
    expect(verdict.rule).toBe("not-allowlisted");
    expect(verdict.segment).toContain("frobnicate");
  });

  it("splits on every shell separator", () => {
    expect(splitSegments("a; b && c || d | e & f")).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("default-deny: an unknown command is refused", () => {
  it("refuses a command nobody enumerated", () => {
    const verdict = classifyCommand("some-new-tool --apply");
    expect(verdict.safe).toBe(false);
    expect(verdict.rule).toBe("not-allowlisted");
  });

  it("refuses an empty command", () => {
    expect(classifyCommand("   ").rule).toBe("empty");
  });
});

describe("git, package managers and the store are refused", () => {
  const blocked: readonly [string, string][] = [
    ["git add .", "git-mutate"],
    ["git commit -m x", "git-mutate"],
    ["git push origin HEAD", "git-mutate"],
    ["git reset --hard HEAD~1", "git-mutate"],
    ["git checkout main", "git-mutate"],
    ["git stash", "git-mutate"],
    ["git config user.name x", "git-mutate"],
    ["git log --oneline && git push", "git-mutate"],
    ["gh pr merge 1", "gh-mutate"],
    ["npm install left-pad", "npm-mutate"],
    ["npm run build", "npm-mutate"],
    ["npx some-cli", "npx"],
    ["pip install requests", "pip"],
    ["sudo rm -rf /", "privilege"],
    ["sqlite3 .korwf/korwf.sqlite 'delete from task'", "sqlite"],
    ["cat .env", "env-file"],
    ["cat .env.local", "env-file"],
  ];
  for (const [command, rule] of blocked) {
    it(`blocks (${rule}): ${command}`, () => {
      const verdict = classifyCommand(command);
      expect(verdict.safe).toBe(false);
      expect(verdict.rule).toBe(rule);
    });
  }
});

describe("the rule tables themselves", () => {
  it("every denylist rule has a distinct id and an explanation", () => {
    const ids = DESTRUCTIVE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of DESTRUCTIVE_RULES) expect(rule.why.length).toBeGreaterThan(10);
  });

  it("every allowlist pattern is anchored, so a command cannot match mid-string", () => {
    for (const pattern of SAFE_PATTERNS) {
      expect(pattern.source.startsWith("^"), `${pattern.source} is not anchored`).toBe(true);
    }
  });
});
