#!/usr/bin/env node
// Attribution check for issue #113 / ADR 0001.
//
// Scans src/, resources/ and scripts/ for the ADR 0001 attribution header
// ("Adapted from pi <version> examples/extensions/<path> — MIT, © Mario Zechner / earendil-works")
// and cross-checks against the "Adapted files" table in THIRD_PARTY_NOTICES.md.
//
// Fails (non-zero exit / thrown error) when:
//   1. a file cites a Pi example in its header but is not listed in the table;
//   2. a file is listed in the table but carries no header (stale notice);
//   3. a listed row's source path or version disagrees with the header;
//   4. a header cites an example that does not appear in the ADR 0001 copy manifest.
//
// Usable as a CLI (`node scripts/check-third-party-notices.mjs`) and as a library
// (test/notices/third-party-notices.test.ts imports `checkNotices`).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HEADER_RE =
  /Adapted from pi (\d+\.\d+\.\d+(?:[-+][\w.]+)?) examples\/extensions\/([^\s—]+) — MIT, © Mario Zechner \/ earendil-works/;

const SCAN_DIRS = ["src", "resources", "scripts"];
const SCAN_EXT = new Set([".ts", ".mts", ".js", ".mjs", ".md"]);
const HEADER_WINDOW_LINES = 15;

export function listSourceFiles(root) {
  const out = [];
  for (const dir of SCAN_DIRS) {
    walk(join(root, dir), out);
  }
  return out.map((p) => relative(root, p).split(sep).join("/")).sort();
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ([...SCAN_EXT].some((e) => name.endsWith(e))) out.push(p);
  }
}

/** Returns `{ version, source }` when the head of `text` carries the ADR 0001 header. */
export function parseHeader(text) {
  const head = text.split("\n").slice(0, HEADER_WINDOW_LINES).join("\n");
  const m = HEADER_RE.exec(head);
  return m ? { version: m[1], source: m[2] } : undefined;
}

/** Parses the "Adapted files" table between the notices markers. */
export function parseNoticesTable(markdown) {
  const start = markdown.indexOf("<!-- notices:adapted-files:start -->");
  const end = markdown.indexOf("<!-- notices:adapted-files:end -->");
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      "THIRD_PARTY_NOTICES.md: missing notices:adapted-files markers",
    );
  }
  const rows = new Map();
  for (const line of markdown.slice(start, end).split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    if (cells[0].startsWith("---") || cells[0] === "File in this repository")
      continue;
    if (cells[0].startsWith("_none")) continue;
    const file = cells[0].replace(/^`|`$/g, "");
    const source = cells[1].replace(/^`|`$/g, "");
    rows.set(file, { source, version: cells[2].replace(/\*/g, "").trim() });
  }
  return rows;
}

/** Source paths named in the ADR 0001 copy manifest (`examples/extensions/<path>`). */
export function parseManifestSources(adr) {
  const start = adr.indexOf("## Copy manifest");
  const end = adr.indexOf("## Consequences", start);
  const sources = new Set();
  for (const line of adr.slice(start, end).split("\n")) {
    const m = /^\|\s*\d+\s*\|[^|]*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) sources.add(m[1]);
  }
  return sources;
}

/**
 * Runs the check against `root`. Returns `{ attributed, listed, errors }`;
 * `errors` is empty when everything is consistent (vacuously true when no file is
 * attributed and no file is listed).
 */
export function checkNotices(root, options = {}) {
  const noticesPath =
    options.noticesPath ?? join(root, "THIRD_PARTY_NOTICES.md");
  const adrPath =
    options.adrPath ?? join(root, "docs/adr/0001-reuse-of-pi-examples.md");
  const files = options.files ?? listSourceFiles(root);
  const errors = [];

  let notices;
  try {
    notices = readFileSync(noticesPath, "utf8");
  } catch {
    errors.push(`THIRD_PARTY_NOTICES.md not found at ${noticesPath}`);
    return { attributed: new Map(), listed: new Map(), errors };
  }
  const listed = parseNoticesTable(notices);
  let manifest = new Set();
  try {
    manifest = parseManifestSources(readFileSync(adrPath, "utf8"));
  } catch {
    errors.push(`ADR 0001 not found at ${adrPath}`);
  }

  const attributed = new Map();
  for (const rel of files) {
    const header = parseHeader(readFileSync(join(root, rel), "utf8"));
    if (header) attributed.set(rel, header);
  }

  for (const [file, header] of attributed) {
    const row = listed.get(file);
    if (!row) {
      errors.push(
        `${file} cites examples/extensions/${header.source} (pi ${header.version}) but is not listed in THIRD_PARTY_NOTICES.md`,
      );
      continue;
    }
    if (row.source !== header.source) {
      errors.push(
        `${file}: notices list source "${row.source}" but header cites "${header.source}"`,
      );
    }
    if (row.version !== header.version) {
      errors.push(
        `${file}: notices list pi ${row.version} but header cites pi ${header.version}`,
      );
    }
    if (manifest.size > 0 && !manifest.has(header.source)) {
      errors.push(
        `${file}: header cites "${header.source}", which is not in the ADR 0001 copy manifest`,
      );
    }
  }
  for (const file of listed.keys()) {
    if (!attributed.has(file)) {
      errors.push(
        `${file} is listed in THIRD_PARTY_NOTICES.md but carries no ADR 0001 attribution header`,
      );
    }
  }
  return { attributed, listed, errors };
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const { attributed, listed, errors } = checkNotices(root);
  console.log(
    `third-party notices: ${attributed.size} attributed file(s), ${listed.size} listed row(s)`,
  );
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(errors.length ? 1 : 0);
}
