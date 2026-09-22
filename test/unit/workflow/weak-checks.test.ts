/**
 * `src/workflow/weak-checks.ts` (issue #44; `test/spec/gates.spec.md` §B5).
 *
 * The rule: a check whose command cannot fail is not verification. These are
 * the unit tests for the analyser itself; the adversarial end-to-end use is
 * in `test/security/injection-stage3.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  WEAK_CHECK_BLOCKER,
  commandCanFail,
  isTrivialCheck,
  isVerifyingCheck,
  segmentAlwaysPasses,
  splitCommandSegments,
  trivialCheckReason,
  trivialChecks,
} from "../../../src/workflow/weak-checks.ts";

describe("splitCommandSegments", () => {
  it("splits on &&, ||, ; and | and records the operator", () => {
    expect(splitCommandSegments("a && b || c ; d | e")).toEqual([
      { op: "", text: "a" },
      { op: "&&", text: "b" },
      { op: "||", text: "c" },
      { op: ";", text: "d" },
      { op: "|", text: "e" },
    ]);
  });

  it("leaves operators inside quotes alone", () => {
    expect(splitCommandSegments('npm test -- --grep "a && b"')).toEqual([
      { op: "", text: 'npm test -- --grep "a && b"' },
    ]);
    expect(splitCommandSegments("echo 'x; y'")).toEqual([{ op: "", text: "echo 'x; y'" }]);
  });

  it("drops empty segments", () => {
    expect(splitCommandSegments("  ;; npm test ;")).toEqual([{ op: ";", text: "npm test" }]);
  });
});

describe("segmentAlwaysPasses", () => {
  it("recognises the POSIX null utility and true", () => {
    for (const s of [":", "true", "/bin/true", "/usr/bin/true"]) expect(segmentAlwaysPasses(s)).toBe(true);
  });

  it("treats exit 0 as passing and exit N as failing", () => {
    expect(segmentAlwaysPasses("exit 0")).toBe(true);
    expect(segmentAlwaysPasses("exit")).toBe(true);
    expect(segmentAlwaysPasses("exit 1")).toBe(false);
    expect(segmentAlwaysPasses("exit 3")).toBe(false);
  });

  it("skips leading environment assignments", () => {
    expect(segmentAlwaysPasses("CI=1 NODE_ENV=test true")).toBe(true);
    expect(segmentAlwaysPasses("CI=1 npm test")).toBe(false);
  });

  it("treats navigation-only segments as passing", () => {
    expect(segmentAlwaysPasses("cd packages/app")).toBe(true);
    expect(segmentAlwaysPasses("npm test")).toBe(false);
  });
});

describe("commandCanFail models shell short-circuiting", () => {
  it("&& fails if either side can fail", () => {
    expect(commandCanFail("cd app && npm test")).toBe(true);
    expect(commandCanFail("cd app && true")).toBe(false);
  });

  it("|| fails only if both sides can fail", () => {
    expect(commandCanFail("npm test || true")).toBe(false);
    expect(commandCanFail("true || npm test")).toBe(false);
    expect(commandCanFail("npm test || npm run lint")).toBe(true);
  });

  it("; and | take the last command's status", () => {
    expect(commandCanFail("npm test; true")).toBe(false);
    expect(commandCanFail("true; npm test")).toBe(true);
    expect(commandCanFail("npm test | true")).toBe(false);
  });
});

describe("trivialCheckReason", () => {
  it("names the empty command explicitly", () => {
    expect(trivialCheckReason({ kind: "command", command: "" })).toMatch(/empty/);
    expect(trivialCheckReason({ kind: "command", command: "   " })).toMatch(/empty/);
  });

  it("quotes the offending command for an unconditional pass", () => {
    expect(trivialCheckReason({ kind: "command", command: "true" })).toContain('"true"');
  });

  it("returns null for a real command", () => {
    expect(trivialCheckReason({ kind: "command", command: "npm test" })).toBeNull();
  });

  it("exempts human checks, whose command is an instruction", () => {
    expect(trivialCheckReason({ kind: "human", command: "true" })).toBeNull();
  });
});

describe("isVerifyingCheck", () => {
  it("is false for a trivial executed check and true for a real one", () => {
    expect(isVerifyingCheck({ kind: "command", command: "true" })).toBe(false);
    expect(isVerifyingCheck({ kind: "command", command: "npm test" })).toBe(true);
  });

  it("keeps the pre-existing human-check rule: required human counts, optional does not", () => {
    expect(isVerifyingCheck({ kind: "human", command: "Check the receipt.", required: true })).toBe(true);
    expect(isVerifyingCheck({ kind: "human", command: "Check the receipt.", required: false })).toBe(false);
    expect(isVerifyingCheck({ kind: "human", command: "Check the receipt." })).toBe(false);
  });
});

describe("trivialChecks", () => {
  it("returns one entry per weak check, with its reason", () => {
    const found = trivialChecks([
      { kind: "command", command: "true" },
      { kind: "command", command: "npm test" },
      { kind: "lint", command: "exit 0" },
    ]);
    expect(found).toHaveLength(2);
    expect(found.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("exports the blocker id the store and readiness rule both use", () => {
    expect(WEAK_CHECK_BLOCKER).toBe("weak_check");
    expect(isTrivialCheck({ kind: "typecheck", command: ":" })).toBe(true);
  });
});
