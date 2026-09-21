/**
 * Cross-field validation for a merged KorWF-Pi config (issue #21).
 *
 * The JSON Schema (`schema.json`) enforces types, enums, ranges, `const` pins,
 * the deny-list floor and unknown-key rejection. The rules below are the ones
 * JSON Schema cannot express; they are documented as V1–V12 in
 * `docs/config-reference.md` §11 and are **re-checked after the layered merge**
 * so a higher-precedence layer cannot drop a floor by replacing an array.
 *
 * Every rule produces a path-qualified error. Nothing here throws on user
 * input: a caller gets a result object and decides how to surface it, so a bad
 * config can never crash Pi.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { SHIPPED_DENY_PATHS, SHIPPED_DENY_PATTERNS } from "./defaults.ts";
import { checkAgainstSchema } from "./schema-check.ts";
import { validateApprovalClasses } from "../workflow/approval-classes.ts";
import type { KorwfConfig, ModelRef } from "./types.ts";

/** Stable ids for the rules in docs/config-reference.md §11, plus `schema`. */
export type ConfigRuleId =
  | "schema"
  | "V1"
  | "V2"
  | "V3"
  | "V4"
  | "V5"
  | "V6"
  | "V7"
  | "V8"
  | "V9"
  | "V10"
  | "V11"
  | "V12";

/** A single validation finding. `severity: "warning"` never blocks loading. */
export interface ConfigIssue {
  readonly rule: ConfigRuleId;
  /** Dotted path from the config root, e.g. `budgets.task.maxSpendUsd`. */
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

/** Context a caller can supply so V1/V8/V9 can be checked precisely. */
export interface ValidateOptions {
  /** Absolute project root; required for V8 (`storage.path`). */
  readonly projectRoot?: string;
  /**
   * Model refs Pi actually has configured. When omitted, V1/V9 only check
   * allowlist membership — an unknown ref cannot be detected without a registry.
   */
  readonly knownModels?: readonly ModelRef[];
  /** Whether a Jev key resolves. Used by V9's downgrade-with-warning rule. */
  readonly jevKeyResolves?: boolean;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ConfigIssue[];
  readonly warnings: readonly ConfigIssue[];
}

const err = (rule: ConfigRuleId, path: string, message: string): ConfigIssue => ({ rule, path, message, severity: "error" });
const warn = (rule: ConfigRuleId, path: string, message: string): ConfigIssue => ({ rule, path, message, severity: "warning" });

// ---------------------------------------------------------------------------
// Glob helpers (project-relative, `**` crosses directories, dotfiles included).
// ---------------------------------------------------------------------------

/** Compile a deny/allow glob to an anchored regex over project-relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "u");
}

/** The effective allowlist: providers ∩ models, minus disabled overrides. */
export function effectiveAllowlist(config: KorwfConfig, knownModels?: readonly ModelRef[]): {
  readonly isAllowed: (ref: ModelRef) => boolean;
  readonly known: ReadonlySet<string> | undefined;
} {
  const { providers, models } = config.models.allowlist;
  const disabled = new Set(
    Object.entries(config.models.overrides)
      .filter(([, o]) => o?.disabled === true)
      .map(([ref]) => ref),
  );
  const known = knownModels === undefined ? undefined : new Set<string>(knownModels);
  const isAllowed = (ref: ModelRef): boolean => {
    if (disabled.has(ref)) return false;
    const provider = ref.slice(0, ref.indexOf("/"));
    if (providers.length > 0 && !providers.includes(provider)) return false;
    if (models.length > 0 && !models.includes(ref)) return false;
    return true;
  };
  return { isAllowed, known };
}

// ---------------------------------------------------------------------------
// V1, V9 — allowlist containment for static order, pins and overrides.
// ---------------------------------------------------------------------------

function checkAllowlistRules(config: KorwfConfig, options: ValidateOptions, out: ConfigIssue[]): void {
  const { isAllowed, known } = effectiveAllowlist(config, options.knownModels);
  const describe = (ref: string): string =>
    known !== undefined && !known.has(ref) ? "is not a model this Pi has configured" : "is not in the effective allowlist";
  const eligible = (ref: string): boolean => isAllowed(ref as ModelRef) && (known === undefined || known.has(ref));

  config.fallback.staticOrder.forEach((ref, i) => {
    if (!eligible(ref))
      out.push(err("V1", `fallback.staticOrder[${i}]`, `"${ref}" ${describe(ref)}; the static order is the no-Jev routing path and must not route outside the allowlist`));
  });
  for (const [kind, ref] of Object.entries(config.models.allowlist.pins)) {
    if (typeof ref === "string" && !eligible(ref))
      out.push(err("V9", `models.allowlist.pins.${kind}`, `"${ref}" ${describe(ref)}; a pin outside the allowlist contradicts it`));
  }
  for (const ref of Object.keys(config.models.overrides)) {
    // A `disabled: true` override is a tightening and is always legitimate.
    if (config.models.overrides[ref as ModelRef]?.disabled === true) continue;
    if (!eligible(ref))
      out.push(err("V9", `models.overrides["${ref}"]`, `"${ref}" ${describe(ref)}; card overrides may only refine models that can actually be selected`));
  }
}

// ---------------------------------------------------------------------------
// V2, V3 — budget caps.
// ---------------------------------------------------------------------------

const CAP_KINDS = ["maxSpendUsd", "maxTokens", "maxRequests", "maxConcurrency", "maxElapsedMs"] as const;

function checkBudgetRules(config: KorwfConfig, out: ConfigIssue[]): void {
  const scopes = ["workflow", "phase", "task", "jev"] as const;
  for (const scope of scopes) {
    for (const cap of CAP_KINDS) {
      const v = config.budgets[scope][cap];
      if (typeof v === "number" && (!Number.isFinite(v) || v < 0))
        out.push(err("V2", `budgets.${scope}.${cap}`, `must be >= 0 or null (null = no cap of this kind), got ${v}`));
    }
  }
  const nested: readonly (readonly ["task" | "phase", "phase" | "workflow"])[] = [
    ["task", "phase"],
    ["phase", "workflow"],
    ["task", "workflow"],
  ];
  for (const [inner, outer] of nested) {
    for (const cap of CAP_KINDS) {
      const a = config.budgets[inner][cap];
      const b = config.budgets[outer][cap];
      if (typeof a === "number" && typeof b === "number" && a > b)
        out.push(err("V3", `budgets.${inner}.${cap}`, `${a} exceeds budgets.${outer}.${cap} (${b}); a child cap larger than its parent is unreachable`));
    }
  }
}

// ---------------------------------------------------------------------------
// V4, V10, V11, V12 — approval classes (delegated to the #15 table).
// ---------------------------------------------------------------------------

function checkApprovalRules(config: KorwfConfig, out: ConfigIssue[]): void {
  for (const v of validateApprovalClasses(config.approvals.classes)) {
    const path = "mode" in v ? `approvals.classes.${v.classId}.${v.mode}` : `approvals.classes.${v.classId}`;
    out.push(err(v.rule, path, v.message));
  }
}

// ---------------------------------------------------------------------------
// V5, V6, V7 — privacy floors, pattern compilation, carve-out narrowness.
// ---------------------------------------------------------------------------

/** Globs a carve-out may never re-open, however narrow it looks. */
const NEVER_CARVED_OUT = [
  "**/.env",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.netrc",
  "**/.git-credentials",
] as const;

function checkPrivacyRules(config: KorwfConfig, out: ConfigIssue[]): void {
  const { denyPaths, denyPatterns, allowPaths } = config.privacy;

  for (const shipped of SHIPPED_DENY_PATHS) {
    if (!denyPaths.includes(shipped))
      out.push(err("V5", "privacy.denyPaths", `is missing the shipped entry "${shipped}"; the deny list is a floor and a config layer may extend it but never reduce it`));
  }
  for (const shipped of SHIPPED_DENY_PATTERNS) {
    if (!denyPatterns.includes(shipped))
      out.push(err("V5", "privacy.denyPatterns", `is missing the shipped pattern ${JSON.stringify(shipped)}; the redaction list is a floor and cannot be reduced`));
  }

  denyPatterns.forEach((p, i) => {
    try {
      new RegExp(p, "iu");
    } catch (e) {
      out.push(err("V6", `privacy.denyPatterns[${i}]`, `is not a valid ECMAScript regex with flags "iu": ${(e as Error).message}`));
    }
  });

  allowPaths.forEach((glob, i) => {
    const path = `privacy.allowPaths[${i}]`;
    if (glob.includes("**"))
      out.push(err("V7", path, `"${glob}" uses "**"; a carve-out must name a specific file or a strictly narrower glob, never a whole class`));
    else if (glob.endsWith("/") || !glob.includes("."))
      out.push(err("V7", path, `"${glob}" looks like a bare directory; a carve-out must name a literal file path or a narrower glob`));
    for (const forbidden of NEVER_CARVED_OUT) {
      if (globToRegExp(forbidden).test(glob.replace(/^\.\//, "")))
        out.push(err("V7", path, `"${glob}" matches the key-material deny glob "${forbidden}"; credentials and key material can never be carved out`));
    }
    const intersects = denyPaths.some((d) => globToRegExp(d).test(glob.replace(/^\.\//, "")));
    if (!intersects && !glob.includes("*"))
      out.push(warn("V7", path, `"${glob}" does not intersect any deny entry, so the carve-out has no effect`));
  });
}

// ---------------------------------------------------------------------------
// V8 — storage path stays inside the project unless explicitly permitted.
// ---------------------------------------------------------------------------

function checkStorageRules(config: KorwfConfig, options: ValidateOptions, out: ConfigIssue[]): void {
  const p = config.storage.path;
  if (p === null || p === "") return;
  if (!isAbsolute(p)) return;
  if (config.storage.allowOutsideProject) return;
  const root = options.projectRoot;
  if (root === undefined) {
    out.push(err("V8", "storage.path", `is absolute; an absolute storage root outside the project requires storage.allowOutsideProject: true`));
    return;
  }
  const rel = relative(resolve(root), resolve(p));
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside)
    out.push(err("V8", "storage.path", `"${p}" is outside the project root; set storage.allowOutsideProject: true to move state off the project`));
}

// ---------------------------------------------------------------------------
// V9 (Jev half) — enabled without a key downgrades to optional mode.
// ---------------------------------------------------------------------------

function checkJevRules(config: KorwfConfig, options: ValidateOptions, out: ConfigIssue[]): void {
  if (!config.jev.enabled) return;
  if (config.jev.keySource.kind === "none") {
    out.push(warn("V9", "jev.enabled", `is true but jev.keySource.kind is "none"; Jev stays in optional mode and every Jev-assisted decision takes its deterministic fallback`));
    return;
  }
  if (options.jevKeyResolves === false)
    out.push(warn("V9", "jev.enabled", `is true but no key resolved from ${config.jev.keySource.kind}:${config.jev.keySource.name}; Jev stays in optional mode (deterministic workflow unaffected)`));
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Validate a merged config: schema first (types, enums, `const` pins, floors,
 * unknown keys), then the cross-field rules V1–V12. Errors block loading;
 * warnings are surfaced but never weaken or block anything.
 */
export function validateConfig(config: unknown, options: ValidateOptions = {}): ValidationResult {
  const issues: ConfigIssue[] = [];
  for (const issue of checkAgainstSchema(config)) issues.push(err("schema", issue.path, issue.message));

  if (issues.length === 0) {
    const c = config as KorwfConfig;
    checkAllowlistRules(c, options, issues);
    checkBudgetRules(c, issues);
    checkApprovalRules(c, issues);
    checkPrivacyRules(c, issues);
    checkStorageRules(c, options, issues);
    checkJevRules(c, options, issues);
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { ok: errors.length === 0, errors, warnings };
}

/** One-line rendering of an issue, used in error messages and the CLI. */
export const formatIssue = (i: ConfigIssue): string =>
  `[${i.rule}] ${i.path === "" ? "<config>" : i.path}: ${i.message}`;
