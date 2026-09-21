/**
 * Shipped defaults, derived from `src/config/schema.json` (issue #21 over #11).
 *
 * The schema is the authority: every default in this module is *read out of*
 * the schema rather than restated, so the two can never drift. Nothing here
 * performs policy decisions; it only materialises "what an empty config means".
 *
 * `docs/config-reference.md` documents every key, its default and the rationale.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KorwfConfig } from "./types.ts";

/** Minimal structural view of the parts of JSON Schema this module walks. */
export interface SchemaNode {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: boolean | SchemaNode;
  readonly propertyNames?: SchemaNode;
  readonly required?: readonly string[];
  readonly items?: SchemaNode;
  readonly contains?: SchemaNode;
  readonly allOf?: readonly SchemaNode[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly uniqueItems?: boolean;
  readonly format?: string;
  readonly description?: string;
  readonly $defs?: Readonly<Record<string, SchemaNode>>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the shipped schema document. */
export const SCHEMA_PATH = join(here, "schema.json");

/**
 * The shipped JSON Schema (draft 2020-12), read from disk once.
 *
 * Read rather than `import`ed so the module works identically under vitest,
 * `node --test`, and a plain Node ESM load without JSON import attributes.
 */
export const CONFIG_SCHEMA: SchemaNode = JSON.parse(
  readFileSync(SCHEMA_PATH, "utf8"),
) as SchemaNode;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Resolve a `#/$defs/Name` reference against the root schema. */
export function resolveRef(node: SchemaNode, root: SchemaNode = CONFIG_SCHEMA): SchemaNode {
  let current = node;
  const seen = new Set<string>();
  while (current.$ref !== undefined) {
    const ref = current.$ref;
    if (seen.has(ref)) throw new Error(`cyclic $ref in config schema: ${ref}`);
    seen.add(ref);
    const name = ref.split("/").pop() as string;
    const target = root.$defs?.[name];
    if (target === undefined) throw new Error(`unknown $ref in config schema: ${ref}`);
    const { $ref: _dropped, ...rest } = current;
    current = { ...target, ...rest };
  }
  return current;
}

/**
 * Materialise the value an *absent* key takes, by walking `properties[*].default`.
 *
 * An object node whose own default is absent or `{}` is expanded from its
 * properties (so `{}` really does mean "every nested default"); any other
 * default is used verbatim. Keys with no default at any depth are omitted,
 * which is how the optional `$schema` hint stays out of a resolved config.
 */
export function materialiseDefaults(
  node: SchemaNode,
  root: SchemaNode = CONFIG_SCHEMA,
): unknown {
  const resolved = resolveRef(node, root);
  const own = resolved.default;
  const expandable = own === undefined || (isPlainObject(own) && Object.keys(own).length === 0);
  if (resolved.properties !== undefined && expandable) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(resolved.properties)) {
      const value = materialiseDefaults(child, root);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return own;
}

/** Deep structural clone of JSON data (no prototypes, no shared references). */
export function cloneJson<T>(value: T): T {
  return (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
}

/**
 * The fully resolved shipped configuration: what `{}` means.
 *
 * A fresh deep copy is returned on every call so a caller cannot mutate the
 * shipped baseline for everyone else.
 */
export function shippedDefaults(): KorwfConfig {
  return materialiseDefaults(CONFIG_SCHEMA) as KorwfConfig;
}

/** Shipped minimum `privacy.denyPaths` (the floor enforced by validator rule V5). */
export const SHIPPED_DENY_PATHS: readonly string[] = Object.freeze([
  ...((CONFIG_SCHEMA.$defs?.["ShippedDenyPaths"]?.const ?? []) as readonly string[]),
]);

/** Shipped minimum `privacy.denyPatterns` (the floor enforced by validator rules V5/V6). */
export const SHIPPED_DENY_PATTERNS: readonly string[] = Object.freeze([
  ...((CONFIG_SCHEMA.$defs?.["ShippedDenyPatterns"]?.const ?? []) as readonly string[]),
]);

/** File name of the project-level config, relative to the project root. */
export const PROJECT_CONFIG_RELATIVE_PATH = ".korwf/config.json";

/** File name of the user-level config, relative to the Pi config directory. */
export const USER_CONFIG_RELATIVE_PATH = "korwf/config.json";
