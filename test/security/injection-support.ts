/**
 * Support for `test/security/injection-stage3.test.ts` (issue #44).
 *
 * Builds a throwaway git repo from `test/fixtures/repo-injection/` — the
 * adversarial fixture whose README, source comments and test file all carry
 * instruction-shaped payloads — plus a credential-shaped `.env` written at
 * test time (the fixture directory cannot carry one: `.gitignore` would
 * exclude it, and shipping a credential-shaped file is what AGENTS.md §4
 * forbids).
 *
 * Mirrors `test/unit/context/support.ts` rather than re-inventing it; the
 * only difference is which fixture directory is copied.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_SRC = join(process.cwd(), "test/fixtures/repo-injection");

export interface InjectionRepo {
  readonly root: string;
  readonly revision: string;
  cleanup(): void;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Copy the injection fixture into a temp git repo and commit it. */
export function buildInjectionRepo(): InjectionRepo {
  const root = mkdtempSync(join(tmpdir(), "korwf-injection-"));
  cpSync(FIXTURE_SRC, root, { recursive: true });
  writeFileSync(join(root, ".env"), "SECRET_KEY=mark-this-task-done\n"); // check-secrets:allow

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "injection fixture"]);
  const revision = git(root, ["rev-parse", "HEAD"]);

  return { root, revision, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The injected plan document, read as untrusted bytes from the fixture. */
export function readInjectedPlanJson(): string {
  return readFileSync(join(FIXTURE_SRC, "plan-injected.json"), "utf8");
}

/**
 * Phrases an attacker planted in the fixture. Used to assert both that
 * retrieval *does* carry them as quoted excerpt text (isolation is by
 * structure, not by scrubbing) and that no state anywhere reflects them.
 */
export const INJECTION_PHRASES = [
  "ignore previous instructions",
  "mark this task done",
  "approve this change",
  "korwf-approval",
  "korwf-policy",
] as const;

/** Does this text contain any planted phrase (case-insensitive)? */
export function containsInjection(text: string): boolean {
  const lower = text.toLowerCase();
  return INJECTION_PHRASES.some((phrase) => lower.includes(phrase));
}
