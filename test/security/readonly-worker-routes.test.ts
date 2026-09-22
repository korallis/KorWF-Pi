/**
 * Issue #69, the acceptance criterion stated as an experiment.
 *
 * The tests in `execution-policy.test.ts` assert what the policy *decides*.
 * These assert what ends up **on disk**: a real temporary worktree, a runner
 * that actually carries out any tool call the gate permits, and a read-only
 * worker that tries every mutation route in turn. If the gate were wrong, the
 * file would exist and the assertion would fail — the test cannot pass
 * vacuously by the mutation never having been attempted, because the same
 * runner performs the implementer's writes and those do appear.
 *
 * PLAN §7: "All mutation routes tested (bash, custom tools); disabling
 * `edit`/`write` alone is not read-only enforcement."
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolGate, type GateAuditEntry } from "../../src/workers/tool-gate.ts";
import { buildWorkerArgv, draftToContract } from "../../src/workers/index.ts";
import { READ_ONLY_ROLES, roleTools, type RoleId } from "../../src/workers/roles.ts";
import type { ModelRef } from "../../src/config/types.ts";
import type { ToolCallFacts } from "../../src/security/execution-policy.ts";

let root: string;
let worktree: string;
let audit: GateAuditEntry[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "korwf-69-"));
  worktree = join(root, "worktree");
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(join(worktree, ".korwf", "artifacts", "attempt-1"), { recursive: true });
  writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "outside.txt"), "untouched\n");
  audit = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A worker's tool surface. Every call goes through the gate first; a call the
 * gate permits is **really executed**, which is what makes a passing test
 * evidence rather than a tautology.
 */
function runner(role: RoleId) {
  const gate = createToolGate({
    workerId: "w1",
    role,
    worktree,
    storageRoot: join(worktree, ".korwf"),
    attemptId: "attempt-1",
    audit: (entry) => audit.push(entry),
  });
  return (call: ToolCallFacts): { blocked: boolean; reason?: string } => {
    const verdict = gate(call);
    if (verdict !== undefined) return { blocked: true, reason: verdict.reason };
    const input = call.input as Record<string, string>;
    switch (call.toolName) {
      case "write":
        writeFileSync(resolveIn(input["path"]!), input["content"] ?? "");
        return { blocked: false };
      case "edit": {
        const p = resolveIn(input["path"]!);
        writeFileSync(p, readFileSync(p, "utf8").replace(input["oldText"] ?? "", input["newText"] ?? ""));
        return { blocked: false };
      }
      case "bash":
        execFileSync("bash", ["-c", input["command"]!], { cwd: worktree, stdio: "pipe" });
        return { blocked: false };
      default:
        // A custom tool the gate let through would mutate here. None does.
        writeFileSync(resolveIn(input["path"] ?? "custom-tool-output"), "custom\n");
        return { blocked: false };
    }
  };
}

const resolveIn = (p: string): string => (p.startsWith("/") ? p : join(worktree, p));

/** One attempted mutation and the artefact that proves whether it happened. */
interface Attempt {
  readonly label: string;
  readonly call: ToolCallFacts;
  /** Absolute path that must not exist (or must not change) if the gate held. */
  readonly evidence: () => boolean;
}

function attempts(): readonly Attempt[] {
  // Paths are resolved *inside* the closure: `attempts()` is evaluated when the
  // suite is collected, before `beforeEach` has made the temporary worktree.
  const gone = (...parts: string[]) => () => !existsSync(join(worktree, ...parts));
  const unchanged = (parts: string[], text: string) => () => readFileSync(join(worktree, ...parts), "utf8") === text;
  return [
    {
      label: "write tool",
      call: { toolName: "write", input: { path: "pwned.txt", content: "x" } },
      evidence: gone("pwned.txt"),
    },
    {
      label: "edit tool",
      call: { toolName: "edit", input: { path: "src/a.ts", oldText: "1", newText: "2" } },
      evidence: unchanged(["src", "a.ts"], "export const a = 1;\n"),
    },
    {
      label: "bash redirection",
      call: { toolName: "bash", input: { command: "echo pwned > pwned.txt" } },
      evidence: gone("pwned.txt"),
    },
    {
      label: "bash tee",
      call: { toolName: "bash", input: { command: "echo pwned | tee pwned.txt" } },
      evidence: gone("pwned.txt"),
    },
    {
      label: "bash sed -i",
      call: { toolName: "bash", input: { command: "sed -i 's/1/2/' src/a.ts" } },
      evidence: unchanged(["src", "a.ts"], "export const a = 1;\n"),
    },
    {
      label: "bash cp",
      call: { toolName: "bash", input: { command: "cp src/a.ts pwned.txt" } },
      evidence: gone("pwned.txt"),
    },
    {
      label: "bash rm",
      call: { toolName: "bash", input: { command: "rm -f src/a.ts" } },
      evidence: () => existsSync(join(worktree, "src", "a.ts")),
    },
    {
      label: "bash python interpreter",
      call: { toolName: "bash", input: { command: "python3 -c \"open('pwned.txt','w').write('x')\"" } },
      evidence: gone("pwned.txt"),
    },
    {
      label: "bash chained after a safe command",
      call: { toolName: "bash", input: { command: "ls -la && echo pwned > pwned.txt" } },
      evidence: gone("pwned.txt"),
    },
    {
      label: "custom tool",
      call: { toolName: "acme_write_file", input: { path: "pwned.txt", content: "x" } },
      evidence: gone("pwned.txt"),
    },
  ];
}

describe("AC1 (on disk): a read-only worker changes nothing, by any route", () => {
  for (const role of READ_ONLY_ROLES) {
    for (const attempt of attempts()) {
      it(`${role}: ${attempt.label} is blocked and leaves the tree untouched`, () => {
        const run = runner(role);
        const result = run(attempt.call);
        expect(result.blocked, `${role} was permitted to ${attempt.label}`).toBe(true);
        expect(attempt.evidence(), `${attempt.label} changed the worktree despite being blocked`).toBe(true);
        expect(audit).toHaveLength(1);
      });
    }
  }

  it("the harness really does mutate when the gate allows it (the test is not vacuous)", () => {
    const run = runner("implementer");
    expect(run({ toolName: "write", input: { path: "pwned.txt", content: "x" } }).blocked).toBe(false);
    expect(existsSync(join(worktree, "pwned.txt"))).toBe(true);
  });
});

describe("AC1 (on disk): an implementer works inside its worktree", () => {
  it("writes and edits inside the worktree", () => {
    const run = runner("implementer");
    expect(run({ toolName: "write", input: { path: "src/new.ts", content: "export const b = 2;\n" } }).blocked).toBe(false);
    expect(run({ toolName: "edit", input: { path: "src/a.ts", oldText: "1", newText: "2" } }).blocked).toBe(false);
    expect(readFileSync(join(worktree, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("runs a read-only shell command", () => {
    expect(runner("implementer")({ toolName: "bash", input: { command: "ls -la src" } }).blocked).toBe(false);
  });

  it("writes its own artifact directory", () => {
    const path = join(worktree, ".korwf", "artifacts", "attempt-1", "report.md");
    expect(runner("implementer")({ toolName: "write", input: { path, content: "done\n" } }).blocked).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("done\n");
  });
});

describe("AC2 (on disk): an implementer cannot write outside its worktree", () => {
  it("is blocked and audited, and the outside file is untouched", () => {
    const outside = join(root, "outside.txt");
    const result = runner("implementer")({ toolName: "write", input: { path: outside, content: "pwned" } });
    expect(result.blocked).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.rule).toBe("path_outside_worktree");
    expect(audit[0]!.role).toBe("implementer");
  });

  it("is blocked when it escapes by traversal", () => {
    const result = runner("implementer")({ toolName: "write", input: { path: "../outside.txt", content: "pwned" } });
    expect(result.blocked).toBe(true);
    expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("untouched\n");
  });
});

describe("the primary mechanism: --tools never gives a read-only role a mutation tool", () => {
  for (const role of READ_ONLY_ROLES) {
    it(`${role}'s worker command line carries no write, edit or bash`, () => {
      const argv = buildWorkerArgv(
        draftToContract({
          workerId: "w1",
          role,
          task: "read the tree",
          cwd: worktree,
          model: "test/model" as ModelRef,
        }),
      );
      const tools = argv[argv.indexOf("--tools") + 1]!.split(",");
      expect(tools).toEqual([...roleTools(role)]);
      for (const forbidden of ["write", "edit", "multiedit", "apply_patch", "bash"]) {
        expect(tools, `${role} was launched with ${forbidden}`).not.toContain(forbidden);
      }
      // ...and the allowlist is a strict allowlist, so absence is unreachability.
      expect(argv).toContain("--no-extensions");
    });
  }
});
