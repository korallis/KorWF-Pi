/**
 * `DisabledJevTransport` (issue #24; PLAN §3.J, ADR 0007).
 *
 * The implementation `createJev` returns when there is no key, or
 * `jev.enabled` is false, or a caller opts out explicitly. Every call
 * resolves immediately with `{ kind: "disabled", message }`: no network
 * attempt, no timer, no retry, nothing to cancel. This is what makes "no key
 * ⇒ Jev features off with a clear message, never a crash" true by
 * construction rather than by every caller remembering to check first.
 */
import type { FilteredRequest } from "../security/outbound.ts";
import type { JevEvaluateOptions, JevEvaluateResult, JevTransport } from "./transport.ts";

const DEFAULT_MESSAGE =
  "Jev assistance is off: every Jev-assisted decision takes its deterministic fallback. The workflow is unaffected.";

export class DisabledJevTransport implements JevTransport {
  readonly kind = "disabled" as const;
  readonly #message: string;

  constructor(message: string = DEFAULT_MESSAGE) {
    this.#message = message;
  }

  evaluate(_request: FilteredRequest, _options?: JevEvaluateOptions): Promise<JevEvaluateResult> {
    return Promise.resolve({ kind: "disabled", message: this.#message });
  }

  ping(_options?: JevEvaluateOptions): Promise<JevEvaluateResult> {
    return Promise.resolve({ kind: "disabled", message: this.#message });
  }
}
