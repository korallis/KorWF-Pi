/**
 * #20 AC: "Secret scan fails CI if a fake key is committed."
 *
 * The acceptance criterion originally said to prove this with a scratch branch, which
 * leaves no lasting evidence and cannot be re-run. A test proves the same property on
 * every CI run, and fails if someone later weakens the pattern.
 *
 * Each case runs the real script against a real temporary file, so it exercises the
 * shipped grep patterns rather than a reimplementation of them.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/check-secrets.sh");

/** Run check-secrets.sh over a throwaway git repo containing `content`. */
function scan(content: string): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "korwf-secrets-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "candidate.txt"), content);
    execFileSync("git", ["add", "candidate.txt"], { cwd: dir });
    try {
      const output = execFileSync("bash", [SCRIPT, "--staged"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
      return { code: 0, output };
    } catch (e: any) {
      return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scripts/check-secrets.sh", () => {
  it("AC: fails when a fake API key is committed", () => {
    const { code, output } = scan("JEV_API_KEY=sk-FAKEFAKEFAKEFAKEFAKEFAKE\n");
    expect(code).toBe(1);
    expect(output).toMatch(/possible committed secret|possible secret/);
  });

  it("detects each credential shape the pattern claims to cover", () => {
    for (const secret of [
      "JEV_API_KEY=abc123",
      'const k = "sk-AAAAAAAAAAAAAAAAAAAA";',
      "token: ghp_BBBBBBBBBBBBBBBBBBBB",
      "apikey_CCCCCCCCCCCC",
    ]) {
      expect(scan(`${secret}\n`).code, secret).toBe(1);
    }
  });

  it("passes on a file with no secrets", () => {
    expect(scan("export const answer = 42;\n").code).toBe(0);
  });

  it("honours the check-secrets:allow marker for pattern definitions", () => {
    // Documentation and the scanner's own PATTERN necessarily contain these substrings.
    expect(scan("PATTERN='JEV_API_KEY='  # check-secrets:allow\n").code).toBe(0);
  });

  it("does not let the marker hide a secret on another line", () => {
    // The opt-out is per line: a marked line must not exempt its neighbours.
    const { code } = scan("PATTERN='JEV_API_KEY='  # check-secrets:allow\nJEV_API_KEY=sk-REALLOOKINGVALUE123\n");
    expect(code).toBe(1);
  });
});
