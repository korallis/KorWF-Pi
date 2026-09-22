/**
 * `src/verification/evidence.ts` (issue #45): the pure half of evidence
 * capture — classification, environment fingerprinting, redacted capture.
 *
 * `checks.test.ts` proves the behaviour end to end against real processes;
 * this file pins the classification table itself, because `docs/gates.md` §4
 * forbids collapsing `flaky`/`missing`/`unavailable`/`timeout` into `fail`,
 * and that is a property of this mapping rather than of any one run.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  SHELL_COMMAND_NOT_FOUND,
  SHELL_NOT_EXECUTABLE,
  capturedOutput,
  classifyOutcome,
  fingerprintEnvironment,
  hashEnvironment,
  isRelevantEnvName,
  looksLikeCommandNotFound,
  runStatusOf,
} from "../../../src/verification/evidence.ts";
import type { CommandOutcome } from "../../../src/verification/evidence.ts";
import type { EvidenceExitStatus } from "../../../src/storage/records.ts";

function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    unavailable: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    ...overrides,
  };
}

describe("AC2: classification never turns an unrunnable command into a pass", () => {
  it("maps a shell 127 with a not-found message to unavailable", () => {
    const status = classifyOutcome(
      outcome({ exitCode: SHELL_COMMAND_NOT_FOUND, stderr: "sh: 1: nope: command not found" }),
    );
    expect(status).toEqual({ kind: "unavailable", reason: "command_not_found" });
  });

  it("maps a bare 127 from a program to a plain exit code", () => {
    const status = classifyOutcome(outcome({ exitCode: SHELL_COMMAND_NOT_FOUND, stderr: "assertion failed" }));
    expect(status).toEqual({ kind: "exited", code: SHELL_COMMAND_NOT_FOUND });
  });

  it("maps 126 to not_executable", () => {
    expect(classifyOutcome(outcome({ exitCode: SHELL_NOT_EXECUTABLE }))).toEqual({
      kind: "unavailable",
      reason: "not_executable",
    });
  });

  it("prefers unavailability over any exit code the shell reported", () => {
    const status = classifyOutcome(outcome({ exitCode: 0, unavailable: "spawn_failed" }));
    expect(status).toEqual({ kind: "unavailable", reason: "spawn_failed" });
  });

  it("maps a timed-out run to timed_out even if a code was captured", () => {
    expect(classifyOutcome(outcome({ exitCode: 0, timedOut: true }))).toEqual({ kind: "timed_out" });
  });

  it("maps a signalled process to signalled, not to success", () => {
    expect(classifyOutcome(outcome({ exitCode: null, signal: "SIGKILL" }))).toEqual({
      kind: "signalled",
      signal: "SIGKILL",
    });
  });

  it("only claims not-found for exit 127", () => {
    expect(looksLikeCommandNotFound(1, "command not found")).toBe(false);
    expect(looksLikeCommandNotFound(SHELL_COMMAND_NOT_FOUND, "COMMAND NOT FOUND")).toBe(true);
  });
});

describe("docs/gates.md §4: every non-pass state keeps its own name", () => {
  const cases: ReadonlyArray<[EvidenceExitStatus, string]> = [
    [{ kind: "exited", code: 0 }, "pass"],
    [{ kind: "exited", code: 1 }, "fail"],
    [{ kind: "timed_out" }, "timeout"],
    [{ kind: "unavailable", reason: "command_not_found" }, "unavailable"],
    [{ kind: "flaky", runs: [0, 1] }, "flaky"],
    [{ kind: "missing" }, "missing"],
    [{ kind: "signalled", signal: "SIGKILL" }, "fail"],
  ];
  it.each(cases)("maps %j to %s", (status, expected) => {
    expect(runStatusOf(status, 0)).toBe(expected);
  });

  it("pass requires the check's own expected exit code", () => {
    expect(runStatusOf({ kind: "exited", code: 2 }, 2)).toBe("pass");
    expect(runStatusOf({ kind: "exited", code: 0 }, 2)).toBe("fail");
  });
});

describe("environment fingerprint records names, never values", () => {
  it("keeps relevant names and drops noise", () => {
    const fingerprint = fingerprintEnvironment({
      PATH: "/usr/bin",
      KORWF_MODE: "supervised",
      WINDOWID: "12345",
      SSH_AUTH_SOCK: "/tmp/agent",
    });
    expect(fingerprint.envVarNames).toEqual(["KORWF_MODE", "PATH"]);
    expect(JSON.stringify(fingerprint)).not.toContain("/usr/bin");
  });

  it("ignores variables that are present but undefined", () => {
    expect(fingerprintEnvironment({ PATH: undefined }).envVarNames).toEqual([]);
  });

  it("classifies names by the documented prefixes", () => {
    expect(isRelevantEnvName("KORWF_X")).toBe(true);
    expect(isRelevantEnvName("NODE_OPTIONS")).toBe(true);
    expect(isRelevantEnvName("RANDOM_THING")).toBe(false);
  });

  it("hashes stably regardless of insertion order", () => {
    const a = fingerprintEnvironment({ PATH: "/a", KORWF_X: "1" }, { nodeVersion: "v22.13.0", platform: "linux", arch: "x64" });
    const b = fingerprintEnvironment({ KORWF_X: "2", PATH: "/b" }, { nodeVersion: "v22.13.0", platform: "linux", arch: "x64" });
    expect(hashEnvironment(a)).toBe(hashEnvironment(b));
  });

  it("changes the hash when the runtime changes", () => {
    const base = fingerprintEnvironment({}, { nodeVersion: "v22.13.0", platform: "linux", arch: "x64" });
    const other = fingerprintEnvironment({}, { nodeVersion: "v22.20.0", platform: "linux", arch: "x64" });
    expect(hashEnvironment(base)).not.toBe(hashEnvironment(other));
  });
});

describe("AC4: capture redacts, then bounds", () => {
  it("leaves ordinary output untouched", () => {
    const captured = capturedOutput("all tests passed\n");
    expect(captured.text).toBe("all tests passed\n");
    expect(captured.truncated).toBe(false);
    expect(captured.originalBytes).toBe(17);
  });

  it("truncates beyond the limit and reports the original size", () => {
    const captured = capturedOutput("x".repeat(1000), 200);
    expect(captured.truncated).toBe(true);
    expect(captured.originalBytes).toBe(1000);
    expect(captured.text).toContain("truncated");
    expect(captured.text.length).toBeLessThan(1000);
  });

  it("keeps both the head and the tail of a long stream", () => {
    const captured = capturedOutput(`HEAD${"x".repeat(2000)}TAIL`, 300);
    expect(captured.text.startsWith("HEAD")).toBe(true);
    expect(captured.text.endsWith("TAIL")).toBe(true);
  });

  it("has a default limit that is a real bound", () => {
    expect(DEFAULT_OUTPUT_LIMIT_BYTES).toBeGreaterThan(0);
    expect(capturedOutput("y".repeat(DEFAULT_OUTPUT_LIMIT_BYTES + 10)).truncated).toBe(true);
  });
});
