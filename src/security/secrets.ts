/**
 * Credential resolution (issue #22; PLAN §7 "Jev transport", §3.J; ADR 0003
 * rule 3; `docs/config-reference.md` §8 and §19 "No secrets in config").
 *
 * The rules this module exists to enforce:
 *
 *  - **Config never holds a key.** `jev.keySource` names *where* a key lives
 *    (`env | pi_secrets | none`, default name `TYPESAFE_API_KEY`); resolution
 *    happens here and nowhere else. The transport does not read `process.env`.
 *  - **A key is never a plain string.** `resolveJevKey` returns a `Secret`
 *    whose value can only be obtained through one explicit call, and whose
 *    `toString`, `toJSON`, template-literal and `console.log` forms are all
 *    `[redacted]`. Creating a `Secret` registers its value with the global
 *    redactor, so even a value that escapes by some other route is scrubbed
 *    from logs, errors and exports.
 *  - **No key is not an error.** An absent key yields a resolution whose
 *    status says so, with one clear sentence for the user, and Jev runs in
 *    optional mode: the deterministic workflow is unaffected (ADR 0007).
 */
import { REDACTED, registerSecretValue } from "./redact.ts";
import type { JevKeySource, KorwfConfig } from "../config/types.ts";

/**
 * The shipped default environment variable name. Matches
 * `jev.keySource.name`'s default in `src/config/schema.json`; duplicated here
 * only as the fallback for callers that have no config object.
 */
export const DEFAULT_KEY_ENV_VAR = "TYPESAFE_API_KEY";

/**
 * Additional variable names accepted when the configured one is unset.
 * `JEV_API_KEY` is the name used during this project's own development
 * (`docs/decisions/0001-authorization.md`); accepting it keeps a developer
 * from having to duplicate the value under a second name. It is a *fallback*,
 * never a default: the configured name always wins, and nothing
 * machine-specific is implied by either.
 */
export const FALLBACK_KEY_ENV_VARS: readonly string[] = ["JEV_API_KEY"];

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

/** Node's custom-inspect hook, so `console.log(secret)` prints `[redacted]`. */
const NODE_INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Where a resolved value came from, for diagnostics. Never the value. */
export interface SecretOrigin {
  readonly kind: JevKeySource["kind"];
  /** The variable or secret name it was read from. */
  readonly name: string;
  /** True when the configured name was empty and a documented fallback name matched. */
  readonly viaFallbackName: boolean;
}

/**
 * An in-memory credential that resists every accidental serialisation route.
 *
 * `toString`, `toJSON`, `valueOf`, `Symbol.toPrimitive` and Node's inspect
 * hook all return `[redacted]`, which covers template literals, string
 * concatenation, `JSON.stringify`, `console.log`, `util.inspect`, structured
 * log fields and error interpolation. The value itself lives in a closure
 * reachable only through `expose()`, whose name is deliberately awkward so it
 * shows up in review.
 *
 * Construction registers the value with the global redactor, so if the same
 * string arrives at a log sink from somewhere else entirely — an HTTP client
 * echoing a header, a crash dump — it is still replaced.
 */
export class Secret {
  /** Non-secret label, e.g. `"TypeSafe API key"`. Safe to print. */
  readonly label: string;
  /** Where it came from. Safe to print. */
  readonly origin: SecretOrigin;
  /** Length of the underlying value. Useful for "is this plausible?" checks. */
  readonly length: number;

  readonly #value: string;

  constructor(value: string, label: string, origin: SecretOrigin) {
    this.#value = value;
    this.label = label;
    this.origin = origin;
    this.length = value.length;
    registerSecretValue(value);
    Object.freeze(this);
  }

  /**
   * The only way to read the value. Call this at the last possible moment —
   * building an `Authorization` header — and never assign the result to a
   * variable that outlives the call.
   */
  expose(): string {
    return this.#value;
  }

  /**
   * Use the value inside a callback without ever holding it. Preferred over
   * `expose()`: the plain string exists only for the duration of `use`.
   */
  withValue<T>(use: (value: string) => T): T {
    return use(this.#value);
  }

  /** A stable, non-reversible fingerprint for cache keys and traces. */
  fingerprint(): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < this.#value.length; i++) {
      const c = this.#value.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
  }

  /** Compare without exposing either side. */
  equals(other: Secret | null | undefined): boolean {
    return other instanceof Secret && other.#value === this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  valueOf(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return "Secret";
  }

  [NODE_INSPECT](): string {
    return `Secret(${this.label}) ${REDACTED}`;
  }
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** Why Jev is or is not usable in this session. */
export type KeyResolutionStatus =
  | "resolved"
  /** `jev.enabled` is false: the user has not asked for Jev at all. */
  | "jev_disabled"
  /** `keySource.kind === "none"`: the user has declared there is no key. */
  | "no_key_source"
  /** A source was named but held nothing. */
  | "key_absent"
  /** A `pi_secrets` source was named but no secrets port was supplied. */
  | "secrets_unavailable";

/**
 * Outcome of `resolveJevKey`. There is deliberately no failure variant: an
 * absent key is a *state*, not an error (PLAN §3.J, ADR 0007), so callers get
 * a value with `jevEnabled: false` and one sentence to show the user.
 */
export interface KeyResolution {
  readonly status: KeyResolutionStatus;
  /** The credential, or `null`. Never a string. */
  readonly secret: Secret | null;
  /** True only when a key resolved *and* `jev.enabled` is true. */
  readonly jevEnabled: boolean;
  /** Which source was consulted. Names only — never a value. */
  readonly source: JevKeySource;
  /** One clear sentence for the user. Safe to log; contains no value. */
  readonly message: string;
}

/**
 * Pi's secrets facility, as the narrow port this module needs. Declared
 * structurally so `src/security/` stays free of any dependency on the Pi API
 * (ADR 0002: domain modules never import `extension/`). The extension supplies
 * the real implementation; tests supply a stub.
 *
 * `get` returns the raw value because a facility cannot return a `Secret` it
 * does not know about; the value is wrapped here, immediately, and no caller
 * of `resolveJevKey` ever sees the string.
 */
export interface SecretsPort {
  readonly get: (name: string) => string | null | undefined;
}

export interface ResolveOptions {
  /** Environment to read from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Pi's secrets facility, required for `keySource.kind === "pi_secrets"`. */
  readonly secrets?: SecretsPort | undefined;
  /**
   * Accept the documented development fallback names when the configured name
   * is unset. Defaults to true; set false to require the configured name
   * exactly (used by tests and by anyone who wants a single source of truth).
   */
  readonly allowFallbackNames?: boolean;
  /** Label used in diagnostics. Defaults to `"TypeSafe API key"`. */
  readonly label?: string;
}

/** Trim and reject blank/placeholder values; returns `null` when unusable. */
function usableValue(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  return value;
}

const DISABLED_MESSAGE =
  "Jev assistance is off (jev.enabled is false): every Jev-assisted decision takes its deterministic fallback. The workflow is unaffected.";

/** The one clear message for "no key" — a state, not an error. */
function absentMessage(source: JevKeySource, reason: KeyResolutionStatus): string {
  const where =
    source.kind === "pi_secrets"
      ? reason === "secrets_unavailable"
        ? `Pi's secrets facility is not available in this session, so the secret named ${source.name} could not be read`
        : `Pi's secrets facility has no secret named ${source.name}`
      : source.kind === "env"
        ? `the environment variable ${source.name} is not set`
        : "jev.keySource.kind is \"none\", so no key is looked for";
  return (
    `Jev assistance is disabled: ${where}. ` +
    "The deterministic workflow runs in full — planning, tasks, worktrees, gates and static model routing all work, " +
    `and every Jev-assisted decision takes its documented fallback. To enable Jev, set ${source.kind === "pi_secrets" ? "the Pi secret" : "the environment variable"} ${source.name} and set jev.enabled to true.`
  );
}

/**
 * Resolve the TypeSafe (Jev) key named by `config.jev.keySource`.
 *
 * Lazy by construction — nothing is read until this is called — and total:
 * it never throws, never logs, and never returns the value as a string. An
 * absent key comes back as `{ status: "key_absent", secret: null,
 * jevEnabled: false, message }`, which the extension shows once.
 *
 * `jev.enabled: false` short-circuits before any lookup: a user who has turned
 * Jev off should not have their environment read at all.
 */
export function resolveJevKey(
  config: Pick<KorwfConfig, "jev">,
  options: ResolveOptions = {},
): KeyResolution {
  const source = config.jev.keySource;
  const label = options.label ?? "TypeSafe API key";

  if (!config.jev.enabled) {
    return { status: "jev_disabled", secret: null, jevEnabled: false, source, message: DISABLED_MESSAGE };
  }
  if (source.kind === "none") {
    return { status: "no_key_source", secret: null, jevEnabled: false, source, message: absentMessage(source, "no_key_source") };
  }

  if (source.kind === "pi_secrets") {
    if (options.secrets === undefined) {
      return {
        status: "secrets_unavailable",
        secret: null,
        jevEnabled: false,
        source,
        message: absentMessage(source, "secrets_unavailable"),
      };
    }
    let raw: string | null | undefined;
    try {
      raw = options.secrets.get(source.name);
    } catch {
      // A facility that throws is treated exactly like one that has nothing:
      // no key is a state, never an error, and the thrown object is dropped
      // rather than propagated because it may quote the value it failed on.
      raw = null;
    }
    const value = usableValue(raw);
    if (value === null) {
      return { status: "key_absent", secret: null, jevEnabled: false, source, message: absentMessage(source, "key_absent") };
    }
    return {
      status: "resolved",
      secret: new Secret(value, label, { kind: "pi_secrets", name: source.name, viaFallbackName: false }),
      jevEnabled: true,
      source,
      message: `Jev assistance is enabled; the ${label} was read from Pi's secrets facility (${source.name}). The key is held in memory only and is never logged, stored, or exported.`,
    };
  }

  // kind === "env"
  const env = options.env ?? process.env;
  const names = [source.name, ...(options.allowFallbackNames === false ? [] : FALLBACK_KEY_ENV_VARS)];
  for (const name of names) {
    if (name === "") continue;
    const value = usableValue(env[name]);
    if (value === null) continue;
    const viaFallbackName = name !== source.name;
    return {
      status: "resolved",
      secret: new Secret(value, label, { kind: "env", name, viaFallbackName }),
      jevEnabled: true,
      source,
      message:
        `Jev assistance is enabled; the ${label} was read from the environment variable ${name}` +
        `${viaFallbackName ? ` (a documented development fallback for ${source.name})` : ""}. ` +
        "The key is held in memory only and is never logged, stored, or exported.",
    };
  }

  return { status: "key_absent", secret: null, jevEnabled: false, source, message: absentMessage(source, "key_absent") };
}

/**
 * The effective config for a session, with `jev.enabled` forced to false when
 * no key resolved. This is the "key absent ⇒ Jev disabled with one clear
 * message, not an error" path in one call: the returned config is safe to hand
 * to the rest of the system, and `message` is the single sentence to show.
 *
 * It only ever *tightens* the config (enabled → disabled), so it can never be
 * used to turn Jev on or to weaken any policy.
 */
export function applyKeyResolution<C extends KorwfConfig>(
  config: C,
  resolution: KeyResolution,
): { readonly config: C; readonly resolution: KeyResolution } {
  if (!config.jev.enabled || resolution.jevEnabled) return { config, resolution };
  return {
    config: Object.freeze({ ...config, jev: Object.freeze({ ...config.jev, enabled: false }) }) as C,
    resolution,
  };
}

/**
 * Diagnostics for `/korwf status` and the decision trace: everything about the
 * credential *except* the credential. Safe to serialise anywhere.
 */
export interface KeyDiagnostics {
  readonly status: KeyResolutionStatus;
  readonly jevEnabled: boolean;
  readonly sourceKind: JevKeySource["kind"];
  readonly sourceName: string;
  readonly resolvedFromName: string | null;
  readonly viaFallbackName: boolean;
  readonly keyLength: number | null;
  readonly keyFingerprint: string | null;
  readonly message: string;
}

/** Build the diagnostics record. Contains no credential material. */
export function keyDiagnostics(resolution: KeyResolution): KeyDiagnostics {
  const secret = resolution.secret;
  return {
    status: resolution.status,
    jevEnabled: resolution.jevEnabled,
    sourceKind: resolution.source.kind,
    sourceName: resolution.source.name,
    resolvedFromName: secret === null ? null : secret.origin.name,
    viaFallbackName: secret?.origin.viaFallbackName ?? false,
    keyLength: secret === null ? null : secret.length,
    keyFingerprint: secret === null ? null : secret.fingerprint(),
    message: resolution.message,
  };
}

/**
 * Build the `Authorization` header for an outbound Jev request. The plain
 * value exists only inside the returned object, which callers hand straight to
 * `fetch`; it is never assigned to a named variable in our code.
 */
export function authorizationHeader(secret: Secret): Readonly<Record<string, string>> {
  return Object.freeze({ Authorization: secret.withValue((v) => `Bearer ${v}`) });
}
