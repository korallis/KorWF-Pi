/**
 * Bundled aptitude hints (issue #58; PLAN §3.D layer 2).
 *
 * A small, shipped, versioned file (`resources/hints.json`) mapping model
 * FAMILIES — by id *pattern*, not by exact id — to short aptitude
 * descriptions (front-end/UI, deep reasoning, large refactors, tool use,
 * speed, ...). It exists so a proxied or locally renamed model (a user's
 * `mycorp/sonnet` fronting `claude-sonnet-5`) still gets the Claude family's
 * hints: the match is against the *bare model id*, with the provider prefix
 * and common cosmetic suffixes (dates, quantisation tags) stripped first,
 * never against the provider name.
 *
 * Hints are ADVISORY ONLY (PLAN §3.D, restated in #57): they can only RANK
 * candidates that #56's catalog already admitted. This module has no
 * exclusion power and does not consult the allowlist. A model that matches
 * no pattern is `unrated` here — never a fabricated aptitude — which is the
 * honest signal that routes Jev's ranking to the static fallback order.
 *
 * `resources/` is shipped, read-only, versioned data (docs/adr/0002); this
 * module only loads and matches it. Loading is defensive: a malformed or
 * unparsable hints file disables hints for the run (every id becomes
 * `unrated`) with a returned message, never a crash and never a silent
 * partial match.
 *
 * Pure module: no I/O beyond the one shipped file (path resolved from this
 * module's own URL, never cwd), no Pi imports, no provider names or
 * credentials. The author's local proxy name (`mac-mini`) must never appear
 * here — see docs/model-hints.md and the shipped-file test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelRef } from "../config/types.ts";
import type { HintMatch, HintLookup } from "./cards.ts";

export type { HintMatch, HintLookup };

/** One raw entry as it appears in `resources/hints.json`. */
export interface HintEntry {
  readonly pattern: string;
  readonly family: string;
  readonly aptitudes: readonly string[];
  readonly caveats?: readonly string[];
}

/** The shipped file's shape. */
export interface HintsFile {
  readonly version: number;
  readonly entries: readonly HintEntry[];
}

/** Absolute path of the shipped hints file, resolved from this module, never cwd. */
export function hintsFilePath(): string {
  return fileURLToPath(new URL("../../resources/hints.json", import.meta.url));
}

// ---------------------------------------------------------------------------
// Schema validation: an invalid file disables hints, it never crashes.
// ---------------------------------------------------------------------------

export interface HintsValidationIssue {
  readonly path: string;
  readonly message: string;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every(isString);
}

/** Structural validation of the parsed hints document. Never throws. */
export function validateHintsFile(doc: unknown): { readonly issues: readonly HintsValidationIssue[] } {
  const issues: HintsValidationIssue[] = [];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { issues: [{ path: "", message: "hints file must be a JSON object" }] };
  }
  const obj = doc as Record<string, unknown>;

  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
    issues.push({ path: "version", message: "must be a positive integer" });
  }

  if (!Array.isArray(obj.entries)) {
    issues.push({ path: "entries", message: "must be an array" });
    return { issues };
  }

  obj.entries.forEach((raw, i) => {
    const p = `entries[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({ path: p, message: "must be an object" });
      return;
    }
    const e = raw as Record<string, unknown>;
    if (!isString(e.pattern) || e.pattern.length === 0) {
      issues.push({ path: `${p}.pattern`, message: "must be a non-empty string (regex source)" });
    } else {
      try {
        new RegExp(e.pattern, "i");
      } catch {
        issues.push({ path: `${p}.pattern`, message: "must be a valid regular expression" });
      }
    }
    if (!isString(e.family) || e.family.length === 0) {
      issues.push({ path: `${p}.family`, message: "must be a non-empty string" });
    }
    if (!isStringArray(e.aptitudes)) {
      issues.push({ path: `${p}.aptitudes`, message: "must be an array of strings" });
    }
    if (e.caveats !== undefined && !isStringArray(e.caveats)) {
      issues.push({ path: `${p}.caveats`, message: "must be an array of strings when present" });
    }
  });

  return { issues };
}

// ---------------------------------------------------------------------------
// Id-pattern matching: provider prefix and cosmetic suffixes are ignored.
// ---------------------------------------------------------------------------

/**
 * Suffixes that are cosmetic decoration on a bare model id, not part of its
 * family identity: release dates (`-2025-06-20`, `-20250620`), quantisation
 * tags (`-q4`, `-q4_k_m`, `-int8`, `-gguf`, `-awq`, `-fp16`), and generic
 * size/build markers (`-latest`, `-preview`, `-instruct`). Stripped
 * repeatedly from the end so multiple suffixes (`-latest-q4_k_m`) all go.
 */
const SUFFIX_PATTERNS: readonly RegExp[] = [
  /-\d{4}-\d{2}-\d{2}$/, // -2025-06-20
  /-\d{8}$/, // -20250620
  /-(q\d+(_[a-z0-9]+)*|int4|int8|fp16|fp8|bf16|gguf|awq|gptq)$/i,
  /-(latest|preview|stable|instruct|chat|base)$/i,
];

/** Strip a leading `provider/` segment, if present. */
function stripProviderPrefix(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Repeatedly strip trailing cosmetic suffixes (date/quant/build tags). */
function stripCosmeticSuffixes(bareId: string): string {
  let cur = bareId;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of SUFFIX_PATTERNS) {
      const next = cur.replace(re, "");
      if (next !== cur && next.length > 0) {
        cur = next;
        changed = true;
      }
    }
  }
  return cur;
}

/** The normalised id a hint pattern is matched against: no provider prefix, no cosmetic suffix. */
export function normalizeForMatch(ref: ModelRef): string {
  return stripCosmeticSuffixes(stripProviderPrefix(ref)).toLowerCase();
}

// ---------------------------------------------------------------------------
// Loading and lookup.
// ---------------------------------------------------------------------------

/** A compiled, ready-to-match hint entry. */
interface CompiledHint {
  readonly re: RegExp;
  readonly family: string;
  readonly aptitudes: readonly string[];
  readonly caveats?: readonly string[];
}

export interface LoadHintsResult {
  /** `undefined` when the file was invalid/unreadable — hints are disabled for this run. */
  readonly hints?: HintsFile;
  readonly compiled: readonly CompiledHint[];
  readonly enabled: boolean;
  /** Present when `enabled` is `false`: why hints are disabled, never a stack trace. */
  readonly disabledReason?: string;
}

function compile(entries: readonly HintEntry[]): readonly CompiledHint[] {
  return entries.map((e) => ({
    re: new RegExp(e.pattern, "i"),
    family: e.family,
    aptitudes: e.aptitudes,
    ...(e.caveats !== undefined ? { caveats: e.caveats } : {}),
  }));
}

/**
 * Load and validate the shipped hints file. Never throws: a missing,
 * unparsable, or schema-invalid file yields `{ enabled: false, disabledReason }`
 * so callers can surface a message and continue with every model `unrated`
 * (AC: "invalid file -> hints disabled with a message, not a crash").
 */
export function loadHints(path: string = hintsFilePath()): LoadHintsResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { compiled: [], enabled: false, disabledReason: `could not read hints file: ${(err as Error).message}` };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { compiled: [], enabled: false, disabledReason: `hints file is not valid JSON: ${(err as Error).message}` };
  }

  const { issues } = validateHintsFile(doc);
  if (issues.length > 0) {
    const summary = issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
    return { compiled: [], enabled: false, disabledReason: `hints file failed schema validation: ${summary}` };
  }

  const hints = doc as HintsFile;
  return { hints, compiled: compile(hints.entries), enabled: true };
}

/**
 * Resolve hints for a set of model ids into the `HintLookup` shape #57's
 * `mergeCards` consumes. Ids that match no pattern are simply absent from
 * the map — #57 already treats an absent lookup as `unrated`. First
 * matching entry (in file order) wins; entries are kept deliberately small
 * so ordering conflicts are rare and visible in review.
 */
export function resolveHints(refs: readonly ModelRef[], loaded: LoadHintsResult): HintLookup {
  const out = new Map<ModelRef, HintMatch>();
  if (!loaded.enabled) return out;
  for (const ref of refs) {
    const normalized = normalizeForMatch(ref);
    const match = loaded.compiled.find((c) => c.re.test(normalized));
    if (match) {
      out.set(ref, {
        ref,
        family: match.family,
        aptitudes: match.aptitudes,
        ...(match.caveats !== undefined ? { caveats: match.caveats } : {}),
      });
    }
  }
  return out;
}
