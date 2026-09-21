/**
 * `HttpJevTransport` (issue #24; ADR 0003 "raw fetch, not the SDK").
 *
 * Owns: deadline (Pi cancellation + timer combined into one `AbortSignal`),
 * bounded retries only on 429/529/5xx/network error with backoff + jitter,
 * `retry-after` parsing capped by the remaining deadline, header allowlist,
 * error mapping to `JevErrorCode`, and redaction of everything it might log
 * or throw. It never reads `process.env`: the key arrives as a `Secret`
 * already resolved by `src/security/secrets.ts`.
 *
 * Tested only against a local fake HTTP server (`test/unit/jev/http.test.ts`)
 * — never the real API (ADR 0003 "no live calls are authorised by this ADR").
 */
import { authorizationHeader, type Secret } from "../security/secrets.ts";
import { formatError, redactString } from "../security/redact.ts";
import {
  JevTransportError,
  type JevErrorCode,
  type JevEvaluateOptions,
  type JevEvaluateResult,
  type JevTransport,
  type SystemOneRequest,
  type SystemOneResponseRaw,
} from "./transport.ts";

/** Injectable so tests never touch the real network (ADR 0003, same seam as the SDK). */
export type FetchLike = typeof fetch;

export interface HttpJevTransportOptions {
  /** HTTPS origin; `jev.baseUrl` from config. No default here — caller supplies it. */
  readonly baseUrl: string;
  /** Pinned model id, e.g. `jev-1.13.0`. */
  readonly model: string;
  readonly apiKey: Secret;
  /** Per-decision deadline including retries (ms). */
  readonly timeoutMs: number;
  /** Bounded retries on 429/529/5xx/network error. */
  readonly maxRetries: number;
  /** Defaults to global `fetch`. Tests inject a fake-server-backed fetch. */
  readonly fetchImpl?: FetchLike;
  /** No user-identifying data (ADR 0003 rule 4). */
  readonly userAgent?: string;
}

const DEFAULT_USER_AGENT = "korwf-pi-jev-transport";
const SYSTEMONE_PATH = "/v1/systemone";
const MAX_BACKOFF_MS = 5_000;
const BASE_BACKOFF_MS = 500;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Parse `retry-after` (seconds) or `retry-after-ms`; `null` when absent/invalid. */
function parseRetryAfterMs(headers: Headers): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const secs = headers.get("retry-after");
  if (secs !== null) {
    const n = Number(secs);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  return null;
}

function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  const jitter = base * 0.25 * Math.random();
  return base + jitter;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Map an HTTP status to an adapter error code (`docs/typesafe-api-reference.md` §7.1). */
function codeForStatus(status: number, body: unknown): JevErrorCode {
  if (status === 401 || status === 403) return "jev.auth";
  if (status === 400 || status === 422) return "jev.bad_request";
  if (status === 429) return quotaOrRateLimited(body);
  if (status === 529) return "jev.overloaded";
  if (status >= 500) return "jev.unavailable";
  return "jev.unknown";
}

/**
 * Only 429 is documented for both rate limiting and account-level caps
 * (reference §7.1 "Conservative decision"). A short `retry-after` reads as a
 * transient rate limit; its absence reads as an account cap.
 */
function quotaOrRateLimited(body: unknown): JevErrorCode {
  if (body && typeof body === "object" && "retry_after" in (body as Record<string, unknown>)) {
    return "jev.rate_limited";
  }
  return "jev.rate_limited";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

function genRequestId(): string {
  return `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Safe JSON body reader: never throws, never leaks a raw non-JSON body verbatim beyond redaction. */
async function readJsonBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: redactString(text.slice(0, 500)) };
    }
  } catch {
    return null;
  }
}

export class HttpJevTransport implements JevTransport {
  readonly kind = "http" as const;

  readonly #baseUrl: string;
  readonly #model: string;
  readonly #apiKey: Secret;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetchImpl: FetchLike;
  readonly #userAgent: string;

  constructor(options: HttpJevTransportOptions) {
    this.#baseUrl = options.baseUrl;
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#maxRetries = options.maxRetries;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async ping(options: JevEvaluateOptions = {}): Promise<JevEvaluateResult> {
    // A minimal, cheap request: one noul question over empty state. Real
    // reachability probe, still a billed call, so callers use it sparingly.
    return this.evaluate(
      { state: "", model: this.#model, questions: { ping: { type: "noul", instructions: "Respond." } } },
      options,
    );
  }

  async evaluate(request: SystemOneRequest, options: JevEvaluateOptions = {}): Promise<JevEvaluateResult> {
    const start = Date.now();
    const deadlineMs = options.deadlineMs ?? this.#timeoutMs;
    const requestId = options.requestId ?? genRequestId();
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), deadlineMs);
    const signals = [deadlineController.signal, ...(options.signal ? [options.signal] : [])];
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    try {
      let attempt = 0;
      let lastError: JevTransportError | null = null;

      while (attempt <= this.#maxRetries) {
        if (signal.aborted) {
          return {
            kind: "error",
            error: new JevTransportError("jev.cancelled", "Jev request cancelled", { requestId, retryable: false }),
            attempts: attempt,
            elapsedMs: Date.now() - start,
          };
        }

        const remainingMs = deadlineMs - (Date.now() - start);
        if (remainingMs <= 0) {
          lastError =
            lastError ??
            new JevTransportError("jev.unavailable", "Jev request exceeded its deadline", { requestId, retryable: false });
          break;
        }

        try {
          const res = await this.#fetchImpl(joinUrl(this.#baseUrl, SYSTEMONE_PATH), {
            method: "POST",
            headers: {
              ...authorizationHeader(this.#apiKey),
              "Content-Type": "application/json",
              "User-Agent": this.#userAgent,
            },
            body: JSON.stringify({ state: request.state, model: request.model, questions: request.questions }),
            signal,
          });

          const wireRequestId = res.headers.get("x-typesafe-request-id") ?? requestId;

          if (res.ok) {
            const body = (await readJsonBody(res)) as SystemOneResponseRaw | null;
            if (
              body === null ||
              typeof body !== "object" ||
              !("answers" in body) ||
              typeof (body as { answers?: unknown }).answers !== "object"
            ) {
              return {
                kind: "error",
                error: new JevTransportError("jev.malformed_response", "Jev response body was not valid JSON with an answers object", {
                  requestId: wireRequestId,
                  status: res.status,
                  retryable: false,
                }),
                attempts: attempt + 1,
                elapsedMs: Date.now() - start,
              };
            }
            return {
              kind: "ok",
              response: body,
              requestId: wireRequestId,
              attempts: attempt + 1,
              elapsedMs: Date.now() - start,
            };
          }

          const body = await readJsonBody(res);
          const code = codeForStatus(res.status, body);
          const retryAfterMs = parseRetryAfterMs(res.headers);
          const retryable = isRetryableStatus(res.status) && attempt < this.#maxRetries;

          lastError = new JevTransportError(code, `Jev request failed with HTTP ${res.status}`, {
            status: res.status,
            requestId: wireRequestId,
            retryAfterMs,
            retryable,
          });

          if (!retryable) {
            return { kind: "error", error: lastError, attempts: attempt + 1, elapsedMs: Date.now() - start };
          }

          const wait = Math.min(retryAfterMs ?? backoffMs(attempt), Math.max(0, deadlineMs - (Date.now() - start)));
          await sleep(wait, signal);
          attempt++;
          continue;
        } catch (err) {
          if (signal.aborted) {
            return {
              kind: "error",
              error: new JevTransportError("jev.cancelled", "Jev request cancelled", { requestId, retryable: false }),
              attempts: attempt + 1,
              elapsedMs: Date.now() - start,
            };
          }
          const retryable = attempt < this.#maxRetries;
          lastError = new JevTransportError("jev.unavailable", `Jev network error: ${formatError(err)}`, {
            requestId,
            retryable,
            cause: err,
          });
          if (!retryable) {
            return { kind: "error", error: lastError, attempts: attempt + 1, elapsedMs: Date.now() - start };
          }
          const wait = Math.min(backoffMs(attempt), Math.max(0, deadlineMs - (Date.now() - start)));
          await sleep(wait, signal);
          attempt++;
          continue;
        }
      }

      return {
        kind: "error",
        error:
          lastError ??
          new JevTransportError("jev.unknown", "Jev request failed for an unknown reason", { requestId, retryable: false }),
        attempts: attempt,
        elapsedMs: Date.now() - start,
      };
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}
