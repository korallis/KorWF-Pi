/**
 * `MockJevTransport` (issue #24) — the only transport tests are allowed to
 * exercise directly (`HttpJevTransport` is tested against a local fake HTTP
 * server, never this mock and never the real API). Scripted responses plus a
 * call recorder, so a test can assert both "what was asked" and "what came
 * back" without a network.
 */
import { defaultOutboundPolicy, type FilteredRequest } from "../security/outbound.ts";
import type {
  JevEvaluateOptions,
  JevEvaluateResult,
  JevTransport,
  SystemOneRequest,
} from "./transport.ts";

/**
 * Mint a `FilteredRequest` for a test that wants to exercise the transport
 * directly. It really does run the shipped outbound policy — there is no
 * unfiltered path, in tests or otherwise (issue #28) — so a fixture carrying
 * a denied path or a credential shape comes back filtered, as it would in
 * production.
 */
export function filterForTest(request: SystemOneRequest): FilteredRequest {
  return defaultOutboundPolicy().filterRequest(request);
}

export interface MockCall {
  readonly request: SystemOneRequest;
  readonly options: JevEvaluateOptions | undefined;
  readonly at: number;
}

export type MockResponder = (
  request: SystemOneRequest,
  options: JevEvaluateOptions | undefined,
) => JevEvaluateResult | Promise<JevEvaluateResult>;

export interface MockJevTransportOptions {
  /** Fixed queue of results, consumed in order, one per `evaluate` call. */
  readonly responses?: readonly JevEvaluateResult[];
  /** Computed responder, takes priority over `responses` when both are given. */
  readonly responder?: MockResponder;
  /** Result `ping()` returns; defaults to a synthetic ok response. */
  readonly pingResponse?: JevEvaluateResult;
}

const DEFAULT_PING_OK: JevEvaluateResult = {
  kind: "ok",
  response: { model: "mock", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } },
  requestId: "mock-ping",
  attempts: 1,
  elapsedMs: 0,
};

/**
 * A transport wholly under test control. Never touches the network. Records
 * every call (request + options) so tests can assert on what the adapter
 * sent, including that no key material ever appears in a recorded call.
 */
export class MockJevTransport implements JevTransport {
  readonly kind = "mock" as const;
  readonly calls: MockCall[] = [];
  readonly pingCalls: MockCall[] = [];

  #queue: JevEvaluateResult[];
  #responder: MockResponder | undefined;
  #pingResponse: JevEvaluateResult;

  constructor(options: MockJevTransportOptions = {}) {
    this.#queue = [...(options.responses ?? [])];
    this.#responder = options.responder;
    this.#pingResponse = options.pingResponse ?? DEFAULT_PING_OK;
  }

  async evaluate(request: FilteredRequest, options?: JevEvaluateOptions): Promise<JevEvaluateResult> {
    this.calls.push({ request, options, at: Date.now() });
    if (this.#responder) return this.#responder(request, options);
    const next = this.#queue.shift();
    if (next === undefined) {
      throw new Error("MockJevTransport: no scripted response left for evaluate() call");
    }
    return next;
  }

  async ping(options?: JevEvaluateOptions): Promise<JevEvaluateResult> {
    this.pingCalls.push({
      request: { state: "", model: "mock", questions: {} },
      options,
      at: Date.now(),
    });
    return this.#pingResponse;
  }

  /** Push another scripted response onto the queue. */
  enqueue(result: JevEvaluateResult): void {
    this.#queue.push(result);
  }

  /** Replace the responder mid-test. */
  setResponder(responder: MockResponder | undefined): void {
    this.#responder = responder;
  }
}
