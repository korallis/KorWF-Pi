/**
 * A dependency-free validator for the subset of JSON Schema draft 2020-12 that
 * `src/config/schema.json` actually uses (issue #21).
 *
 * Supported keywords: `$ref` (local `#/$defs/*` only), `type`, `const`, `enum`,
 * `properties`, `additionalProperties`, `propertyNames`, `required`, `items`,
 * `contains`, `allOf`, `minimum`, `maximum`, `minLength`, `maxLength`,
 * `pattern`, `uniqueItems`, `format: uri`. An unsupported keyword appearing in
 * the schema is a *loader* error, not a silently skipped check — see
 * `assertSupportedKeywords` — so the validator can never quietly stop enforcing
 * a policy that the schema expresses.
 *
 * Every issue carries the path of the offending value, so messages read like
 * `privacy.denyPatterns[3]: does not match pattern ...`.
 */
import { CONFIG_SCHEMA, resolveRef, type SchemaNode } from "./defaults.ts";

/** Keywords this checker understands. Anything else must not appear in the schema. */
export const SUPPORTED_KEYWORDS: readonly string[] = [
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "default",
  "type",
  "const",
  "enum",
  "properties",
  "additionalProperties",
  "propertyNames",
  "required",
  "items",
  "contains",
  "allOf",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "uniqueItems",
  "format",
];

/** One structural violation, qualified by the path of the value that caused it. */
export interface SchemaIssue {
  /** Dotted/indexed path from the config root, `""` for the document itself. */
  readonly path: string;
  readonly message: string;
}

const child = (path: string, key: string): string =>
  path === "" ? key : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

const index = (path: string, i: number): string => `${path}[${i}]`;

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

const matchesType = (v: unknown, t: string): boolean =>
  t === "integer"
    ? typeof v === "number" && Number.isInteger(v)
    : t === "number"
      ? typeof v === "number" && Number.isFinite(v)
      : t === "null"
        ? v === null
        : t === "array"
          ? Array.isArray(v)
          : t === "object"
            ? typeof v === "object" && v !== null && !Array.isArray(v)
            : typeof v === t;

/**
 * Walk the schema and fail loudly if it uses a keyword this checker ignores.
 * Called by `checkAgainstSchema`, so a future schema edit that adds, say,
 * `oneOf` cannot silently become unenforced.
 */
export function assertSupportedKeywords(node: SchemaNode, root: SchemaNode = CONFIG_SCHEMA, at = "#"): void {
  const record = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) {
      throw new Error(`config schema uses unsupported keyword "${key}" at ${at}`);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "default" || key === "const" || key === "enum") continue;
    if ((key === "properties" || key === "$defs") && value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, SchemaNode>)) {
        assertSupportedKeywords(v, root, `${at}/${key}/${k}`);
      }
    } else if (key === "allOf" && Array.isArray(value)) {
      value.forEach((v, i) => assertSupportedKeywords(v as SchemaNode, root, `${at}/allOf/${i}`));
    } else if (
      (key === "items" || key === "contains" || key === "propertyNames" || key === "additionalProperties") &&
      value !== null &&
      typeof value === "object"
    ) {
      assertSupportedKeywords(value as SchemaNode, root, `${at}/${key}`);
    }
  }
}

function checkNode(value: unknown, node: SchemaNode, path: string, root: SchemaNode, out: SchemaIssue[]): void {
  const s = resolveRef(node, root);

  if (s.type !== undefined) {
    const types = typeof s.type === "string" ? [s.type] : [...s.type];
    if (!types.some((t) => matchesType(value, t))) {
      out.push({ path, message: `expected ${types.join(" | ")}, got ${typeOf(value)}` });
      return;
    }
  }
  if ("const" in s && JSON.stringify(value) !== JSON.stringify(s.const)) {
    out.push({ path, message: `must be ${JSON.stringify(s.const)} (fixed by policy), got ${JSON.stringify(value)}` });
    return;
  }
  if (s.enum !== undefined && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push({ path, message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}, got ${JSON.stringify(value)}` });
    return;
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) out.push({ path, message: `must be >= ${s.minimum}, got ${value}` });
    if (s.maximum !== undefined && value > s.maximum) out.push({ path, message: `must be <= ${s.maximum}, got ${value}` });
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) out.push({ path, message: `must be at least ${s.minLength} character(s)` });
    if (s.maxLength !== undefined && value.length > s.maxLength) out.push({ path, message: `must be at most ${s.maxLength} character(s)` });
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(value))
      out.push({ path, message: `does not match required pattern ${s.pattern}` });
    if (s.format === "uri" && !URL.canParse(value)) out.push({ path, message: `is not a valid URI` });
  }
  if (Array.isArray(value)) {
    if (s.items !== undefined) value.forEach((v, i) => checkNode(v, s.items as SchemaNode, index(path, i), root, out));
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      value.forEach((v, i) => {
        const k = JSON.stringify(v);
        if (seen.has(k)) out.push({ path: index(path, i), message: `duplicate entry ${k}; entries must be unique` });
        seen.add(k);
      });
    }
  }
  if (s.contains !== undefined) {
    const items = Array.isArray(value) ? value : [];
    const probe: SchemaIssue[] = [];
    const ok = items.some((v) => {
      probe.length = 0;
      checkNode(v, s.contains as SchemaNode, path, root, probe);
      return probe.length === 0;
    });
    if (!ok) {
      const required = resolveRef(s.contains, root);
      out.push({
        path,
        message:
          "const" in required
            ? `must contain the shipped entry ${JSON.stringify(required.const)}; shipped policy is a floor and cannot be reduced`
            : `must contain at least one entry matching the shipped requirement`,
      });
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) out.push({ path: child(path, key), message: `is required` });
    }
    for (const [key, v] of Object.entries(obj)) {
      const p = child(path, key);
      if (s.propertyNames !== undefined) checkNode(key, s.propertyNames, p, root, out);
      const sub = s.properties?.[key];
      if (sub !== undefined) {
        checkNode(v, sub, p, root, out);
        continue;
      }
      const extra = s.additionalProperties;
      if (extra === false) {
        out.push({ path: p, message: `unknown key (unknown keys are rejected so a typo cannot silently disable a policy)` });
      } else if (extra !== undefined && extra !== true) {
        checkNode(v, extra, p, root, out);
      }
    }
  }
  for (const sub of s.allOf ?? []) checkNode(value, sub, path, root, out);
}

/**
 * Validate a parsed JSON value against the shipped schema (or a sub-schema).
 * Returns every issue found, each with a path; an empty array means valid.
 */
export function checkAgainstSchema(
  value: unknown,
  node: SchemaNode = CONFIG_SCHEMA,
  root: SchemaNode = CONFIG_SCHEMA,
): readonly SchemaIssue[] {
  assertSupportedKeywords(root, root);
  const out: SchemaIssue[] = [];
  checkNode(value, node, "", root, out);
  return out;
}
