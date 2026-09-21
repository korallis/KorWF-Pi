/**
 * Response validation for Choice / Score / Noul (issue #25; PLAN §6 "preserve
 * raw distributions; validate schemas and bounds"; `docs/typesafe-api-reference.md`
 * §3.4).
 *
 * This module sits BETWEEN `JevTransport.evaluate()` and any decision logic.
 * It never re-implements the transport (#24) and never throws: a malformed
 * or unexpected wire response becomes a typed `ValidatedAnswer` with
 * `ok: false`, exactly like a missing key — callers degrade to their
 * deterministic fallback either way. The raw payload is always preserved
 * alongside the validated (or rejected) value.
 */
import type { ChoiceQuestion, JevQuestion, NoulQuestion, ScoreQuestion, SystemOneRequest, SystemOneResponseRaw } from "./transport.ts";
import type { Logger } from "../security/redact.ts";

// ---------------------------------------------------------------------------
// validated answer shapes
// ---------------------------------------------------------------------------

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type JevValidationErrorCode =
  | "missing_answer"
  | "malformed_response"
  | "not_object"
  | "type_mismatch"
  | "bounds"
  | "invalid_choice"
  | "option_mismatch"
  | "key_mismatch"
  | "sum_mismatch";

export interface ValidatedAnswerOk<T extends JevAnswer> {
  readonly ok: true;
  readonly value: T;
  readonly raw: unknown;
}

export interface ValidatedAnswerError {
  readonly ok: false;
  readonly code: JevValidationErrorCode;
  readonly reason: string;
  readonly raw: unknown;
}

export type ValidatedAnswer<T extends JevAnswer> = ValidatedAnswerOk<T> | ValidatedAnswerError;

// ---------------------------------------------------------------------------
// whole-response validation
// ---------------------------------------------------------------------------

export interface ValidatedResponse {
  /** One entry per requested question key; never throws, always present. */
  readonly answers: Readonly<Record<string, ValidatedAnswer<JevAnswer>>>;
  /** `true` iff every answer validated ok. */
  readonly ok: boolean;
  /** `"match" | "mismatch" | "missing"` — never an exception (PLAN §6 pin). */
  readonly version: VersionCheck;
  readonly raw: unknown;
}

export type VersionCheck =
  | { readonly status: "match"; readonly model: string }
  | { readonly status: "mismatch"; readonly expected: string; readonly actual: string }
  | { readonly status: "missing" };

/** Floating-point tolerance for distribution sums (`docs/typesafe-api-reference.md` §3.4). */
export const SUM_TOLERANCE = 1e-3;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sumOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Validate a `model` field against the pinned version. Never throws; a
 * missing/non-string `model` is `"missing"` (reference §3.4 "model absent:
 * reject"), a mismatch is a *warning-level* result, not an error, so an
 * alias configured deliberately still produces usable answers (reference §5
 * point 3).
 */
export function checkVersion(rawModel: unknown, pinnedModel: string): VersionCheck {
  if (typeof rawModel !== "string" || rawModel.length === 0) return { status: "missing" };
  if (rawModel === pinnedModel) return { status: "match", model: rawModel };
  return { status: "mismatch", expected: pinnedModel, actual: rawModel };
}

/** Log a version mismatch exactly once per distinct (expected, actual) pair. */
const warnedMismatches = new Set<string>();

export function logVersionMismatchOnce(check: VersionCheck, logger?: Logger): void {
  if (check.status !== "mismatch") return;
  const key = `${check.expected}=>${check.actual}`;
  if (warnedMismatches.has(key)) return;
  warnedMismatches.add(key);
  logger?.warn("jev response model differs from pinned version", { expected: check.expected, actual: check.actual });
}

/** Test-only: forget which mismatches have already been logged. */
export function resetVersionMismatchLog(): void {
  warnedMismatches.clear();
}

// ---------------------------------------------------------------------------
// per-type validators
// ---------------------------------------------------------------------------

function reject(code: JevValidationErrorCode, reason: string, raw: unknown): ValidatedAnswerError {
  return { ok: false, code, reason, raw };
}

/** Noul: `docs/typesafe-api-reference.md` §3.1. No `confidence` field exists. */
export function validateNoulAnswer(raw: unknown, _question: NoulQuestion): ValidatedAnswer<NoulAnswer> {
  if (!isPlainObject(raw)) return reject("not_object", "answer is not an object", raw);
  if (raw["type"] !== "noul") return reject("type_mismatch", `expected type "noul", got ${JSON.stringify(raw["type"])}`, raw);
  const noul = raw["noul"];
  if (!isFiniteNumber(noul)) return reject("malformed_response", "noul is missing or not a finite number", raw);
  if (noul < 0 || noul > 1) return reject("bounds", `noul ${noul} outside [0,1]`, raw);
  return { ok: true, value: { type: "noul", noul }, raw };
}

/** Choice: `docs/typesafe-api-reference.md` §3.2. */
export function validateChoiceAnswer(raw: unknown, question: ChoiceQuestion): ValidatedAnswer<ChoiceAnswer> {
  if (!isPlainObject(raw)) return reject("not_object", "answer is not an object", raw);
  if (raw["type"] !== "choice") return reject("type_mismatch", `expected type "choice", got ${JSON.stringify(raw["type"])}`, raw);

  const options = Object.keys(question.criteria);
  const optionSet = new Set(options);

  const choice = raw["choice"];
  if (typeof choice !== "string") return reject("malformed_response", "choice is missing or not a string", raw);
  if (!optionSet.has(choice)) return reject("invalid_choice", `choice ${JSON.stringify(choice)} is not one of the request options`, raw);

  const probsRaw = raw["probabilities"];
  if (!isPlainObject(probsRaw)) return reject("malformed_response", "probabilities is missing or not an object", raw);
  const probKeys = Object.keys(probsRaw);
  if (probKeys.length !== options.length || !probKeys.every((k) => optionSet.has(k))) {
    return reject("option_mismatch", "probabilities keys do not match the request option set", raw);
  }
  const probabilities: Record<string, number> = {};
  for (const key of options) {
    const v = probsRaw[key];
    if (!isFiniteNumber(v)) return reject("malformed_response", `probabilities[${key}] is not a finite number`, raw);
    if (v < 0 || v > 1) return reject("bounds", `probabilities[${key}] = ${v} outside [0,1]`, raw);
    probabilities[key] = v;
  }
  const sum = sumOf(Object.values(probabilities));
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return reject("sum_mismatch", `probabilities sum to ${sum}, expected ~1`, raw);

  const confidence = raw["confidence"];
  if (!isFiniteNumber(confidence)) return reject("malformed_response", "confidence is missing or not a finite number", raw);
  if (confidence < 0 || confidence > 1) return reject("bounds", `confidence ${confidence} outside [0,1]`, raw);

  return { ok: true, value: { type: "choice", choice, probabilities, confidence }, raw };
}

/** Score: `docs/typesafe-api-reference.md` §3.3. */
export function validateScoreAnswer(raw: unknown, question: ScoreQuestion): ValidatedAnswer<ScoreAnswer> {
  if (!isPlainObject(raw)) return reject("not_object", "answer is not an object", raw);
  if (raw["type"] !== "score") return reject("type_mismatch", `expected type "score", got ${JSON.stringify(raw["type"])}`, raw);

  const levelCount = question.criteria.length;
  if (levelCount < 2) return reject("malformed_response", "score question has fewer than 2 levels", raw);
  const expectedKeys = Array.from({ length: levelCount }, (_, i) => String(i));
  const keySet = new Set(expectedKeys);

  const legendRaw = raw["legend"];
  if (!isPlainObject(legendRaw)) return reject("malformed_response", "legend is missing or not an object", raw);
  const legendKeys = Object.keys(legendRaw);
  if (legendKeys.length !== expectedKeys.length || !legendKeys.every((k) => keySet.has(k))) {
    return reject("key_mismatch", `legend keys do not match "0".."${levelCount - 1}"`, raw);
  }
  const legend: Record<string, string> = {};
  for (const key of expectedKeys) {
    const v = legendRaw[key];
    if (typeof v !== "string") return reject("malformed_response", `legend[${key}] is not a string`, raw);
    legend[key] = v;
  }

  const probsRaw = raw["probabilities"];
  if (!isPlainObject(probsRaw)) return reject("malformed_response", "probabilities is missing or not an object", raw);
  const probKeys = Object.keys(probsRaw);
  if (probKeys.length !== expectedKeys.length || !probKeys.every((k) => keySet.has(k))) {
    return reject("key_mismatch", `probabilities keys do not match "0".."${levelCount - 1}"`, raw);
  }
  const probabilities: Record<string, number> = {};
  for (const key of expectedKeys) {
    const v = probsRaw[key];
    if (!isFiniteNumber(v)) return reject("malformed_response", `probabilities[${key}] is not a finite number`, raw);
    if (v < 0 || v > 1) return reject("bounds", `probabilities[${key}] = ${v} outside [0,1]`, raw);
    probabilities[key] = v;
  }
  const sum = sumOf(Object.values(probabilities));
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return reject("sum_mismatch", `probabilities sum to ${sum}, expected ~1`, raw);

  const score = raw["score"];
  if (!isFiniteNumber(score)) return reject("malformed_response", "score is missing or not a finite number", raw);
  if (score < 0 || score > levelCount - 1) return reject("bounds", `score ${score} outside [0,${levelCount - 1}]`, raw);

  const confidence = raw["confidence"];
  if (!isFiniteNumber(confidence)) return reject("malformed_response", "confidence is missing or not a finite number", raw);
  if (confidence < 0 || confidence > 1) return reject("bounds", `confidence ${confidence} outside [0,1]`, raw);

  return { ok: true, value: { type: "score", score, legend, probabilities, confidence }, raw };
}

// ---------------------------------------------------------------------------
// whole-response entry point
// ---------------------------------------------------------------------------

/**
 * Validate a raw `SystemOneResponseRaw` against the `SystemOneRequest` that
 * produced it. Never throws: any malformed shape — including a non-object
 * `response`, a missing `answers` map, or a response that is not even
 * JSON-shaped — degrades to a `ValidatedResponse` whose answers are all
 * `ok: false`, carrying `raw` for diagnostics. A malformed response can never
 * reach decision logic as a decision (issue #25 acceptance criteria).
 */
export function validateResponse(
  request: SystemOneRequest,
  raw: unknown,
  options: { readonly pinnedModel?: string; readonly logger?: Logger } = {},
): ValidatedResponse {
  const pinnedModel = options.pinnedModel ?? request.model;

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      version: { status: "missing" },
      raw,
      answers: missingAnswersFor(request, raw, "response is not an object"),
    };
  }

  const response = raw as Partial<SystemOneResponseRaw>;
  const version = checkVersion(response.model, pinnedModel);
  logVersionMismatchOnce(version, options.logger);

  const answersRaw = response.answers;
  if (!isPlainObject(answersRaw)) {
    return {
      ok: false,
      version,
      raw,
      answers: missingAnswersFor(request, raw, "answers is missing or not an object"),
    };
  }

  const questionKeys = Object.keys(request.questions);
  const answerKeys = new Set(Object.keys(answersRaw));
  const answers: Record<string, ValidatedAnswer<JevAnswer>> = {};
  let allOk = true;

  for (const key of questionKeys) {
    const question = request.questions[key];
    if (question === undefined) continue;
    if (!answerKeys.has(key)) {
      answers[key] = reject("missing_answer", `no answer for requested question "${key}"`, raw);
      allOk = false;
      continue;
    }
    const validated = validateAnswer(answersRaw[key], question);
    answers[key] = validated;
    if (!validated.ok) allOk = false;
  }

  // Keys present in the response but never requested: not trusted, not
  // surfaced as an answer, but they do not themselves invalidate the keys
  // that were requested (reference §3.4 tolerates unknown extras elsewhere;
  // an *extra top-level answer key* is stricter — record it as its own
  // rejection so callers can see it happened, without touching the raw
  // response's preservation).
  for (const key of answerKeys) {
    if (!Object.prototype.hasOwnProperty.call(request.questions, key)) {
      allOk = false;
    }
  }

  return { ok: allOk, version, raw, answers };
}

function missingAnswersFor(request: SystemOneRequest, raw: unknown, reason: string): Record<string, ValidatedAnswer<JevAnswer>> {
  const answers: Record<string, ValidatedAnswer<JevAnswer>> = {};
  for (const key of Object.keys(request.questions)) {
    answers[key] = reject("malformed_response", reason, raw);
  }
  return answers;
}

/** Dispatch on the question's declared type. Never throws. */
export function validateAnswer(raw: unknown, question: JevQuestion): ValidatedAnswer<JevAnswer> {
  switch (question.type) {
    case "noul":
      return validateNoulAnswer(raw, question);
    case "choice":
      return validateChoiceAnswer(raw, question);
    case "score":
      return validateScoreAnswer(raw, question);
    default: {
      const _exhaustive: never = question;
      void _exhaustive;
      return reject("malformed_response", "unrecognised question type", raw);
    }
  }
}
