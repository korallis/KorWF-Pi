/**
 * Composition of the deterministic taxonomy with `failure.classify@1`
 * (issue #52; PLAN §3.G, §6).
 *
 * `src/workflow/failure.ts` is pure and has no transport; this is the thin
 * layer that asks Jev for the residue the rules declined to decide. It lives
 * apart so `failure.ts` stays importable by anything, key or no key.
 *
 * Rules always win. A Jev answer can never overturn a deterministic match,
 * and a low-confidence or abstaining answer lands back on `unknown` with its
 * evidence requests intact — the system works with no Jev key, and an
 * `unknown` that asks for evidence is the correct answer, not a degradation.
 */
import { ask, type AskContext } from "../decisions/ask.ts";
import { failureClassifyQuestion, type FailureClassifyState } from "../decisions/questions/failure.ts";
import {
  classifyFailureByRules,
  unknownClassification,
  type FailureClassification,
  type FailureSignal,
} from "./failure.ts";

/** Bytes of each captured stream sent outbound. The outbound policy (#28) caps again. */
export const CLASSIFY_TAIL_BYTES = 2000;

function tail(text: string | undefined, limit = CLASSIFY_TAIL_BYTES): string {
  const value = text ?? "";
  return value.length <= limit ? value : value.slice(value.length - limit);
}

/** Build the minimal outbound state from a signal. Already-redacted input only. */
export function failureClassifyState(signal: FailureSignal, taskGoal: string): FailureClassifyState {
  return {
    command: signal.command ?? "",
    exitCode: signal.exitCode ?? null,
    stderrTail: tail(signal.stderr),
    stdoutTail: tail(signal.stdout),
    taskGoal,
  };
}

/**
 * Classify a failure, consulting Jev only for what the rules could not
 * decide. Never throws: a transport failure is a `fallback` to `unknown`.
 */
export async function classifyFailureWithJev(
  ctx: AskContext,
  signal: FailureSignal,
  options: { readonly taskGoal?: string } = {},
): Promise<FailureClassification> {
  const ruled = classifyFailureByRules(signal);
  if (!ruled.needsJev) return ruled.classification;

  let result;
  try {
    result = await ask(ctx, failureClassifyQuestion, failureClassifyState(signal, options.taskGoal ?? ""));
  } catch (error) {
    return unknownClassification(signal, {
      source: "fallback",
      rule: "failure.classify:transport_error",
      reason: `Jev could not be consulted (${error instanceof Error ? error.name : "error"}); no rule matched, so the failure is unknown.`,
    });
  }

  if (result.source !== "jev" || result.value === "unknown") {
    return unknownClassification(signal, {
      source: result.source === "jev" ? "jev" : "fallback",
      rule: result.rule,
      reason:
        result.source === "jev"
          ? "Jev answered `unknown`: the captured output does not support any category."
          : `No rule matched and no Jev answer was available (${result.reason ?? "fallback"}).`,
    });
  }

  return Object.freeze({
    category: result.value,
    confidence: result.confidence ?? 0,
    rule: result.rule,
    source: "jev" as const,
    reason: `failure.classify@1 answered ${result.value}.`,
    needsEvidence: false,
    evidenceRequests: Object.freeze([]),
  });
}
