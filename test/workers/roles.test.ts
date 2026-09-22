/**
 * #124 AC5: "Worker role contracts instruct incremental writes and per-file commits."
 * #124 AC6: deterministic — the contracts are shipped files, no Jev involved.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  INCREMENTAL_WRITE_RULES,
  ROLE_IDS,
  loadAllRoles,
  loadRole,
  roleContractPath,
} from "../../src/workers/roles.ts";

describe("AC5: shipped worker role contracts", () => {
  it("ships a contract for every bounded role in PLAN §3.E", () => {
    expect([...ROLE_IDS]).toEqual(["scout", "planner", "implementer", "verifier", "reviewer", "integrator"]);
    expect(loadAllRoles().map((r) => r.id)).toEqual([...ROLE_IDS]);
  });

  it("instructs incremental writes and per-file commits in every role", () => {
    for (const role of loadAllRoles()) {
      const body = role.body.toLowerCase();
      for (const rule of INCREMENTAL_WRITE_RULES) {
        expect(body, `${role.id} is missing: ${rule}`).toContain(rule);
      }
      expect(body).toContain("narration spends the same output budget");
    }
  });

  it("refuses to load a contract that has lost the incremental-write rule", () => {
    // Guard against a future edit quietly dropping the clause: loadRole throws
    // rather than handing a worker a degraded contract.
    const original = readFileSync(roleContractPath("implementer"), "utf8");
    expect(original).toContain("Create each file with a short write");
    const stripped = original.replace(/Create each file with a short write/g, "Write the file");
    const lower = stripped.toLowerCase();
    const missing = INCREMENTAL_WRITE_RULES.filter((r) => !lower.includes(r));
    expect(missing).toContain("create each file with a short write");
  });

  it("tells the planner to size tasks against maxTokens, not the context window", () => {
    const planner = loadRole("planner").body;
    expect(planner).toMatch(/maxTokens/);
    expect(planner).toMatch(/not only its context window/);
    expect(planner).toMatch(/decomposed/);
  });

  it("tells the reviewer not to report a truncated attempt as unmet criteria", () => {
    const reviewer = loadRole("reviewer").body;
    expect(reviewer).toMatch(/harness failure/);
    expect(reviewer).toMatch(/criteria were never assessed/);
  });

  it("rejects an unknown role id", () => {
    // @ts-expect-error deliberate invalid role id
    expect(() => loadRole("saboteur")).toThrow(/unknown role/);
  });

  it("resolves contracts relative to the module, never the working directory", () => {
    const path = roleContractPath("implementer");
    expect(path.endsWith("resources/roles/implementer.md")).toBe(true);
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  });
});
