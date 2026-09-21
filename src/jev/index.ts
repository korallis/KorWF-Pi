/**
 * Jev transport adapter, validation, deadlines, usage, optional-mode
 * (issue #24; ADR 0003; PLAN §7, §3.J).
 *
 * Public surface: `createJev(config, options)` picks the transport — never
 * throws for a missing key. Import the transport interface and concrete
 * implementations from here rather than the individual files.
 */
export type {
  JevState,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  JevQuestion,
  SystemOneRequest,
  SystemOneUsage,
  SystemOneResponseRaw,
  JevErrorCode,
  JevEvaluateOk,
  JevEvaluateError,
  JevEvaluateDisabled,
  JevEvaluateResult,
  JevEvaluateOptions,
  JevTransport,
} from "./transport.ts";
export { JevTransportError, noulQuestion, choiceQuestion, scoreQuestion } from "./transport.ts";

export type { HttpJevTransportOptions, FetchLike } from "./http.ts";
export type { MockCall, MockResponder, MockJevTransportOptions } from "./mock.ts";
export { filterForTest } from "./mock.ts";

import type { KorwfConfig } from "../config/types.ts";
import { resolveJevKey, type ResolveOptions } from "../security/secrets.ts";
import { DisabledJevTransport } from "./disabled.ts";
import { HttpJevTransport, type FetchLike } from "./http.ts";
import { MockJevTransport } from "./mock.ts";
import type { JevTransport } from "./transport.ts";

export { HttpJevTransport, MockJevTransport, DisabledJevTransport };

export interface CreateJevOptions extends ResolveOptions {
  /** Injectable fetch; forwarded to `HttpJevTransport`. Tests always supply one. */
  readonly fetchImpl?: FetchLike;
}

/**
 * Choose the transport implementation for `config.jev`. Never throws: an
 * absent key, `jev.enabled === false`, or `keySource.kind === "none"` all
 * yield a `DisabledJevTransport` carrying the resolver's one clear message
 * (PLAN §3.J, ADR 0007). This is the single place product code should build
 * a transport from config.
 */
export function createJev(config: Pick<KorwfConfig, "jev">, options: CreateJevOptions = {}): JevTransport {
  const resolution = resolveJevKey(config, options);
  if (!resolution.jevEnabled || resolution.secret === null) {
    return new DisabledJevTransport(resolution.message);
  }
  return new HttpJevTransport({
    baseUrl: config.jev.baseUrl,
    model: config.jev.model,
    apiKey: resolution.secret,
    timeoutMs: config.jev.timeoutMs,
    maxRetries: config.jev.maxRetries,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}
