/**
 * Worker environment construction (issue #68; ADR 0004 "Invocation shape").
 *
 * Two jobs, both security-relevant:
 *
 * 1. **A worker never receives credentials.** The parent's environment is
 *    filtered by *pattern*, not by a list of known key names: anything whose
 *    name mentions JEV, TYPESAFE, API_KEY, SECRET, TOKEN, PASSWORD or
 *    CREDENTIAL is dropped, so a variable a future issue invents is stripped
 *    by default rather than leaked by default. `src/security/secrets.ts`
 *    names the two the product itself reads; this module must keep working
 *    when that list grows.
 * 2. **The recursion depth marker.** `KORWF_WORKER_DEPTH` is guard 2 of the
 *    three in ADR 0004: the orchestration extension reads it at load and
 *    registers no spawn surface when it is at or above `maxDepth`.
 *
 * Pure: it reads nothing and spawns nothing. Callers pass the parent
 * environment in, which is what makes the scrubbing testable.
 */

/** Substrings that mark a variable as credential-shaped. Matched case-insensitively. */
export const CREDENTIAL_NAME_PATTERNS = [
  "JEV",
  "TYPESAFE",
  "API_KEY",
  "APIKEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "AUTH",
  "SESSION_KEY",
] as const;

/**
 * Variables a worker genuinely needs. Everything else in the parent
 * environment is dropped: allowlist, not denylist, so the blast radius of a
 * new variable on the developer's machine is zero.
 */
export const INHERITED_ENV_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SHELL",
  "TERM",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "NODE_OPTIONS",
  "PI_CODING_AGENT_DIR",
] as const;

/** Default recursion depth ceiling: workers may not spawn workers (ADR 0004). */
export const DEFAULT_MAX_DEPTH = 1;

/** Environment variable carrying the worker's nesting depth. */
export const DEPTH_ENV_VAR = "KORWF_WORKER_DEPTH";

/** Inputs for {@link buildWorkerEnv}. */
export interface WorkerEnvParams {
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly workerId: string;
  readonly role: string;
  /** Depth of the worker being launched. The orchestrator itself is depth 0. */
  readonly depth: number;
  /** Set `PI_OFFLINE=1` when the role needs no network beyond the model endpoint. */
  readonly offline?: boolean;
  /** Extra variables the contract declares. Credential-shaped names are refused. */
  readonly extra?: Readonly<Record<string, string>>;
}

/** True when a variable name looks like it carries a credential. */
export function isCredentialName(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_NAME_PATTERNS.some((p) => upper.includes(p));
}

/** Build the worker's environment: allowlisted inheritance plus KorWF markers. */
export function buildWorkerEnv(params: WorkerEnvParams): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of INHERITED_ENV_NAMES) {
    const value = params.parentEnv[name];
    // Belt and braces: an inherited name that is *also* credential-shaped
    // (someone adds "AUTH_PATH" to the list above) never survives.
    if (value !== undefined && !isCredentialName(name)) out[name] = value;
  }
  for (const [name, value] of Object.entries(params.extra ?? {})) {
    if (isCredentialName(name)) {
      throw new Error(
        `buildWorkerEnv: refusing to pass credential-shaped variable '${name}' to a worker`,
      );
    }
    out[name] = value;
  }
  out.KORWF_WORKER = "1";
  out.KORWF_WORKER_ID = params.workerId;
  out.KORWF_WORKER_ROLE = params.role;
  out[DEPTH_ENV_VAR] = String(params.depth);
  if (params.offline === true) out.PI_OFFLINE = "1";
  return Object.freeze(out);
}

/** Names dropped from `parentEnv` by {@link buildWorkerEnv}, for audit and tests. */
export function scrubbedNames(
  parentEnv: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const kept = new Set<string>(INHERITED_ENV_NAMES);
  return Object.keys(parentEnv)
    .filter((name) => !kept.has(name) || isCredentialName(name))
    .sort();
}

/**
 * Guard 2 of ADR 0004, as a pure predicate the extension can call at load
 * time. `depth` is read from {@link DEPTH_ENV_VAR}; an absent marker means
 * "not a worker" (depth 0). A malformed value is treated as the ceiling —
 * an unparseable depth must never read as "plenty of room left".
 */
export function readWorkerDepth(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[DEPTH_ENV_VAR];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return Number.MAX_SAFE_INTEGER;
  return parsed;
}

/** Why spawning was refused, or `null` when it is allowed. */
export type SpawnDepthRefusal = { readonly allowed: false; readonly reason: string } | { readonly allowed: true };

/**
 * May a process at the depth recorded in `env` spawn a worker?
 * Default `maxDepth` 1: the orchestrator (depth 0) may spawn; a worker
 * (depth ≥ 1) may not. Depth > 1 is an explicit config opt-in
 * (PLAN §3.E "unless explicitly allowed"), never a default.
 */
export function canSpawnWorker(
  env: Readonly<Record<string, string | undefined>>,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): SpawnDepthRefusal {
  const depth = readWorkerDepth(env);
  if (depth >= maxDepth) {
    return {
      allowed: false,
      reason:
        `${DEPTH_ENV_VAR}=${env[DEPTH_ENV_VAR] ?? "0"} is at or above workers.maxDepth=${maxDepth}; ` +
        `workers may not spawn workers`,
    };
  }
  return { allowed: true };
}
