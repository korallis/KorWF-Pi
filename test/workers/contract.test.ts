/**
 * #68 AC3: "Contract with a model outside allowlist is rejected before spawn."
 * Plus the role→tools invariants from ADR 0004 guard 3.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_GRACE_MS,
  draftToContract,
  validateContract,
  type ContractPolicy,
} from "../../src/workers/contract.ts";
import {
  MUTATION_TOOL_NAMES,
  READ_ONLY_ROLES,
  ROLE_IDS,
  SPAWN_TOOL_NAMES,
  TOOL_ALLOWLIST_HEADING,
  declaredTools,
  isReadOnlyRole,
  loadRoleDefinition,
  roleTools,
} from "../../src/workers/roles.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";

const ALLOWED: ModelRef = "provider-a/model-one";
const OTHER: ModelRef = "provider-b/model-two";

const allowlist: ModelAllowlist = { providers: [], models: [ALLOWED], pins: {} };
const policy: ContractPolicy = { allowlist };

function draft(overrides: Partial<Parameters<typeof draftToContract>[0]> = {}) {
  return draftToContract({
    workerId: "w1",
    role: "implementer",
    task: "do the thing",
    cwd: "/tmp/worktree",
    model: ALLOWED,
    ...overrides,
  });
}

describe("AC3: a contract outside policy is rejected before spawn", () => {
  it("accepts a contract whose model is in the allowlist", () => {
    const result = validateContract(draft(), policy);
    expect(result.ok).toBe(true);
  });

  it("rejects a model that is not in models.allowlist", () => {
    const result = validateContract(draft({ model: OTHER }), policy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("model_not_in_allowlist");
    expect(result.errors[0]!.message).toContain(OTHER);
  });

  it("rejects a model the budget check refuses, without a second policy implementation", () => {
    const result = validateContract(draft(), { ...policy, checkBudget: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("model_budget_unavailable");
  });

  it("honours an empty allowlist the same way #60's enforcePolicy does", () => {
    // `models: []` means "every model of an eligible provider" (config/types).
    const open: ModelAllowlist = { providers: [], models: [], pins: {} };
    expect(validateContract(draft({ model: OTHER }), { allowlist: open }).ok).toBe(true);
    const providerScoped: ModelAllowlist = { providers: ["provider-a"], models: [], pins: {} };
    expect(validateContract(draft({ model: OTHER }), { allowlist: providerScoped }).ok).toBe(false);
  });

  it("rejects a tool outside the role's allowlist", () => {
    const result = validateContract(draft({ role: "scout", tools: ["read", "write"] }), policy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("tool_not_allowed_for_role");
  });

  it("rejects any spawn tool, for every role", () => {
    for (const role of ROLE_IDS) {
      for (const tool of SPAWN_TOOL_NAMES) {
        const result = validateContract(draft({ role, tools: [tool] }), policy);
        expect(result.ok, `${role}/${tool} was accepted`).toBe(false);
        if (result.ok) continue;
        expect(result.errors.map((e) => e.code)).toContain("spawn_tool_requested");
      }
    }
  });

  it("rejects an extension that is not explicitly permitted", () => {
    const result = validateContract(draft({ inheritance: { extensions: ["/x/korwf.ts"] } }), policy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("extension_inheritance_not_permitted");
  });

  it("accepts an extension listed in workers.permittedExtensions", () => {
    const result = validateContract(draft({ inheritance: { extensions: ["/x/role.ts"] } }), {
      ...policy,
      permittedExtensions: ["/x/role.ts"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a depth above workers.maxDepth", () => {
    const result = validateContract(draft({ depth: 2 }), policy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.code)).toContain("depth_exceeds_max");
  });

  it("rejects a relative cwd, an empty task and a non-positive budget", () => {
    const result = validateContract(
      draft({ cwd: "relative/dir", task: "   ", budget: { wallClockMs: 0 } }),
      policy,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("cwd_not_absolute");
    expect(codes).toContain("empty_task");
    expect(codes).toContain("invalid_budget");
  });

  it("reports every violation at once rather than only the first", () => {
    const result = validateContract(draft({ model: OTHER, role: "reviewer", tools: ["bash"] }), policy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe("role tool allowlist (ADR 0004 guard 3)", () => {
  it("gives no role a spawn tool", () => {
    for (const role of ROLE_IDS) {
      for (const tool of roleTools(role)) {
        expect(SPAWN_TOOL_NAMES as readonly string[], `${role}: ${tool}`).not.toContain(tool);
      }
    }
  });

  it("gives read-only roles no mutation tools", () => {
    for (const role of READ_ONLY_ROLES) {
      expect(isReadOnlyRole(role)).toBe(true);
      for (const tool of roleTools(role)) {
        expect(MUTATION_TOOL_NAMES as readonly string[], `${role}: ${tool}`).not.toContain(tool);
      }
    }
  });

  it("declares the same tools in the contract text as --tools enforces, for every role", () => {
    // The worker reads the contract; the process is bound by the table. If
    // they drift, the worker is told one thing and permitted another.
    for (const role of ROLE_IDS) {
      const definition = loadRoleDefinition(role);
      expect(declaredTools(definition.body), role).toEqual([...roleTools(role)]);
      expect(definition.body).toContain(TOOL_ALLOWLIST_HEADING);
    }
  });

  it("refuses a contract whose declared tools no longer match the table", () => {
    const body = loadRoleDefinition("scout").body.replace(
      "`read, grep, find, ls`",
      "`read, grep, find, ls, bash`",
    );
    expect(declaredTools(body)).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(declaredTools(body)).not.toEqual([...roleTools("scout")]);
  });

  it("gives writing roles the tools they need, with the contract text attached", () => {
    const impl = loadRoleDefinition("implementer");
    expect(impl.readOnly).toBe(false);
    expect(impl.tools).toContain("write");
    expect(impl.body.toLowerCase()).toContain("create each file with a short write");
  });

  it("defaults a draft to the narrowest configuration", () => {
    const contract = draft();
    expect(contract.tools).toEqual(roleTools("implementer"));
    expect(contract.inheritance).toEqual({
      extensions: [],
      skills: [],
      promptTemplates: false,
      contextFiles: false,
    });
    expect(contract.depth).toBe(1);
    expect(contract.sessionDir).toBeNull();
    expect(contract.termination.graceMs).toBe(DEFAULT_GRACE_MS);
  });
});
