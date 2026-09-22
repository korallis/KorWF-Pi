/**
 * Parsing planner output into a validated `PlanDocument` (issue #37).
 *
 * The reuse table (docs/pi-integration-map.md row 13) settled how a model
 * returns structured data here: a tool call with a typed schema, the same
 * mechanism `structured-output.ts` uses, so the payload arrives as JSON rather
 * than prose. That mechanism still yields *untrusted* JSON, and a model that
 * cannot call tools falls back to emitting JSON in a message, so this module
 * accepts both and is the single place either is turned into a plan.
 *
 * Two rules the issue requires:
 *
 * - Malformed output is rejected with **path-qualified** errors and produces a
 *   retry prompt. Nothing is persisted, not even the valid parts — the caller
 *   never sees a `PlanDocument` from a failed parse.
 * - The retry prompt quotes the actual findings, so a second attempt is not a
 *   blind re-roll.
 *
 * Pure: no I/O, no model call, no clock.
 */
import {
  formatPlanIssues,
  validatePlanDocument,
  type PlanDocument,
  type PlanIssue,
  type PlanValidation,
} from "./plan-schema.ts";

/** Outcome of parsing raw planner output. */
export type PlanParseResult =
  | { readonly ok: true; readonly plan: PlanDocument; readonly warnings: readonly PlanIssue[] }
  | {
      readonly ok: false;
      readonly errors: readonly PlanIssue[];
      readonly warnings: readonly PlanIssue[];
      /** Prompt to send back to the planner for attempt N+1. */
      readonly retryPrompt: string;
    };

/** Maximum bytes of planner output considered. Beyond this the output is refused. */
export const MAX_PLAN_BYTES = 512 * 1024;

/**
 * Parse planner output that is already a parsed value (the structured-output
 * tool-call path) or a JSON string / fenced block (the message path).
 */
export function parsePlanOutput(raw: unknown): PlanParseResult {
  const extracted = typeof raw === "string" ? extractJson(raw) : { ok: true as const, value: raw };
  if (!extracted.ok) {
    const errors = [extracted.issue];
    return { ok: false, errors, warnings: [], retryPrompt: buildRetryPrompt(errors, []) };
  }
  const validation: PlanValidation = validatePlanDocument(extracted.value);
  if (validation.ok) return { ok: true, plan: validation.plan, warnings: validation.warnings };
  return {
    ok: false,
    errors: validation.errors,
    warnings: validation.warnings,
    retryPrompt: buildRetryPrompt(validation.errors, validation.warnings),
  };
}

type Extracted = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issue: PlanIssue };

/**
 * Pull a JSON object out of a model message: the whole string when it is
 * already JSON, otherwise the contents of the first ```json fence, otherwise
 * the first balanced `{...}` span. Brace scanning is string-aware, so a brace
 * inside a check command does not truncate the document.
 */
export function extractJson(text: string): Extracted {
  if (Buffer.byteLength(text, "utf8") > MAX_PLAN_BYTES) {
    return {
      ok: false,
      issue: {
        rule: "range",
        path: "",
        severity: "error",
        message: `planner output exceeds ${MAX_PLAN_BYTES} bytes; emit fewer, smaller tasks rather than one huge document`,
      },
    };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      issue: { rule: "required", path: "", severity: "error", message: "planner produced no output" },
    };
  }

  const candidates: string[] = [];
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const span = balancedObject(trimmed);
  if (span !== null) candidates.push(span);

  let lastMessage = "no JSON object found in planner output";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ok: false,
    issue: {
      rule: "type",
      path: "",
      severity: "error",
      message: `planner output is not valid JSON: ${lastMessage}`,
    },
  };
}

/** First balanced `{...}` span, ignoring braces inside JSON strings. */
function balancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
