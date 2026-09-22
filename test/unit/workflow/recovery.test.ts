/**
 * Bounded recovery policy (issue #53; PLAN §3.G).
 *
 * AC1: "A task cannot loop more than the configured max attempts."
 * AC2: "Flagged side-effect step is not retried without reconciliation."
 * AC3: "Every recovery decision has an audit row with the rule applied."
 *
 * This file covers the pure policy (AC1 and the decision half of AC2); the
 * store-backed half of AC2 and all of AC3 are in `recovery-audit.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  RECOVERY_LADDERS,
  RECOVERY_RESPONSES,
  TERMINAL_RESPONSES,
  chooseRecovery,
  describeRecovery,
  isTerminalResponse,
  maxAttemptsFor,
  projectRecovery,
  reconcileStep,
  responseAvailable,
  retryPermittedAfter,
  type RecoveryInput,
  type RecoveryResponse,
} from "../../../src/workflow/recovery.ts";
import { FAILURE_CATEGORIES, classifyFailure, type FailureCategory } from "../../../src/workflow/failure.ts";
import { defaultConfig } from "../../../src/config/load.ts";
import type { RecoveryConfig } from "../../../src/config/types.ts";
import type { StallEvent } from "../../../src/workflow/stall.ts";

const CONFIG: RecoveryConfig = defaultConfig().recovery;

/** A deterministic classification of the given category, with no Jev involved. */
function classified(category: FailureCategory) {
  return {
    category,
    confidence: 1,
    rule: `rule:test-${category}`,
    source: "rule" as const,
    reason: `test fixture for ${category}`,
    needsEvidence: false,
    evidenceRequests: [] as readonly string[],
  };
}

function input(category: FailureCategory, over: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    classification: classified(category),
    attemptsUsed: 1,
    subjectKind: "task",
    ...over,
  };
}

const stall = (kind: StallEvent["kind"]): StallEvent => ({
  kind,
  taskId: "tk-1",
  attemptId: "at-3",
  count: 3,
  threshold: 3,
  detail: "test stall",
  attemptIds: ["at-1", "at-2", "at-3"],
});

describe("the response menu is exactly PLAN §3.G's, and every ladder ends", () => {
  it("names the eight bounded responses and no others", () => {
    expect([...RECOVERY_RESPONSES]).toEqual([
      "gather_evidence",
      "retry",
      "fallback_model",
      "replan",
      "change_worker",
      "request_review",
      "ask_user",
      "stop",
    ]);
  });

  it("every failure category from #52 has a ladder; there is no second taxonomy", () => {
    expect(Object.keys(RECOVERY_LADDERS).sort()).toEqual([...FAILURE_CATEGORIES].sort());
  });

  it("no ladder contains a terminal response: terminality comes from the bound, not the rung", () => {
    for (const [category, ladder] of Object.entries(RECOVERY_LADDERS)) {
      for (const response of ladder) {
        expect(isTerminalResponse(response), `${category} ladder contains ${response}`).toBe(false);
      }
    }
    expect([...TERMINAL_RESPONSES]).toEqual(["ask_user", "stop"]);
  });
});

describe("AC1: a task cannot loop more than the configured max attempts", () => {
  it("returns a terminal response the moment attemptsUsed reaches the cap", () => {
    const decision = chooseRecovery(input("implementation", { attemptsUsed: CONFIG.maxAttemptsPerTask }), CONFIG);
    expect(decision.terminal).toBe(true);
    expect(isTerminalResponse(decision.response)).toBe(true);
    expect(decision.policyRule).toBe("bound:max-attempts");
    expect(decision.attemptsRemaining).toBe(0);
  });

  it("never returns retry beyond the cap, for any category or attempt number", () => {
    for (const category of FAILURE_CATEGORIES) {
      for (let attempt = CONFIG.maxAttemptsPerTask; attempt <= CONFIG.maxAttemptsPerTask + 20; attempt += 1) {
        const decision = chooseRecovery(input(category, { attemptsUsed: attempt }), CONFIG);
        expect(decision.response, `${category} @ ${attempt}`).not.toBe("retry");
        expect(decision.terminal).toBe(true);
      }
    }
  });

  it("the projected ladder terminates within the cap for every category (no unbounded loop)", () => {
    for (const category of FAILURE_CATEGORIES) {
      const ladder = projectRecovery(input(category), CONFIG);
      expect(ladder.length, category).toBeGreaterThan(0);
      expect(ladder.length, category).toBeLessThanOrEqual(CONFIG.maxAttemptsPerTask);
      expect(ladder[ladder.length - 1]?.terminal, category).toBe(true);
    }
  });

  it("counts retries: at most maxAttemptsPerTask - 1 retries can ever be granted", () => {
    for (const category of FAILURE_CATEGORIES) {
      const retries = projectRecovery(input(category), CONFIG).filter((d) => d.response === "retry").length;
      expect(retries, category).toBeLessThanOrEqual(CONFIG.maxAttemptsPerTask - 1);
    }
  });

  it("a phase is bounded by maxAttemptsPerPhase, which is tighter than a task's", () => {
    expect(maxAttemptsFor("phase", CONFIG)).toBe(CONFIG.maxAttemptsPerPhase);
    expect(CONFIG.maxAttemptsPerPhase).toBeLessThanOrEqual(CONFIG.maxAttemptsPerTask);
    const decision = chooseRecovery(
      input("implementation", { subjectKind: "phase", attemptsUsed: CONFIG.maxAttemptsPerPhase }),
      CONFIG,
    );
    expect(decision.terminal).toBe(true);
  });

  it("a config that tried to allow unlimited attempts is still bounded by the schema maximum", () => {
    // The schema caps maxAttemptsPerTask at 10; a caller passing something
    // larger has bypassed validation, and the policy still terminates.
    const reckless: RecoveryConfig = { ...CONFIG, maxAttemptsPerTask: 50 };
    const ladder = projectRecovery(input("implementation"), reckless);
    expect(ladder[ladder.length - 1]?.terminal).toBe(true);
    expect(ladder.length).toBeLessThanOrEqual(reckless.maxAttemptsPerTask);
  });
});

describe("AC1: per-response caps bound each rung, not just the attempt total", () => {
  it("gather_evidence stops being offered once its cap is spent", () => {
    const usage = { gather_evidence: CONFIG.maxEvidenceGatherings };
    expect(responseAvailable("gather_evidence", CONFIG, usage)).toBe(false);
    const decision = chooseRecovery(input("environment", { usage }), CONFIG);
    expect(decision.response).not.toBe("gather_evidence");
    expect(decision.terminal).toBe(true);
  });

  it("fallback_model stops being offered once its cap is spent", () => {
    const decision = chooseRecovery(
      input("service", { usage: { fallback_model: CONFIG.maxModelFallbacks } }),
      CONFIG,
    );
    expect(decision.response).not.toBe("fallback_model");
    expect(decision.terminal).toBe(true);
  });

  it("replan stops being offered once its cap is spent", () => {
    const decision = chooseRecovery(input("test_expectation", { usage: { replan: CONFIG.maxReplans } }), CONFIG);
    expect(decision.response).not.toBe("replan");
  });
});

describe("responses are chosen FROM the #52 classification, not re-derived", () => {
  it("missing_information asks the user immediately: retrying invents nothing", () => {
    const decision = chooseRecovery(input("missing_information"), CONFIG);
    expect(decision.response).toBe(CONFIG.finalResponse);
    expect(decision.terminal).toBe(true);
  });

  it("test_expectation replans rather than re-running a wrong assertion", () => {
    expect(chooseRecovery(input("test_expectation"), CONFIG).response).toBe("replan");
    expect(RECOVERY_LADDERS.test_expectation).not.toContain("retry");
  });

  it("service does not retry the same route: #26 already retried and tripped the breaker", () => {
    expect(chooseRecovery(input("service"), CONFIG).response).toBe("fallback_model");
    expect(RECOVERY_LADDERS.service).not.toContain("retry");
  });

  it("quota changes route rather than hammering a rate limit", () => {
    expect(chooseRecovery(input("quota"), CONFIG).response).toBe("fallback_model");
    expect(RECOVERY_LADDERS.quota).not.toContain("retry");
  });

  it("harness (a truncated turn, #124) retries the harness, then changes worker", () => {
    expect(chooseRecovery(input("harness"), CONFIG).response).toBe("retry");
    expect(chooseRecovery(input("harness", { attemptsUsed: 2 }), CONFIG).response).toBe("change_worker");
  });

  it("an unknown classification gathers the evidence it asked for, and never acts on the guess", () => {
    const real = classifyFailure({ stderr: "something nobody has a rule for" });
    expect(real.category).toBe("unknown");
    const decision = chooseRecovery({ classification: real, attemptsUsed: 1, subjectKind: "task" }, CONFIG);
    expect(decision.response).toBe("gather_evidence");
    expect(decision.evidenceRequests.length).toBeGreaterThan(0);
    expect(decision.policyRule).toBe("evidence:needs-evidence");
  });

  it("needsEvidence overrides the ladder even for a named category", () => {
    const decision = chooseRecovery(
      input("implementation", {
        classification: { ...classified("implementation"), needsEvidence: true, evidenceRequests: ["re-run npm test"] },
      }),
      CONFIG,
    );
    expect(decision.response).toBe("gather_evidence");
  });
});

describe("stall signals from #52 escalate the ladder instead of repeating a rung", () => {
  it("a repeated_approach stall advances implementation past a plain retry", () => {
    const plain = chooseRecovery(input("implementation"), CONFIG);
    const stalled = chooseRecovery(input("implementation", { stalls: [stall("repeated_approach")] }), CONFIG);
    expect(plain.response).toBe("retry");
    expect(stalled.response).toBe("fallback_model");
    expect(stalled.reason).toContain("repeated_approach");
  });

  it("a scope_drift stall does not skip a rung: it is not a signal about the approach", () => {
    expect(chooseRecovery(input("implementation", { stalls: [stall("scope_drift")] }), CONFIG).response).toBe("retry");
  });
});

describe("AC2 (pure half): a flagged side-effect step is not retried without reconciliation", () => {
  const step = { stepId: "deploy", sideEffect: true };

  it("an unreconciled side-effect step gets a terminal response, never retry", () => {
    const decision = chooseRecovery(input("implementation", { step }), CONFIG);
    expect(decision.response).toBe(CONFIG.unreconcilableSideEffect);
    expect(decision.terminal).toBe(true);
    expect(decision.policyRule).toBe("side-effect:unknown");
    expect(isTerminalResponse(decision.response)).toBe(true);
  });

  it("'already applied' is not permission to retry either", () => {
    const decision = chooseRecovery(
      input("implementation", {
        step,
        reconciliation: { status: "already_applied", source: "action_receipt", detail: "receipt exists" },
      }),
      CONFIG,
    );
    expect(decision.response).not.toBe("retry");
    expect(decision.terminal).toBe(true);
  });

  it("'partially applied' and 'unknown' are never permission to retry", () => {
    for (const status of ["partially_applied", "unknown"] as const) {
      const decision = chooseRecovery(
        input("implementation", { step, reconciliation: { status, source: "probe", detail: "d" } }),
        CONFIG,
      );
      expect(decision.response, status).not.toBe("retry");
      expect(retryPermittedAfter({ status, source: "probe", detail: "d" })).toBe(false);
    }
  });

  it("'not applied' is the only verdict that unblocks a retry", () => {
    const decision = chooseRecovery(
      input("implementation", {
        step,
        reconciliation: { status: "not_applied", source: "probe", detail: "no commit found" },
      }),
      CONFIG,
    );
    expect(decision.response).toBe("retry");
  });

  it("a step declared free of side effects retries without any probe", () => {
    const decision = chooseRecovery(input("implementation", { step: { stepId: "unit", sideEffect: false } }), CONFIG);
    expect(decision.response).toBe("retry");
  });

  it("the side-effect gate cannot be escaped by the attempt budget still having room", () => {
    for (let attempt = 1; attempt < CONFIG.maxAttemptsPerTask; attempt += 1) {
      const decision = chooseRecovery(input("implementation", { step, attemptsUsed: attempt }), CONFIG);
      expect(decision.response, `attempt ${attempt}`).not.toBe("retry");
    }
  });
});

describe("reconcileStep establishes the outcome before anything is retried", () => {
  it("a probe that throws yields unknown, not 'not applied'", () => {
    const outcome = reconcileStep(
      { stepId: "push", sideEffect: true, reconciliationProbe: { probeId: "p", description: "git log" } },
      {
        runProbe: () => {
          throw new Error("git unavailable");
        },
      },
    );
    expect(outcome.status).toBe("unknown");
    expect(retryPermittedAfter(outcome)).toBe(false);
  });

  it("a side-effect step with no declared probe is unknown, never assumed safe", () => {
    const outcome = reconcileStep({ stepId: "publish", sideEffect: true });
    expect(outcome.status).toBe("unknown");
    expect(outcome.source).toBe("unreconciled");
  });

  it("maps probe verdicts to statuses and never invents one", () => {
    const probe = { probeId: "p", description: "check remote" };
    const run = (applied: boolean | "partial" | "unknown") =>
      reconcileStep({ stepId: "s", sideEffect: true, reconciliationProbe: probe }, {
        runProbe: () => ({ applied, detail: "d" }),
      }).status;
    expect(run(true)).toBe("already_applied");
    expect(run(false)).toBe("not_applied");
    expect(run("partial")).toBe("partially_applied");
    expect(run("unknown")).toBe("unknown");
  });
});

describe("every decision explains itself from recorded inputs", () => {
  it("names the policy rule, the category and the attempt count", () => {
    const decision = chooseRecovery(input("implementation"), CONFIG);
    const line = describeRecovery(decision);
    expect(line).toContain(decision.policyRule);
    expect(line).toContain("implementation");
    expect(line).toContain(`${decision.attemptsUsed}/${decision.maxAttempts}`);
  });

  it("every response in every ladder is a member of the fixed menu", () => {
    const all: RecoveryResponse[] = Object.values(RECOVERY_LADDERS).flatMap((l) => [...l]);
    for (const response of all) expect(RECOVERY_RESPONSES).toContain(response);
  });
});
