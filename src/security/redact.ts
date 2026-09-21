/**
 * Global redaction (issue #22; PLAN §7 "Jev transport", §10 "no credential
 * leakage in output, logs, artifacts, or exports").
 *
 * Two independent layers, because either one alone is insufficient:
 *
 *  1. **Registered values.** Every `Secret` created by `src/security/secrets.ts`
 *     registers its literal value here. If that exact string ever reaches a log
 *     sink, an error message, a trace record or an export, it is replaced.
 *  2. **Shape patterns.** Strings that *look* like credentials are redacted even
 *     if this process never resolved them — a key pasted into a prompt, a
 *     `Bearer` header echoed by an upstream error, an `apikey_…` in a stack
 *     trace. The pattern set is a strict superset of `scripts/check-secrets.sh`
 *     and of the shipped `privacy.denyPatterns` minimum
 *     (`src/config/schema.json` `$defs/ShippedDenyPatterns`), so nothing the
 *     repository scanner would reject can survive a log write.
 *
 * The module holds no credential of its own: registered values live in a
 * module-private set that is never enumerated, never serialised, and never
 * returned. `redactedValues()` reports a count, not the values.
 *
 * Nothing here throws. A redactor that failed would push callers towards
 * logging the raw value, so every entry point is total: unknown shapes,
 * cyclic objects, getters that throw, and non-string primitives all come back
 * as something safe to print.
 */

/** What a redacted span is replaced with. Stable so tests and users can grep it. */
export const REDACTED = "[redacted]" as const;

/** Shortest literal value that is worth registering; below this, redaction would eat prose. */
export const MIN_REGISTERED_SECRET_LENGTH = 8;

/**
 * Credential-shaped patterns, redacted whether or not this process resolved
 * the value. Each entry documents what it covers; every pattern the repo's own
 * scanner (`scripts/check-secrets.sh`) looks for appears here at least as
 * strictly, and so does every entry of the shipped `privacy.denyPatterns`
 * minimum.
 *
 * All patterns are global so `String.replace` redacts every occurrence, and
 * case-insensitive where the shape allows it. They are recreated per call
 * (`lastIndex` on a shared global regex is a classic source of missed matches).
 */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly source: string; readonly flags: string }[] = [
  // TypeSafe keys. The repo scanner's `apikey_` prefix, widened to the whole token.
  { name: "typesafe_api_key", source: String.raw`\bapikey_[A-Za-z0-9_-]+`, flags: "gi" },
  // OpenAI-style `sk-…` (scanner: `sk-` + 10 chars; here 8, so strictly stricter).
  { name: "sk_prefixed", source: String.raw`\bsk-[A-Za-z0-9_-]{8,}`, flags: "g" },
  // GitHub tokens: personal, OAuth, user-to-server, server-to-server, refresh.
  { name: "github_token", source: String.raw`\bgh[pousr]_[A-Za-z0-9]{10,}`, flags: "g" },
  // AWS access key ids.
  { name: "aws_access_key_id", source: String.raw`\bAKIA[0-9A-Z]{12,}`, flags: "g" },
  // Slack tokens.
  { name: "slack_token", source: String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`, flags: "g" },
  // Google API keys.
  { name: "google_api_key", source: String.raw`\bAIza[0-9A-Za-z_-]{20,}`, flags: "g" },
  // JWTs (three base64url segments).
  { name: "jwt", source: String.raw`\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}`, flags: "g" },
  // PEM private key headers (and everything to the end of the line).
  { name: "pem_private_key", source: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`, flags: "g" },
  // `Authorization: Bearer <token>` in any casing, header dump or prose.
  { name: "bearer_token", source: String.raw`\bbearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}`, flags: "gi" },
  // `Authorization: <anything>` where the scheme is not Bearer (Basic, custom).
  // The optional `<scheme> ` group means the scheme *and* its value are removed.
  {
    name: "authorization_header",
    source: String.raw`\bauthorization\b\s*[:=]\s*['"]?(?!\[redacted\])(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s'",;}]{8,}`,
    flags: "gi",
  },
  // `x-api-key: …` style headers.
  { name: "api_key_header", source: String.raw`\bx-[a-z-]*(?:api-?key|auth|token)\b\s*[:=]\s*['"]?(?!\[redacted\])[^\s'",;}]{8,}`, flags: "gi" },
  // `apiKey = "…"` / `secret_key: …` / `password=…` assignments, incl. env-file form.
  {
    name: "credential_assignment",
    source: String.raw`\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|private[_-]?key|passwd|password|[A-Z0-9_]*API_KEY|[A-Z0-9_]*SECRET|[A-Z0-9_]*TOKEN)\b\s*[:=]\s*['"]?(?!\[redacted\])[^\s'",;}]{8,}`,
    flags: "gi",
  },
  // `scheme://user:pass@host` credentials embedded in URLs.
  { name: "url_userinfo", source: String.raw`\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s:@]+@`, flags: "gi" },
];

/** Compile the pattern set fresh (no shared `lastIndex` between calls). */
function compiledPatterns(): RegExp[] {
  return SECRET_PATTERNS.map((p) => new RegExp(p.source, p.flags));
}

// ---------------------------------------------------------------------------
// registered literal values
// ---------------------------------------------------------------------------

/**
 * Literal secret values seen by this process. Module-private and never
 * exported, enumerated, or serialised: the only observable facts are the
 * count and whether redaction happened.
 */
const registered = new Set<string>();

/**
 * Register a literal value for redaction everywhere. Called by `Secret`; it is
 * exported so a caller holding a credential from some other source (a proxy
 * token, a provider key read by Pi) can protect it too.
 *
 * Short or blank values are ignored: redacting a 3-character string would
 * corrupt unrelated output without protecting anything meaningful.
 */
export function registerSecretValue(value: string): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_REGISTERED_SECRET_LENGTH) return;
  registered.add(trimmed);
  if (trimmed !== value) registered.add(value);
}

/** How many literal values are registered. Never the values themselves. */
export function redactedValues(): number {
  return registered.size;
}

/**
 * Forget every registered value. For tests and for session teardown; pattern
 * redaction is unaffected, so output stays safe either way.
 */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

/** Longest values first, so a key that contains another registered value is fully covered. */
function registeredByLength(): string[] {
  return [...registered].sort((a, b) => b.length - a.length);
}

/**
 * Redact one string: registered literal values first (exact, and percent- and
 * JSON-escaped forms), then credential shapes.
 */
export function redactString(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const value of registeredByLength()) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
    // A value that travelled through `encodeURIComponent` or `JSON.stringify`
    // no longer matches literally, so cover those encodings too.
    for (const encoded of encodings(value)) {
      if (encoded !== value && out.includes(encoded)) out = out.split(encoded).join(REDACTED);
    }
  }
  for (const pattern of compiledPatterns()) out = out.replace(pattern, REDACTED);
  return out;
}

/** Encodings a literal value can acquire on its way into a log or an export. */
function encodings(value: string): string[] {
  const out: string[] = [];
  try {
    out.push(encodeURIComponent(value));
  } catch {
    /* lone surrogates: the literal form is still covered */
  }
  const json = JSON.stringify(value);
  out.push(json.slice(1, -1));
  out.push(Buffer.from(value, "utf8").toString("base64"));
  return out;
}

/** Does this string still contain anything that must not be logged? */
export function containsSecret(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  return redactString(input) !== input;
}

/** Escape-hatch-free assertion for tests and for the export path. */
export function assertRedacted(input: string, context = "output"): void {
  if (containsSecret(input)) {
    throw new Error(`KorWF-Pi refused to emit ${context}: it still contains credential-shaped text after redaction.`);
  }
}

// ---------------------------------------------------------------------------
// structured values
// ---------------------------------------------------------------------------

/** Header and field names whose *value* is dropped whole, whatever it looks like. */
const SENSITIVE_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "apikey",
  "api_key",
  "apiKey",
  "key",
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "credentials",
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => k === s || k.endsWith(`_${s}`) || k.endsWith(`-${s}`) || k.endsWith(s));
}

/**
 * Redact an arbitrary value, structure included. Strings are redacted; object
 * keys that name a credential have their value replaced whole; `Error`s become
 * plain records with redacted message and stack; everything unrecognised is
 * stringified defensively.
 *
 * Cycles are replaced with `"[circular]"`, depth is bounded, and a getter that
 * throws yields `"[unreadable]"` — a redactor must never be the thing that
 * crashes a log write.
 */
export function redactValue(value: unknown, maxDepth = 8): unknown {
  return redactInner(value, maxDepth, new WeakSet<object>());
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol") return redactString(value.toString());
  if (typeof value === "function") return `[function ${redactString(value.name || "anonymous")}]`;
  if (depth <= 0) return "[truncated]";

  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  try {
    if (value instanceof Error) return redactErrorRecord(value, depth, seen);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return redactString(value.toString());
    if (Array.isArray(value)) return value.map((v) => redactInner(v, depth - 1, seen));
    if (value instanceof Map)
      return Object.fromEntries(
        [...value.entries()].map(([k, v]) => [
          redactString(String(k)),
          isSensitiveKey(String(k)) ? REDACTED : redactInner(v, depth - 1, seen),
        ]),
      );
    if (value instanceof Set) return [...value].map((v) => redactInner(v, depth - 1, seen));

    // Objects that define their own redacted representation (e.g. `Secret`)
    // are trusted to have done so: use it rather than walking their internals.
    const custom = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof custom === "function") {
      try {
        return redactInner(custom.call(value), depth - 1, seen);
      } catch {
        return "[unreadable]";
      }
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      let raw: unknown;
      try {
        raw = (value as Record<string, unknown>)[key];
      } catch {
        out[key] = "[unreadable]";
        continue;
      }
      out[redactString(key)] = isSensitiveKey(key) && raw !== null && raw !== undefined
        ? REDACTED
        : redactInner(raw, depth - 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** An `Error` flattened into a printable, redacted record (own props included). */
function redactErrorRecord(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: redactString(error.name),
    message: redactString(error.message),
  };
  if (typeof error.stack === "string") out["stack"] = redactString(error.stack);
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    const raw = (error as unknown as Record<string, unknown>)[key];
    out[redactString(key)] = isSensitiveKey(key) && raw !== null && raw !== undefined
      ? REDACTED
      : redactInner(raw, depth - 1, seen);
  }
  if (error.cause !== undefined) out["cause"] = redactInner(error.cause, depth - 1, seen);
  return out;
}

/**
 * JSON serialisation that cannot leak: every string is redacted on the way
 * out. Use this instead of `JSON.stringify` for anything written to disk, sent
 * to a trace, or shown to the user.
 */
export function redactedStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(redactValue(value), null, space) ?? String(redactValue(value));
  } catch {
    return `"${REDACTED}"`;
  }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * Redact an error **in place** and return it, so the caller keeps the original
 * class, `instanceof` checks and own properties while the text is safe.
 *
 * Applied at every boundary where an error is surfaced to Pi, written to disk,
 * or turned into a user-facing message. Errors are the most common leak path:
 * an upstream HTTP client happily puts the `Authorization` header it sent into
 * the message of the error it throws.
 */
export function redactError<E>(error: E): E {
  if (!(error instanceof Error)) {
    return (typeof error === "string" ? redactString(error) : redactValue(error)) as E;
  }
  try {
    const message = redactString(error.message);
    if (message !== error.message) Object.defineProperty(error, "message", { value: message, configurable: true, writable: true, enumerable: false });
    if (typeof error.stack === "string") {
      const stack = redactString(error.stack);
      if (stack !== error.stack) Object.defineProperty(error, "stack", { value: stack, configurable: true, writable: true, enumerable: false });
    }
    for (const key of Object.keys(error)) {
      const raw = (error as unknown as Record<string, unknown>)[key];
      if (isSensitiveKey(key) && raw !== null && raw !== undefined) {
        (error as unknown as Record<string, unknown>)[key] = REDACTED;
      } else if (typeof raw === "string") {
        (error as unknown as Record<string, unknown>)[key] = redactString(raw);
      } else if (raw !== null && typeof raw === "object") {
        (error as unknown as Record<string, unknown>)[key] = redactValue(raw);
      }
    }
    if (error.cause !== undefined) {
      Object.defineProperty(error, "cause", { value: redactError(error.cause), configurable: true, writable: true, enumerable: false });
    }
  } catch {
    /* An error we cannot rewrite is still printed through `formatError`. */
  }
  return error;
}

/** One redacted line for an error of any shape, safe to print anywhere. */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const name = redactString(error.name);
    const message = redactString(error.message);
    return message === "" ? name : `${name}: ${message}`;
  }
  if (typeof error === "string") return redactString(error);
  return redactedStringify(error);
}

// ---------------------------------------------------------------------------
// log sinks
// ---------------------------------------------------------------------------

/** Severity levels, matching what Pi's UI exposes. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** The minimal sink shape KorWF-Pi writes through. */
export interface LogSink {
  readonly write: (level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

/**
 * Wrap any sink so every message and every field is redacted before it is
 * written. This is the only way KorWF-Pi is permitted to obtain a logger: a
 * raw sink is never passed around, so there is no code path that writes an
 * unredacted string.
 */
export function redactingSink(sink: LogSink): LogSink {
  return {
    write: (level, message, fields) => {
      const safeMessage = redactString(String(message));
      const safeFields = fields === undefined ? undefined : (redactValue(fields) as Record<string, unknown>);
      sink.write(level, safeMessage, safeFields);
    },
  };
}

/** A sink over `console`, already wrapped. Used when no host logger is supplied. */
export function consoleSink(): LogSink {
  return redactingSink({
    write: (level, message, fields) => {
      const line = fields === undefined ? message : `${message} ${redactedStringify(fields)}`;
      const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      method(line);
    },
  });
}

/** A sink that keeps every record in memory. For tests and for crash dumps. */
export function memorySink(): LogSink & { readonly records: { level: LogLevel; message: string; fields?: Record<string, unknown> }[] } {
  const records: { level: LogLevel; message: string; fields?: Record<string, unknown> }[] = [];
  return {
    records,
    write: (level, message, fields) => {
      records.push(fields === undefined ? { level, message } : { level, message, fields: { ...fields } });
    },
  };
}

/** The logger KorWF-Pi modules receive. Every method redacts. */
export interface Logger {
  readonly debug: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  /** Log a caught error safely, whatever shape it has. */
  readonly exception: (error: unknown, fields?: Readonly<Record<string, unknown>>) => void;
  /** Derive a child logger with fixed (redacted) fields. */
  readonly child: (fields: Readonly<Record<string, unknown>>) => Logger;
}

/**
 * Build a logger over a sink. The sink is wrapped unconditionally — wrapping
 * an already-wrapped sink is harmless (redaction is idempotent) and means a
 * caller cannot opt out by passing a raw sink.
 */
export function createLogger(sink: LogSink = consoleSink(), base: Readonly<Record<string, unknown>> = {}): Logger {
  const safe = redactingSink(sink);
  const merge = (fields?: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined => {
    const merged = { ...base, ...(fields ?? {}) };
    return Object.keys(merged).length === 0 ? undefined : merged;
  };
  const at = (level: LogLevel) => (message: string, fields?: Readonly<Record<string, unknown>>) => {
    safe.write(level, message, merge(fields));
  };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    exception: (error, fields) => {
      safe.write("error", formatError(error), merge({ ...(fields ?? {}), error: redactValue(error) }));
    },
    child: (fields) => createLogger(sink, { ...base, ...fields }),
  };
}
