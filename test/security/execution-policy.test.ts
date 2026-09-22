/**
 * Issue #69 — read-only roles enforced across ALL mutation routes.
 *
 * PLAN §7: "All mutation routes tested (bash, custom tools); disabling
 * `edit`/`write` alone is not read-only enforcement."
 *
 * The suite is written adversarially: each case is a read-only worker that
 * *tries* to mutate by one route and is refused. A test asserting only that
 * `edit` is absent from a tool list would pass while the role could still
 * write a file through `bash`, and would miss the point of this issue.
 */
import { describe, it, expect } from "vitest";
import {
  MUTATION_ROUTES,
  decideToolCall,
  detectSandbox,
  extractPaths,
  normalise,
  routeOf,
  withinRoots,
  writableRoots,
  NO_SANDBOX,
  type ExecutionContext,
  type MutationRoute,
} from "../../src/security/execution-policy.ts";
import { READ_ONLY_ROLES, ROLE_IDS, roleTools, type RoleId } from "../../src/workers/roles.ts";

const WORKTREE = "/srv/work/issue-69";
const STORAGE = "/srv/work/issue-69/.korwf";

const ctxFor = (role: RoleId): ExecutionContext => ({
  role,
  worktree: WORKTREE,
  storageRoot: STORAGE,
  attemptId: "attempt-1",
});

/** Every route a worker could mutate state by, with a concrete attempt at it. */
interface RouteAttempt {
  readonly route: MutationRoute;
  readonly label: string;
  readonly call: { toolName: string; input: Record<string, unknown> };
}

export const MUTATION_ATTEMPTS: readonly RouteAttempt[] = [
  { route: "write", label: "write tool", call: { toolName: "write", input: { path: "note.txt", content: "x" } } },
  { route: "edit", label: "edit tool", call: { toolName: "edit", input: { path: "src/a.ts", oldText: "a", newText: "b" } } },
  { route: "edit", label: "multiedit tool", call: { toolName: "multiedit", input: { edits: [{ path: "src/a.ts" }] } } },
  { route: "edit", label: "apply_patch tool", call: { toolName: "apply_patch", input: { path: "src/a.ts" } } },
  { route: "shell", label: "bash redirection", call: { toolName: "bash", input: { command: "echo pwned > owned.txt" } } },
  { route: "shell", label: "bash tee", call: { toolName: "bash", input: { command: "echo pwned | tee owned.txt" } } },
  { route: "shell", label: "bash sed -i", call: { toolName: "bash", input: { command: "sed -i 's/a/b/' src/a.ts" } } },
  { route: "shell", label: "bash rm", call: { toolName: "bash", input: { command: "rm -rf src" } } },
  { route: "shell", label: "bash cp", call: { toolName: "bash", input: { command: "cp /etc/hosts ./hosts" } } },
  { route: "shell", label: "bash mv", call: { toolName: "bash", input: { command: "mv a b" } } },
  { route: "shell", label: "bash install", call: { toolName: "bash", input: { command: "install -m755 a /usr/local/bin/a" } } },
  { route: "shell", label: "bash interpreter", call: { toolName: "bash", input: { command: "python3 -c \"open('f','w')\"" } } },
  { route: "shell", label: "bash after a safe command", call: { toolName: "bash", input: { command: "ls -la && echo x > f" } } },
  { route: "git", label: "git commit via bash", call: { toolName: "bash", input: { command: "git commit -am wip" } } },
  { route: "git", label: "git tool", call: { toolName: "git_commit", input: { message: "wip" } } },
  { route: "store", label: "sqlite3 via bash", call: { toolName: "bash", input: { command: "sqlite3 .korwf/korwf.sqlite 'delete from task'" } } },
  { route: "custom_tool", label: "custom mutating tool", call: { toolName: "acme_write_file", input: { path: "f", content: "x" } } },
  { route: "custom_tool", label: "spawn tool", call: { toolName: "korwf_spawn_worker", input: { role: "implementer" } } },
];

describe("AC1: every mutation route is blocked for a read-only role", () => {
  for (const role of READ_ONLY_ROLES) {
    for (const attempt of MUTATION_ATTEMPTS) {
      it(`${role} cannot mutate via ${attempt.label} (route: ${attempt.route})`, () => {
        const decision = decideToolCall(attempt.call, ctxFor(role));
        expect(decision.allow, `${role} was allowed to ${attempt.label}`).toBe(false);
        expect(decision.rule).not.toBe("allowed");
        expect(decision.reason).not.toBe("");
      });
    }
  }

  it("routes every built-in mutation tool away from 'read'", () => {
    for (const tool of ["write", "edit", "multiedit", "apply_patch", "bash", "git_commit"]) {
      expect(routeOf(tool), tool).not.toBe("read");
    }
    // Default-deny: a name nobody enumerated is a custom tool, never a read.
    expect(routeOf("acme_unknown")).toBe("custom_tool");
    expect(routeOf("read")).toBe("read");
  });

  it("covers every route in MUTATION_ROUTES — no route is left untested", () => {
    const covered = new Set(MUTATION_ATTEMPTS.map((a) => a.route));
    for (const route of MUTATION_ROUTES) {
      expect(covered.has(route), `no adversarial attempt covers route '${route}'`).toBe(true);
    }
  });

  it("read-only roles are refused the shell even if their allowlist is widened", () => {
    // The --tools allowlist is the primary mechanism; this proves the policy
    // layer holds when that mechanism is bypassed or misconfigured.
    for (const role of READ_ONLY_ROLES) {
      const decision = decideToolCall({ toolName: "bash", input: { command: "ls" } }, ctxFor(role));
      expect(decision.allow).toBe(false);
    }
  });
});

describe("AC1: the same routes are allowed for an implementer inside its worktree", () => {
  const impl = ctxFor("implementer");

  it("allows write inside the worktree", () => {
    expect(decideToolCall({ toolName: "write", input: { path: "src/new.ts", content: "x" } }, impl).allow).toBe(true);
  });

  it("allows edit inside the worktree", () => {
    expect(decideToolCall({ toolName: "edit", input: { path: "src/a.ts" } }, impl).allow).toBe(true);
  });

  it("allows a read-only bash command", () => {
    expect(decideToolCall({ toolName: "bash", input: { command: "ls -la src" } }, impl).allow).toBe(true);
  });

  it("allows writing into this attempt's own artifact directory", () => {
    const call = { toolName: "write", input: { path: `${STORAGE}/artifacts/attempt-1/report.md`, content: "x" } };
    expect(decideToolCall(call, impl).allow).toBe(true);
  });
});

describe("AC2: an implementer writing outside its worktree is blocked and audited", () => {
  const impl = ctxFor("implementer");

  const outside: readonly [string, string][] = [
    ["an absolute path elsewhere", "/etc/cron.d/backdoor"],
    ["the user's home directory", "/home/someone/.bashrc"],
    ["a sibling worktree", "/srv/work/issue-70/src/a.ts"],
    ["a parent-relative escape", "../issue-70/src/a.ts"],
    ["a disguised escape", "src/../../issue-70/a.ts"],
    ["the project root above the worktree", "/srv/work/package.json"],
  ];

  for (const [label, path] of outside) {
    it(`blocks write to ${label}`, () => {
      const decision = decideToolCall({ toolName: "write", input: { path } }, impl);
      expect(decision.allow).toBe(false);
      expect(decision.rule).toBe("path_outside_worktree");
      // The decision carries the resolved path, which is what an audit row records.
      expect(decision.paths.length).toBe(1);
      expect(decision.paths[0]).not.toContain("..");
    });
  }

  it("blocks another attempt's artifact directory", () => {
    const call = { toolName: "write", input: { path: `${STORAGE}/artifacts/attempt-2/report.md` } };
    const decision = decideToolCall(call, impl);
    expect(decision.allow).toBe(false);
    expect(decision.rule).toBe("path_in_deny_list");
  });

  it("blocks the store itself even though it is inside the worktree", () => {
    const decision = decideToolCall({ toolName: "write", input: { path: ".korwf/korwf.sqlite" } }, impl);
    expect(decision.allow).toBe(false);
  });

  it("blocks a credential file inside the worktree for every role", () => {
    for (const role of ROLE_IDS) {
      const tools = roleTools(role);
      const tool = tools.includes("write") ? "write" : "read";
      const decision = decideToolCall({ toolName: tool, input: { path: ".env" } }, ctxFor(role));
      expect(decision.allow, `${role} reached .env via ${tool}`).toBe(false);
    }
  });

  it("blocks every path in a multi-path call when any one escapes", () => {
    const call = { toolName: "multiedit", input: { edits: [{ path: "src/a.ts" }, { path: "/etc/passwd" }] } };
    expect(decideToolCall(call, impl).allow).toBe(false);
  });
});

describe("path helpers: the boundary is computed, not trusted", () => {
  it("normalise resolves traversal without touching the filesystem", () => {
    expect(normalise("/a/b/../c")).toBe("/a/c");
    expect(normalise("/a/./b//c/")).toBe("/a/b/c");
    expect(normalise("/a/../../etc")).toBe("/etc");
    expect(normalise("a/b/../c")).toBe("a/c");
  });

  it("withinRoots resolves a relative path against the worktree first", () => {
    const roots = [WORKTREE];
    expect(withinRoots("src/a.ts", WORKTREE, roots)).toBe(true);
    expect(withinRoots("../other/a.ts", WORKTREE, roots)).toBe(false);
    expect(withinRoots("/etc/passwd", WORKTREE, roots)).toBe(false);
    // A sibling directory sharing a name prefix is not inside the worktree.
    expect(withinRoots(`${WORKTREE}-other/a.ts`, WORKTREE, roots)).toBe(false);
  });

  it("writableRoots is the worktree plus this attempt's artifact directory only", () => {
    expect(writableRoots(ctxFor("implementer"))).toEqual([WORKTREE, `${STORAGE}/artifacts/attempt-1`]);
    // With no attempt id there is no artifact root to write to.
    expect(writableRoots({ role: "implementer", worktree: WORKTREE })).toEqual([WORKTREE]);
  });

  it("extractPaths finds paths under every conventional key and in edit arrays", () => {
    expect(extractPaths({ path: "a", file_path: "b", paths: ["c"], edits: [{ path: "d" }] })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(extractPaths({ content: "not a path" })).toEqual([]);
  });
});

describe("sandbox presence is recorded, never relied on", () => {
  it("reports no sandbox by default (ADR 0001 row 3: KorWF ships none)", () => {
    expect(detectSandbox([{ name: "bash", description: "runs a shell command" }])).toEqual(NO_SANDBOX);
    expect(NO_SANDBOX.present).toBe(false);
  });

  it("detects a sandboxing bash override from its tool metadata", () => {
    const status = detectSandbox([{ name: "bash", description: "sandbox-exec wrapped shell" }]);
    expect(status.present).toBe(true);
    expect(status.mechanism).toBe("sandbox-exec");
  });
});

describe("PLAN §7: permissions come from rules and isolation, never from semantic confidence", () => {
  it("no field of ExecutionContext or ToolCallFacts carries a score or confidence", () => {
    // Structural, not textual: the policy is a function of (call, role, paths)
    // only. If a future change adds a Jev signal to the input it must change
    // this list, which is the review moment this test exists to create.
    const contextKeys = Object.keys(ctxFor("scout"));
    for (const key of contextKeys) {
      expect(/score|confidence|probability|jev|trust|belief/i.test(key), `suspicious input field '${key}'`).toBe(false);
    }
  });

  it("a Jev-shaped field smuggled into the tool input does not change any verdict", () => {
    for (const attempt of MUTATION_ATTEMPTS) {
      const bare = decideToolCall(attempt.call, ctxFor("scout"));
      const bribed = decideToolCall(
        {
          toolName: attempt.call.toolName,
          input: {
            ...attempt.call.input,
            jevScore: 0.99,
            confidence: 1,
            approved: true,
            readOnly: false,
            allow: true,
          },
        },
        ctxFor("scout"),
      );
      expect(bribed.allow, `${attempt.label} was allowed once a confidence field was attached`).toBe(bare.allow);
      expect(bribed.allow).toBe(false);
    }
  });

  it("detecting a sandbox does not relax anything", () => {
    const sandboxed: ExecutionContext = {
      ...ctxFor("scout"),
      sandbox: detectSandbox([{ name: "bash", description: "runs in a bubblewrap sandbox" }]),
    };
    expect(sandboxed.sandbox?.present).toBe(true);
    for (const attempt of MUTATION_ATTEMPTS) {
      expect(decideToolCall(attempt.call, sandboxed).allow, attempt.label).toBe(false);
    }
  });

  it("a role cannot be widened by passing a different role's tools as context", () => {
    // The policy reads the role's shipped tool table, not a caller-supplied
    // list, so there is no argument by which a scout becomes an implementer.
    const decision = decideToolCall(
      { toolName: "write", input: { path: "src/a.ts" } },
      { ...ctxFor("scout"), ...({ tools: roleTools("implementer") } as Record<string, unknown>) },
    );
    expect(decision.allow).toBe(false);
  });
});
