/**
 * Issue #69 — the gate that applies the execution policy, and the audit the
 * second acceptance criterion requires ("Implementer writing outside its
 * worktree is blocked **and audited**").
 */
import { describe, it, expect } from "vitest";
import {
  RouteOpenError,
  assertRoutesClosed,
  createToolGate,
  evaluateToolCall,
  type GateAuditEntry,
  type ToolGateOptions,
} from "../../src/workers/tool-gate.ts";
import { READ_ONLY_ROLES, ROLE_IDS, roleTools, type RoleId } from "../../src/workers/roles.ts";
import { validateContract, draftToContract } from "../../src/workers/contract.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";

const WORKTREE = "/srv/work/issue-69";

function gateFor(role: RoleId, sink?: GateAuditEntry[]): ToolGateOptions {
  const base: ToolGateOptions = {
    workerId: "w1",
    role,
    worktree: WORKTREE,
    storageRoot: `${WORKTREE}/.korwf`,
    attemptId: "attempt-1",
  };
  return sink === undefined ? base : { ...base, audit: (e) => sink.push(e) };
}

describe("the gate returns Pi's tool_call shape", () => {
  it("returns undefined for a permitted call", () => {
    const gate = createToolGate(gateFor("scout"));
    expect(gate({ toolName: "read", input: { path: "src/a.ts" } })).toBeUndefined();
  });

  it("returns { block: true, reason } for a refused call", () => {
    const gate = createToolGate(gateFor("scout"));
    const result = gate({ toolName: "write", input: { path: "f", content: "x" } });
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("mutation_tool_for_read_only_role");
  });

  it("names the closed route in the reason handed back to the model", () => {
    const gate = createToolGate(gateFor("scout"));
    const result = gate({ toolName: "bash", input: { command: "echo x > f" } });
    expect(result?.reason).toContain("route 'shell' is closed");
  });
});

describe("AC2: a blocked call is audited", () => {
  it("records a denial with the route, rule and resolved path", () => {
    const audit: GateAuditEntry[] = [];
    const gate = createToolGate(gateFor("implementer", audit));
    gate({ toolName: "write", input: { path: "/etc/passwd", content: "x" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      workerId: "w1",
      role: "implementer",
      toolName: "write",
      route: "write",
      rule: "path_outside_worktree",
    });
    expect(audit[0]!.paths).toEqual(["/etc/passwd"]);
  });

  it("records the command when the denied call was a shell call", () => {
    const audit: GateAuditEntry[] = [];
    const gate = createToolGate(gateFor("implementer", audit));
    gate({ toolName: "bash", input: { command: "git commit -am wip" } });
    expect(audit[0]!.command).toBe("git commit -am wip");
    expect(audit[0]!.route).toBe("git");
  });

  it("does not audit permitted calls", () => {
    const audit: GateAuditEntry[] = [];
    const gate = createToolGate(gateFor("implementer", audit));
    gate({ toolName: "write", input: { path: "src/a.ts", content: "x" } });
    expect(audit).toEqual([]);
  });

  it("still blocks when the audit sink throws — logging is not a bypass", () => {
    const gate = createToolGate({
      ...gateFor("scout"),
      audit: () => {
        throw new Error("sink is down");
      },
    });
    expect(gate({ toolName: "write", input: { path: "f" } })).toMatchObject({ block: true });
  });

  it("audits every read-only role's attempt on every route", () => {
    for (const role of READ_ONLY_ROLES) {
      const audit: GateAuditEntry[] = [];
      const gate = createToolGate(gateFor(role, audit));
      gate({ toolName: "write", input: { path: "f" } });
      gate({ toolName: "bash", input: { command: "rm -rf ." } });
      gate({ toolName: "acme_mutate", input: {} });
      expect(audit).toHaveLength(3);
      for (const entry of audit) expect(entry.rule).not.toBe("allowed");
    }
  });
});

describe("assertRoutesClosed: proved before a worker exists", () => {
  it("passes for every shipped read-only role", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(() => assertRoutesClosed(role)).not.toThrow();
    }
  });

  it("is a no-op for roles that are not read-only", () => {
    for (const role of ROLE_IDS.filter((r) => !READ_ONLY_ROLES.includes(r as never))) {
      expect(() => assertRoutesClosed(role)).not.toThrow();
    }
  });

  it("throws when a read-only role's allowlist is widened with bash", () => {
    // This is the trap PLAN §7 names: bash alone makes the role not read-only.
    expect(() => assertRoutesClosed("scout", [...roleTools("scout"), "bash"])).toThrow(RouteOpenError);
  });

  it("throws for a custom tool whose name is not recognisably read-only", () => {
    // Default-deny by route: an unrecognised tool is `custom_tool`, not `read`.
    const error = (() => {
      try {
        assertRoutesClosed("reviewer", [...roleTools("reviewer"), "acme_apply"]);
        return null;
      } catch (e) {
        return e as RouteOpenError;
      }
    })();
    expect(error).toBeInstanceOf(RouteOpenError);
    expect(error!.openRoutes.map((o) => o.tool)).toContain("acme_apply");
  });

  it("names every open route, not just the first", () => {
    try {
      assertRoutesClosed("scout", ["read", "bash", "write", "git_commit"]);
      throw new Error("should have thrown");
    } catch (e) {
      const error = e as RouteOpenError;
      expect(error.openRoutes.map((o) => o.route).sort()).toEqual(["git", "shell", "write"]);
    }
  });
});

describe("the spawn path refuses a contract that opens a route", () => {
  const allowlist: ModelAllowlist = { providers: [], models: ["test/model" as ModelRef], pins: {} };

  it("rejects a scout contract carrying bash before anything is spawned", () => {
    const contract = draftToContract({
      workerId: "w1",
      role: "scout",
      task: "look at src/",
      cwd: WORKTREE,
      model: "test/model" as ModelRef,
      tools: [...roleTools("scout"), "bash"],
    });
    const result = validateContract(contract, { allowlist });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("mutation_route_open_for_read_only_role");
  });

  it("accepts the shipped scout contract unchanged", () => {
    const contract = draftToContract({
      workerId: "w1",
      role: "scout",
      task: "look at src/",
      cwd: WORKTREE,
      model: "test/model" as ModelRef,
    });
    const result = validateContract(contract, { allowlist });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateToolCall exposes the decision and the audit entry together", () => {
  it("returns a null audit entry for an allowed call", () => {
    const { decision, audit } = evaluateToolCall(
      { toolName: "read", input: { path: "src/a.ts" } },
      gateFor("scout"),
    );
    expect(decision.allow).toBe(true);
    expect(audit).toBeNull();
  });
});
