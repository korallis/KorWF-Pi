/**
 * The shipped minimum deny list and the glob matcher that enforces it
 * (issue #28; PLAN §7 "Default-deny outbound for secrets and sensitive paths").
 *
 * Two things live here and nothing else:
 *
 *  1. `SHIPPED_DENY_PATH_NOTES` — the shipped minimum from
 *     `src/config/schema.json` (`$defs/ShippedDenyPaths`, pinned by `const`)
 *     with a sentence per entry saying *why* it is denied. The globs
 *     themselves are **not** re-declared here: they are read from the schema
 *     via `src/config/defaults.ts`, so this file cannot drift from the
 *     contract the config validator enforces. A missing or extra note is a
 *     load-time error (`assertDenyListDocumented`), so a future entry cannot
 *     be added without documenting it.
 *  2. `DenyMatcher` — glob matching for those entries plus whatever the
 *     user's `privacy.denyPaths` adds, with `privacy.allowPaths` carve-outs
 *     that can never relax a shipped entry.
 *
 * Matching is deliberately dumb and dependency-free: a small glob subset
 * (`**`, `*`, `?`, character classes, `{a,b}`) compiled to an anchored
 * regular expression. Paths are normalised first (backslashes to `/`,
 * `./` stripped, repeated slashes collapsed) and matched **both** as given
 * and as each of their trailing sub-paths, so a deny entry written for a
 * project-relative path still catches an absolute path from another root.
 */
import { SHIPPED_DENY_PATHS } from "../config/defaults.ts";

/** Why a path was refused. Reported verbatim in `OutboundReport`. */
export type DenyRule = "shipped" | "config" | "absolute" | "traversal";

/** A decision about one path. */
export interface DenyVerdict {
  /** True when the path must not be read, sent, or logged. */
  readonly denied: boolean;
  /** The glob that matched, or `null` for a structural refusal. */
  readonly glob: string | null;
  readonly rule: DenyRule | null;
  /** Normalised form of the path the verdict was reached on. */
  readonly normalised: string;
}

// ---------------------------------------------------------------------------
// documented shipped minimum
// ---------------------------------------------------------------------------

/**
 * One sentence per shipped deny glob. Keys must match
 * `$defs/ShippedDenyPaths` in `src/config/schema.json` exactly — the schema
 * is the contract, this map is its documentation.
 */
export const SHIPPED_DENY_PATH_NOTES: Readonly<Record<string, string>> = Object.freeze({
  "**/.env": "Environment files are the single most common place a real credential sits in a repository.",
  "**/.env.*": "Same, for per-environment variants (.env.local, .env.production) including committed ones.",
  "**/*.pem": "PEM containers hold private keys and certificates.",
  "**/*.key": "Private key material by convention and by extension.",
  "**/*.p12": "PKCS#12 bundles carry a private key with its certificate chain.",
  "**/*.pfx": "Windows-format PKCS#12; same contents under a different extension.",
  "**/*.jks": "Java keystores hold signing and TLS keys.",
  "**/id_rsa*": "OpenSSH RSA private keys (and their .pub siblings, which identify the user).",
  "**/id_ed25519*": "OpenSSH Ed25519 private keys.",
  "**/id_ecdsa*": "OpenSSH ECDSA private keys.",
  "**/.ssh/**": "The whole SSH directory: keys, known_hosts, and config naming internal hosts.",
  "**/.gnupg/**": "GnuPG keyrings and trust database.",
  "**/.aws/**": "AWS credentials and config, including session tokens.",
  "**/.azure/**": "Azure CLI tokens and subscription identifiers.",
  "**/.config/gcloud/**": "Google Cloud CLI credentials and refresh tokens.",
  "**/.kube/config": "Kubernetes contexts embed client certificates and bearer tokens.",
  "**/.netrc": "Plaintext machine/login/password triples used by curl, git and ftp.",
  "**/.npmrc": "npm registry auth tokens (_authToken).",
  "**/.pypirc": "PyPI upload credentials.",
  "**/.docker/config.json": "Docker registry auth, base64 but not encrypted.",
  "**/.git/config": "Remote URLs can embed user:password, and name private infrastructure.",
  "**/.git/credentials": "Git's credential store, written in cleartext.",
  "**/.git-credentials": "The home-directory form of the same cleartext store.",
  "**/credentials.json": "Conventional name for OAuth client secrets and service-account keys.",
  "**/service-account*.json": "Google service-account keys contain a PEM private key inline.",
  "**/secrets.*": "Files named for their contents, in any format.",
  "**/*.secret": "Same, by extension.",
  "**/*.keystore": "Android and Java signing keystores.",
  "**/.korwf/**": "KorWF-Pi's own state: config (which may carry a key source), the SQLite store, traces and artefacts.",
  "**/node_modules/**": "Third-party code: never relevant state, and large enough to blow every outbound budget.",
  "**/dist/**": "Build output: derived, often minified, and it can inline build-time secrets.",
  "**/build/**": "Build output under the other common name.",
  "**/out/**": "Build output under the third common name.",
  "**/target/**": "Rust/JVM build output.",
  "**/.next/**": "Next.js build cache, which embeds environment values at build time.",
  "**/coverage/**": "Coverage reports: derived, bulky, and they mirror source content.",
  "**/*.log": "Logs accumulate tokens, headers and stack traces from every tool that wrote them.",
  "**/*.sqlite": "Databases are opaque binaries; sending one is never minimal state.",
  "**/*.sqlite3": "Same, alternate extension.",
  "**/*.db": "Same, generic extension.",
});

/**
 * Fail loudly if the documented set and the schema's shipped minimum ever
 * diverge. Called at module load: an undocumented deny entry is a review
 * failure, not a runtime surprise, and a documented-but-removed entry means
 * the shipped floor was weakened.
 */
export function assertDenyListDocumented(shipped: readonly string[] = SHIPPED_DENY_PATHS): void {
  const documented = new Set(Object.keys(SHIPPED_DENY_PATH_NOTES));
  const missing = shipped.filter((glob) => !documented.has(glob));
  const extra = [...documented].filter((glob) => !shipped.includes(glob));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      "src/security/deny-list.ts is out of sync with schema.json $defs/ShippedDenyPaths" +
        (missing.length > 0 ? `; undocumented: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; documented but not shipped: ${extra.join(", ")}` : ""),
    );
  }
}

assertDenyListDocumented();

// ---------------------------------------------------------------------------
// path normalisation
// ---------------------------------------------------------------------------

/**
 * Canonical form for matching: `/` separators, no `./` segments, no repeated
 * slashes, no trailing slash. Windows drive letters are kept but lower-cased
 * so `C:\x` and `c:/x` normalise alike. Nothing touches the filesystem: this
 * is a pure string transform, usable on paths that do not exist.
 */
export function normalisePath(path: string): string {
  if (typeof path !== "string") return "";
  let out = path.replace(/\\/g, "/");
  out = out.replace(/^([A-Za-z]):\//, (_m, drive: string) => `${drive.toLowerCase()}:/`);
  out = out.replace(/\/{2,}/g, "/");
  out = out.replace(/(^|\/)\.(?=\/)/g, "$1").replace(/\/{2,}/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** Every trailing sub-path, longest first (`a/b/c` → `a/b/c`, `b/c`, `c`). */
function suffixes(path: string): string[] {
  const parts = path.split("/").filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(i).join("/"));
  return out;
}

// ---------------------------------------------------------------------------
// glob compilation
// ---------------------------------------------------------------------------

/**
 * Compile the glob subset the deny list uses into an anchored regex:
 * `**` (any number of segments), `*` (within one segment), `?` (one char),
 * `[...]` classes and `{a,b}` alternation. Everything else is literal.
 *
 * Unsupported or malformed syntax never throws — a deny list that failed to
 * compile would fail open, which is exactly the wrong direction — so the
 * offending character is treated as a literal instead.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? "";
    if (ch === "*") {
      const doubled = glob[i + 1] === "*";
      if (doubled) {
        i += 1;
        // `**/` also matches zero segments, so `**/x` matches a bare `x`.
        if (glob[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i + 1) {
        const body = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = close;
        continue;
      }
      out += "\\[";
      continue;
    }
    if (ch === "{") {
      depth += 1;
      out += "(?:";
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      out += ")";
      continue;
    }
    if (ch === "," && depth > 0) {
      out += "|";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  while (depth > 0) {
    out += ")";
    depth -= 1;
  }
  return new RegExp(`^${out}$`, "i");
}

// ---------------------------------------------------------------------------
// the matcher
// ---------------------------------------------------------------------------

export interface DenyMatcherOptions {
  /** `privacy.denyPaths`; already a superset of the shipped minimum (V5). */
  readonly denyPaths?: readonly string[];
  /** `privacy.allowPaths` carve-outs. Never able to relax a shipped entry. */
  readonly allowPaths?: readonly string[];
  /**
   * Refuse absolute paths outright (default `true`): an absolute path leaks
   * the user's directory layout, and `privacy.outbound.sendFilePaths`
   * documents that absolute paths are never sent.
   */
  readonly denyAbsolute?: boolean;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:\//i.test(path) || path.startsWith("~");
}

function hasTraversal(path: string): boolean {
  return path.split("/").includes("..");
}

/**
 * Decides whether a path may contribute content to an outbound request.
 *
 * Default-deny in the two senses PLAN §7 means: every shipped glob applies
 * whatever the config says, and a carve-out in `allowPaths` is honoured only
 * for entries the *user* added — a carve-out can never re-open `.env` or any
 * other shipped entry, which is what "never weakens its own policy" requires.
 */
export class DenyMatcher {
  readonly #shipped: readonly { glob: string; re: RegExp }[];
  readonly #extra: readonly { glob: string; re: RegExp }[];
  readonly #allow: readonly { glob: string; re: RegExp }[];
  readonly #denyAbsolute: boolean;

  constructor(options: DenyMatcherOptions = {}) {
    const compile = (glob: string): { glob: string; re: RegExp } => ({ glob, re: globToRegExp(glob) });
    const shippedSet = new Set(SHIPPED_DENY_PATHS);
    const configured = options.denyPaths ?? SHIPPED_DENY_PATHS;
    this.#shipped = SHIPPED_DENY_PATHS.map(compile);
    this.#extra = configured.filter((glob) => !shippedSet.has(glob)).map(compile);
    this.#allow = (options.allowPaths ?? []).map(compile);
    this.#denyAbsolute = options.denyAbsolute ?? true;
  }

  /** Globs this matcher enforces, shipped first. Order is stable for tests. */
  get globs(): readonly string[] {
    return [...this.#shipped.map((e) => e.glob), ...this.#extra.map((e) => e.glob)];
  }

  #matches(entries: readonly { glob: string; re: RegExp }[], candidates: readonly string[]): string | null {
    for (const entry of entries) {
      for (const candidate of candidates) {
        if (entry.re.test(candidate)) return entry.glob;
      }
    }
    return null;
  }

  /** Full verdict for one path. */
  verdict(path: string): DenyVerdict {
    const normalised = normalisePath(path);
    if (normalised.length === 0) {
      return { denied: true, glob: null, rule: "traversal", normalised };
    }
    if (hasTraversal(normalised)) {
      return { denied: true, glob: null, rule: "traversal", normalised };
    }
    if (this.#denyAbsolute && isAbsolute(normalised)) {
      return { denied: true, glob: null, rule: "absolute", normalised };
    }

    // Match the path itself and every trailing sub-path, so `**/.env` catches
    // an entry recorded as `/srv/app/.env` and as `app/.env` alike.
    const candidates = [normalised, ...suffixes(normalised)];

    const shipped = this.#matches(this.#shipped, candidates);
    if (shipped !== null) return { denied: true, glob: shipped, rule: "shipped", normalised };

    const extra = this.#matches(this.#extra, candidates);
    if (extra === null) return { denied: false, glob: null, rule: null, normalised };

    // Carve-outs apply only to user-added entries (checked above: a shipped
    // match already returned).
    const allowed = this.#matches(this.#allow, candidates);
    if (allowed !== null) return { denied: false, glob: null, rule: null, normalised };
    return { denied: true, glob: extra, rule: "config", normalised };
  }

  /** Convenience predicate. */
  denies(path: string): boolean {
    return this.verdict(path).denied;
  }
}
