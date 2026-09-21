/**
 * The composition layer (issue #27; PLAN §6 "minimal relevant state per
 * evaluation; batch independent questions; stage dependent ones").
 *
 * `ask` answers one question. `askAll` answers a set of *independent*
 * questions: those sharing one state go out as a single multi-question
 * request (the Jev API takes one state and many questions), and distinct
 * states are issued concurrently up to a cap. `askStaged` runs dependent
 * groups in order, each group internally batched, so a later stage can use
 * the earlier stage's answers.
 *
 * Three rules hold on every path:
 *
 * 1. **Nothing throws for a bad answer.** Transport errors, malformed
 *    responses, missing answers and abstentions all resolve to the
 *    question's deterministic fallback (PLAN §2.4).
 * 2. **Every answer is recorded.** A `Decision` row is written for each
 *    question, including in disabled mode, where `policyRule` is exactly
 *    `"fallback"` and `jevModelVersion` is `null`.
 * 3. **The raw distribution is preserved** as returned, alongside the
 *    interpreted action (PLAN §6, docs/records.md §Decision).
 *
 * The decomposition lesson from `scripts/orchestrate/` applies to callers,
 * not to this file: ask one bounded question per criterion and take the
 * conjunction in code (`allTrue` in `compose.ts`) rather than one broad
 * existential question whose probability deflates with scope size.
 */
import { createHash } from "node:crypto";
import type { JevEvaluateOptions, JevTransport, SystemOneRequest } from "../jev/transport.ts";
import { defaultOutboundPolicy, outboundReportOf, type OutboundPolicy } from "../security/outbound.ts";
import { validateResponse, type JevAnswer, type ValidatedAnswer } from "../jev/validate.ts";
import type { Distribution } from "../storage/records.ts";
import { canonicalJson } from "../storage/repos/base.ts";
import {
  abstentionOf,
  type FallbackReason,
  type QuestionDefinition,
} from "./question.ts";
import { FALLBACK_USAGE, UNPRICED_JEV_USAGE, type DecisionDraft, type DecisionRecorder, type DecisionSubject } from "./record.ts";

/** Default cap on in-flight Jev requests from one `askAll` (PLAN §6 batching). */
export const DEFAULT_CONCURRENCY = 4;

/** One answered question, whatever produced the answer. */
export interface DecisionResult<TResult> {
  /** `id@version` of the question that was asked. */
  readonly key: string;
  readonly value: TResult;
  /** `"jev"` when a validated, non-abstaining answer was interpreted. */
  readonly source: "jev" | "fallback";
  /** `Decision.policyRule`; exactly `"fallback"` for an unqualified fallback. */
  readonly rule: string;
  readonly action: string;
  /** Why the fallback was used; `null` when Jev answered. */
  readonly reason: FallbackReason | null;
  /** Raw distribution exactly as returned; `{}` for a fallback. */
  readonly distribution: Distribution;
  readonly confidence: number | null;
  readonly stateHash: string;
  readonly jevModelVersion: string | null;
  readonly latencyMs: number | null;
  /** Id of the recorded Decision row, or `null` with no recorder attached. */
  readonly decisionId: string | null;
  /** True when this result was replayed from a matching recorded Decision. */
  readonly reused: boolean;
}

/** Everything `ask` needs. Transport and recorder are both injectable. */
export interface AskContext {
  readonly transport: JevTransport;
  /** Writes Decision rows. Omit only in pure unit tests of interpretation. */
  readonly recorder?: DecisionRecorder;
  /** Jev model id sent on the request and pinned for version checking. */
  readonly model: string;
  /** Per-call deadline forwarded to the transport. */
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  /** Monotonic clock, injectable for deterministic latency in tests. */
  readonly nowMs?: () => number;
  /**
   * Outbound data policy (issue #28, PLAN §7). Every request is filtered
   * through it before the transport sees it: denied paths dropped, secrets
   * redacted, byte caps applied. Omitted, the shipped defaults are used,
   * which are the strictest configuration — project config can only add deny
   * entries, never remove them — so forgetting to pass one cannot weaken the
   * policy.
   */
  readonly outbound?: OutboundPolicy;
  /** Called with the filter report for each request, for the decision trace. */
  readonly onOutbound?: (report: ReturnType<typeof outboundReportOf>) => void;
}

/** One question plus the input it is asked about. */
export interface AskItem<TState, TResult> {
  readonly question: QuestionDefinition<TState, TResult>;
  readonly input: TState;
  /** Subject recorded on the Decision; overrides the recorder's default. */
  readonly subject?: DecisionSubject;
  /**
   * Replay a recorded Decision with the same state hash instead of asking
   * again (docs/records.md §10 rule 4). Off by default: a caller opts in per
   * question, because only the caller knows whether the answer is
   * revision-sensitive.
   */
  readonly reuse?: boolean;
}

/**
 * Complete versioned cache key (PLAN §6 "cache only with complete versioned
 * keys"): the question identity, its exact wording, the Jev model, and the
 * minimal state. Any change to any of them is a different hash.
 */
export function hashState(
  definition: QuestionDefinition<unknown, unknown>,
  state: unknown,
  model: string,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        key: definition.key,
        contentHash: definition.contentHash,
        model,
        state,
      }),
    )
    .digest("hex");
}

/** Raw distribution for a validated answer, in the recorded form. */
export function distributionOf(answer: JevAnswer): Distribution {
  if (answer.type === "noul") return { true: answer.noul, false: 1 - answer.noul };
  return { ...answer.probabilities };
}

function confidenceOf(answer: JevAnswer): number | null {
  return answer.type === "noul" ? null : answer.confidence;
}

/** Map a validation failure onto the fallback reason recorded for it. */
function reasonForInvalid(answer: ValidatedAnswer<JevAnswer>): FallbackReason {
  if (answer.ok) return "invalid_response";
  return answer.code === "missing_answer" ? "missing_answer" : "invalid_response";
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

interface Resolved<TResult> {
  readonly value: TResult;
  readonly source: "jev" | "fallback";
  readonly rule: string;
  readonly action: string;
  readonly reason: FallbackReason | null;
  readonly distribution: Distribution;
  readonly confidence: number | null;
  readonly jevModelVersion: string | null;
}

/**
 * Resolve one validated answer (or the absence of one) to a typed result.
 * Pure: no I/O, no recording — so the interpretation policy can be tested on
 * its own, and so every caller below shares exactly one policy.
 */
export function resolveAnswer<TState, TResult>(
  question: QuestionDefinition<TState, TResult>,
  input: TState,
  answer: ValidatedAnswer<JevAnswer> | null,
  failure: FallbackReason | null,
  jevModelVersion: string | null,
): Resolved<TResult> {
  const definition = question as unknown as QuestionDefinition<unknown, unknown>;

  const fallbackWith = (reason: FallbackReason, distribution: Distribution, confidence: number | null): Resolved<TResult> => {
    const out = question.fallback(input, reason);
    return {
      value: out.value,
      source: "fallback",
      rule: out.rule === undefined ? "fallback" : `fallback:${out.rule}`,
      action: out.action,
      reason,
      distribution,
      confidence,
      jevModelVersion: null,
    };
  };

  if (failure !== null) return fallbackWith(failure, {}, null);
  if (answer === null) return fallbackWith("missing_answer", {}, null);
  if (!answer.ok) return fallbackWith(reasonForInvalid(answer), {}, null);

  const distribution = distributionOf(answer.value);
  const confidence = confidenceOf(answer.value);

  const abstained = abstentionOf(definition, answer.value);
  if (abstained !== null) return fallbackWith(abstained, distribution, confidence);

  const interpreted = question.interpret(answer.value, input);
  if (interpreted === null) return fallbackWith("answer_type_mismatch", distribution, confidence);

  return {
    value: interpreted.value,
    source: "jev",
    rule: interpreted.rule,
    action: interpreted.action,
    reason: null,
    distribution,
    confidence,
    jevModelVersion,
  };
}

function toResult<TResult>(
  question: QuestionDefinition<unknown, unknown>,
  resolved: Resolved<TResult>,
  stateHash: string,
  latencyMs: number | null,
  recorder: DecisionRecorder | undefined,
  subject: AskItem<unknown, unknown>["subject"],
  reused: boolean,
): DecisionResult<TResult> {
  let decisionId: string | null = null;
  if (recorder !== undefined) {
    const draft: DecisionDraft = {
      stateHash,
      questionId: question.id,
      questionVersion: question.version,
      jevModelVersion: resolved.jevModelVersion,
      rawDistribution: resolved.distribution,
      confidence: resolved.confidence,
      policyRule: resolved.rule,
      action: resolved.action,
      latencyMs,
      usage: resolved.source === "jev" ? UNPRICED_JEV_USAGE : FALLBACK_USAGE,
      ...(subject !== undefined ? { subject } : {}),
    };
    decisionId = recorder.record(draft).id;
  }
  return {
    key: question.key,
    value: resolved.value,
    source: resolved.source,
    rule: resolved.rule,
    action: resolved.action,
    reason: resolved.reason,
    distribution: resolved.distribution,
    confidence: resolved.confidence,
    stateHash,
    jevModelVersion: resolved.jevModelVersion,
    latencyMs,
    decisionId,
    reused,
  };
}

// ---------------------------------------------------------------------------
// one batch: one state, many independent questions
// ---------------------------------------------------------------------------

/** Map a transport failure onto the reason recorded for every question in it. */
function reasonForTransport(kind: "disabled" | "error", code: string | null): FallbackReason {
  if (kind === "disabled") return "disabled";
  return code === "jev.cancelled" ? "cancelled" : "transport_error";
}

type AnyItem = AskItem<unknown, unknown>;

function wireKeyFor(index: number, item: AnyItem): string {
  // Stable, collision-free within one request, and it carries the version so
  // a recorded request body is self-describing.
  return `q${index}:${item.question.key}`;
}

/**
 * Ask one group of items whose minimal states are identical, in a single
 * request (the API takes one state and many questions). Callers use `askAll`,
 * which does the grouping.
 */
async function askBatch(ctx: AskContext, state: unknown, items: readonly AnyItem[]): Promise<DecisionResult<unknown>[]> {
  if (items.length === 0) return [];
  const nowMs = ctx.nowMs ?? (() => Date.now());

  const stateHashes = items.map((item) => hashState(item.question, state, ctx.model));

  // Replay: a recorded decision for the same complete versioned key stands
  // (docs/records.md §10 rule 4). Only items that opted in are considered.
  const replayed = new Map<number, DecisionResult<unknown>>();
  if (ctx.recorder !== undefined) {
    for (const [index, item] of items.entries()) {
      if (item.reuse !== true) continue;
      const hash = stateHashes[index] ?? "";
      const prior = ctx.recorder.findReusable(item.question.id, item.question.version, hash);
      if (prior === undefined) continue;
      const value = item.question.replay(prior.action, item.input);
      if (value === null) continue;
      replayed.set(index, {
        key: item.question.key,
        value,
        source: prior.jevModelVersion === null ? "fallback" : "jev",
        rule: prior.policyRule,
        action: prior.action,
        reason: null,
        distribution: prior.rawDistribution,
        confidence: prior.confidence,
        stateHash: hash,
        jevModelVersion: prior.jevModelVersion,
        latencyMs: prior.latencyMs,
        decisionId: prior.id,
        reused: true,
      });
    }
  }

  const pending = items.map((item, index) => ({ item, index })).filter(({ index }) => !replayed.has(index));

  const results = new Array<DecisionResult<unknown>>(items.length);
  for (const [index, result] of replayed) results[index] = result;
  if (pending.length === 0) return results;

  const pendingRequest: SystemOneRequest = {
    state: state as SystemOneRequest["state"],
    model: ctx.model,
    questions: Object.fromEntries(pending.map(({ item, index }) => [wireKeyFor(index, item), item.question.buildQuestion()])),
  };

  const started = nowMs();
  const options: JevEvaluateOptions = {
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(ctx.deadlineMs !== undefined ? { deadlineMs: ctx.deadlineMs } : {}),
  };
  // Nothing reaches the transport unfiltered: `evaluate` takes only a
  // `FilteredRequest`, and this is the one place that mints one (issue #28).
  const policy = ctx.outbound ?? defaultOutboundPolicy();
  const filtered = policy.filterRequest(pendingRequest, "jev.decision");
  ctx.onOutbound?.(outboundReportOf(filtered));

  const outcome = await ctx.transport.evaluate(filtered, options);
  const latencyMs = outcome.kind === "disabled" ? null : nowMs() - started;

  if (outcome.kind !== "ok") {
    const reason = reasonForTransport(
      outcome.kind,
      outcome.kind === "error" ? outcome.error.code : null,
    );
    for (const { item, index } of pending) {
      const resolved = resolveAnswer(item.question, item.input, null, reason, null);
      results[index] = toResult(item.question, resolved, stateHashes[index] ?? "", latencyMs, ctx.recorder, item.subject, false);
    }
    return results;
  }

  const validated = validateResponse(filtered, outcome.response, { pinnedModel: ctx.model });
  const jevModel = typeof outcome.response.model === "string" ? outcome.response.model : ctx.model;
  for (const { item, index } of pending) {
    const answer = validated.answers[wireKeyFor(index, item)] ?? null;
    const resolved = resolveAnswer(item.question, item.input, answer, null, jevModel);
    results[index] = toResult(item.question, resolved, stateHashes[index] ?? "", latencyMs, ctx.recorder, item.subject, false);
  }
  return results;
}

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

/**
 * Ask one question about one input. Never throws: a disabled transport, a
 * transport error, an invalid response or an abstention all yield the
 * question's deterministic fallback, and a Decision row is written either way.
 */
export async function ask<TState, TResult>(
  ctx: AskContext,
  question: QuestionDefinition<TState, TResult>,
  input: TState,
  options: { readonly subject?: DecisionSubject; readonly reuse?: boolean } = {},
): Promise<DecisionResult<TResult>> {
  const results = await askAll(ctx, [
    {
      question,
      input,
      ...(options.subject !== undefined ? { subject: options.subject } : {}),
      ...(options.reuse !== undefined ? { reuse: options.reuse } : {}),
    },
  ]);
  const first = results[0];
  if (first === undefined) throw new Error("ask: askAll returned no result");
  // Safe: the single item carried this question, so its result carries this
  // question's result type; `askAll` erases it only to hold a mixed batch.
  return first as DecisionResult<TResult>;
}

export interface AskAllOptions {
  /** Max concurrent Jev requests. Defaults to `DEFAULT_CONCURRENCY`. */
  readonly concurrency?: number;
}

/**
 * Ask a set of **independent** questions. Items whose minimal state is
 * identical are merged into a single multi-question request; the remaining
 * groups are issued concurrently, never more than `concurrency` in flight.
 * Results come back in the order the items were given, whatever order the
 * requests completed in.
 */
export async function askAll(
  ctx: AskContext,
  items: readonly AskItem<unknown, unknown>[],
  options: AskAllOptions = {},
): Promise<DecisionResult<unknown>[]> {
  const cap = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));

  // Group by canonical state so one state with N questions is one request
  // (PLAN §6 "batch independent questions").
  const groups = new Map<string, { state: unknown; entries: { item: AskItem<unknown, unknown>; index: number }[] }>();
  for (const [index, item] of items.entries()) {
    const state = item.question.buildState(item.input);
    const groupKey = canonicalJson(state);
    const existing = groups.get(groupKey);
    if (existing === undefined) groups.set(groupKey, { state, entries: [{ item, index }] });
    else existing.entries.push({ item, index });
  }

  const out = new Array<DecisionResult<unknown>>(items.length);
  const groupList = [...groups.values()];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const mine = next;
      next += 1;
      const group = groupList[mine];
      if (group === undefined) return;
      const batch = await askBatch(
        ctx,
        group.state,
        group.entries.map(({ item }) => item),
      );
      for (const [position, { index }] of group.entries.entries()) {
        const result = batch[position];
        if (result !== undefined) out[index] = result;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, groupList.length) }, () => worker()));
  return out;
}

/** One stage of a dependent chain: questions built from earlier answers. */
export interface Stage<TCarry> {
  readonly name: string;
  /** Items to ask at this stage, given what earlier stages produced. */
  items: (carry: TCarry) => readonly AskItem<unknown, unknown>[];
  /** Fold this stage's results into the carry for the next stage. */
  reduce: (carry: TCarry, results: readonly DecisionResult<unknown>[]) => TCarry;
  /** Stop the chain early (e.g. a gate already failed). Optional. */
  readonly stopWhen?: (carry: TCarry) => boolean;
}

export interface StagedRun<TCarry> {
  readonly carry: TCarry;
  /** Results per stage, in order, for stages that actually ran. */
  readonly stages: readonly { readonly name: string; readonly results: readonly DecisionResult<unknown>[] }[];
  /** Name of the stage that stopped the chain, or `null` if all ran. */
  readonly stoppedAt: string | null;
}

/**
 * Run **dependent** questions in order (PLAN §6 "stage dependent ones").
 * Each stage is internally batched by `askAll`, so staging costs one round
 * trip per stage rather than one per question. A stage that asks nothing is
 * still recorded, with no results.
 */
export async function askStaged<TCarry>(
  ctx: AskContext,
  initial: TCarry,
  stages: readonly Stage<TCarry>[],
  options: AskAllOptions = {},
): Promise<StagedRun<TCarry>> {
  let carry = initial;
  const ran: { name: string; results: readonly DecisionResult<unknown>[] }[] = [];
  for (const stage of stages) {
    if (stage.stopWhen?.(carry) === true) {
      return { carry, stages: ran, stoppedAt: stage.name };
    }
    const results = await askAll(ctx, stage.items(carry), options);
    carry = stage.reduce(carry, results);
    ran.push({ name: stage.name, results });
  }
  return { carry, stages: ran, stoppedAt: null };
}
