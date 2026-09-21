/**
 * Layered config loading (issue #21, PLAN §3.J).
 *
 * Merge order, lowest precedence first:
 *
 *   1. shipped defaults        (`schema.json`, every key defaulted)
 *   2. user config             (`<pi config dir>/korwf/config.json`)
 *   3. project config          (`<project>/.korwf/config.json`)
 *   4. environment overrides   (the documented set in `ENV_OVERRIDES` only)
 *
 * Objects merge key by key; arrays and scalars are replaced wholesale by the
 * higher layer. Because a higher layer can *replace* an array, the privacy
 * floors (V5) are re-checked after the merge, so no layer can drop a shipped
 * deny entry. The result is validated and deep-frozen.
 *
 * Nothing in this module throws on user input: unreadable, unparseable and
 * invalid files all come back as path-qualified errors on the result, so a bad
 * config can never crash the Pi session that loaded it.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  PROJECT_CONFIG_RELATIVE_PATH,
  USER_CONFIG_RELATIVE_PATH,
  shippedDefaults,
} from "./defaults.ts";
import { formatIssue, validateConfig, type ConfigIssue, type ValidateOptions } from "./validate.ts";
import type { KorwfConfig } from "./types.ts";

/** Where a resolved value came from, for `/korwf status` and the PR trail. */
export type ConfigLayerName = "defaults" | "user" | "project" | "env";

export interface ConfigLayerInfo {
  readonly layer: ConfigLayerName;
  /** Absolute file path, or `null` for the shipped defaults and env layers. */
  readonly path: string | null;
  /** True when the layer contributed something to the merged result. */
  readonly present: boolean;
}

export interface LoadedConfig {
  readonly ok: true;
  /** Deep-frozen, fully defaulted, validated configuration. */
  readonly config: KorwfConfig;
  readonly layers: readonly ConfigLayerInfo[];
  /** Non-blocking findings (e.g. V9 Jev downgrade). */
  readonly warnings: readonly ConfigIssue[];
}

export interface FailedConfigLoad {
  readonly ok: false;
  readonly errors: readonly ConfigIssue[];
  readonly warnings: readonly ConfigIssue[];
  readonly layers: readonly ConfigLayerInfo[];
  /** Human-readable summary, one line per error. */
  readonly message: string;
}

export type ConfigLoadResult = LoadedConfig | FailedConfigLoad;

/**
 * The documented environment overrides. Nothing outside this table is read
 * from the environment, and none of these can weaken policy: they either
 * select a stricter mode, name a key *source*, or disable a feature.
 */
export const ENV_OVERRIDES: readonly {
  readonly env: string;
  readonly path: readonly string[];
  readonly parse: (raw: string) => unknown;
  readonly description: string;
}[] = [
  { env: "KORWF_MODE", path: ["mode"], parse: (v) => v, description: "Workflow mode for this session (schema-validated)." },
  { env: "KORWF_JEV_ENABLED", path: ["jev", "enabled"], parse: parseBool, description: "Turn Jev assistance on/off without editing a file." },
  { env: "KORWF_JEV_BASE_URL", path: ["jev", "baseUrl"], parse: (v) => v, description: "Jev API origin (https only, schema-validated)." },
  { env: "KORWF_JEV_KEY_ENV", path: ["jev", "keySource", "name"], parse: (v) => v, description: "Name of the env var holding the TypeSafe key — never the key itself." },
  { env: "KORWF_STORAGE_PATH", path: ["storage", "path"], parse: (v) => v, description: "Override the storage root (still subject to V8)." },
];

function parseBool(raw: string): unknown {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return raw;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Merge `override` onto `base`. Objects merge key by key; arrays and scalars
 * are replaced wholesale, which is why post-merge floor re-checks (V5) exist.
 */
export function mergeLayer<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? mergeLayer(base[key], value) : value;
  }
  return out as T;
}

/** Recursively freeze a plain JSON structure in place. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value);
}

export interface LoadOptions extends ValidateOptions {
  /**
   * Directory holding the user-level config. Defaults to `$PI_CODING_AGENT_DIR`
   * or `~/.pi/agent`. No machine-specific path is ever shipped: this is
   * computed from the environment at call time.
   */
  readonly userConfigDir?: string | null;
  /** Environment to read the documented overrides from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Read a file as UTF-8, or return `null` if absent. Injected by tests. */
  readonly readFile?: (path: string) => string | null;
}

/** Default user config directory, derived from the environment (never shipped). */
export function defaultUserConfigDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env["PI_CODING_AGENT_DIR"];
  if (override !== undefined && override !== "") return resolve(override);
  return join(homedir(), ".pi", "agent");
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

interface FileLayer {
  readonly info: ConfigLayerInfo;
  readonly data: unknown;
  readonly errors: readonly ConfigIssue[];
}

function readLayer(layer: ConfigLayerName, path: string, read: (p: string) => string | null): FileLayer {
  let raw: string | null;
  try {
    raw = read(path);
  } catch (e) {
    return {
      info: { layer, path, present: false },
      data: undefined,
      errors: [{ rule: "schema", path: `<${layer}:${path}>`, message: `could not be read: ${(e as Error).message}`, severity: "error" }],
    };
  }
  if (raw === null) return { info: { layer, path, present: false }, data: undefined, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      info: { layer, path, present: true },
      data: undefined,
      errors: [{ rule: "schema", path: `<${layer}:${path}>`, message: `is not valid JSON: ${(e as Error).message}`, severity: "error" }],
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      info: { layer, path, present: true },
      data: undefined,
      errors: [{ rule: "schema", path: `<${layer}:${path}>`, message: `must contain a JSON object at the top level, got ${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}`, severity: "error" }],
    };
  }
  const { $schema: _ignored, ...rest } = parsed;
  return { info: { layer, path, present: true }, data: rest, errors: [] };
}

/** Collect the documented environment overrides as a sparse config object. */
export function envOverrides(env: Readonly<Record<string, string | undefined>>): {
  readonly data: Record<string, unknown>;
  readonly present: boolean;
} {
  const data: Record<string, unknown> = {};
  let present = false;
  for (const { env: name, path, parse } of ENV_OVERRIDES) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    present = true;
    let cursor = data;
    for (const key of path.slice(0, -1)) {
      const next = cursor[key];
      cursor = isPlainObject(next) ? next : ((cursor[key] = {}) as Record<string, unknown>);
    }
    cursor[path[path.length - 1] as string] = parse(raw);
  }
  return { data, present };
}

/**
 * Load, merge, validate and freeze the configuration for a project.
 *
 * Never throws on user input. On success the caller gets a deep-frozen
 * `KorwfConfig` and the list of layers that contributed; on failure, every
 * error carries the rule id and the path of the offending value.
 */
export function loadConfig(projectDir: string, options: LoadOptions = {}): ConfigLoadResult {
  const env = options.env ?? process.env;
  const read = options.readFile ?? defaultReadFile;
  const projectRoot = resolve(projectDir);
  const userDir =
    options.userConfigDir === null ? null : (options.userConfigDir ?? defaultUserConfigDir(env));

  const layers: ConfigLayerInfo[] = [{ layer: "defaults", path: null, present: true }];
  const errors: ConfigIssue[] = [];
  let merged: unknown = shippedDefaults();

  for (const [layer, dir, rel] of [
    ["user", userDir, USER_CONFIG_RELATIVE_PATH],
    ["project", projectRoot, PROJECT_CONFIG_RELATIVE_PATH],
  ] as const) {
    if (dir === null) {
      layers.push({ layer, path: null, present: false });
      continue;
    }
    const file = isAbsolute(rel) ? rel : join(dir, rel);
    const result = readLayer(layer, file, read);
    layers.push(result.info);
    errors.push(...result.errors);
    merged = mergeLayer(merged, result.data);
  }

  const fromEnv = envOverrides(env);
  layers.push({ layer: "env", path: null, present: fromEnv.present });
  merged = mergeLayer(merged, fromEnv.data);

  const keyResolves = options.jevKeyResolves ?? jevKeyResolvesFrom(merged, env);
  const validation = validateConfig(merged, {
    projectRoot,
    ...(options.knownModels === undefined ? {} : { knownModels: options.knownModels }),
    ...(keyResolves === undefined ? {} : { jevKeyResolves: keyResolves }),
  });
  errors.push(...validation.errors);

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      warnings: validation.warnings,
      layers,
      message: [`KorWF-Pi configuration is invalid (${errors.length} problem(s)):`, ...errors.map((e) => `  - ${formatIssue(e)}`)].join("\n"),
    };
  }

  // V9: Jev enabled without a resolvable key downgrades to optional mode. The
  // downgrade is a tightening (nothing outbound), so it is applied to the
  // resolved config and reported as a warning, never as a load failure.
  const resolved = merged as KorwfConfig;
  const config =
    resolved.jev.enabled && (keyResolves === false || resolved.jev.keySource.kind === "none")
      ? ({ ...resolved, jev: { ...resolved.jev, enabled: false } } as KorwfConfig)
      : resolved;

  return { ok: true, config: deepFreeze(config), layers, warnings: validation.warnings };
}

/**
 * Best-effort key-presence probe for the V9 downgrade. Only the *presence* of
 * the named environment variable is inspected; the value is never read into
 * any config, log, or outbound payload. A `pi_secrets` source cannot be probed
 * from here, so it is treated as "unknown" and the transport decides.
 */
function jevKeyResolvesFrom(
  merged: unknown,
  env: Readonly<Record<string, string | undefined>>,
): boolean | undefined {
  const jev = isPlainObject(merged) ? merged["jev"] : undefined;
  if (!isPlainObject(jev) || jev["enabled"] !== true) return undefined;
  const source = isPlainObject(jev["keySource"]) ? (jev["keySource"] as Record<string, unknown>) : {};
  if (source["kind"] !== "env") return undefined;
  const name = typeof source["name"] === "string" ? source["name"] : "";
  const value = env[name];
  return value !== undefined && value !== "";
}

/**
 * The effective configuration when every file is absent: the shipped defaults,
 * validated and frozen. Useful for tests, for `/korwf status` before a project
 * is initialised, and as the safe value when loading failed.
 */
export function defaultConfig(): KorwfConfig {
  return deepFreeze(shippedDefaults());
}
