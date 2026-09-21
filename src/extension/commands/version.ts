/**
 * `/korwf version` subcommand (issue #19 Scope).
 *
 * Prints the installed KorWF-Pi package version. Reads `package.json`
 * relative to this module so it works regardless of the package's install
 * location (npm, git, or local path per docs/packages.md), with no
 * hardcoded, user-specific paths.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
}

let cachedVersion: string | undefined;

/** Resolve and cache the package version by reading package.json from disk. */
export function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/extension/commands/version.ts -> package root is three levels up.
  const packageJsonPath = join(here, "..", "..", "..", "package.json");
  const raw = readFileSync(packageJsonPath, "utf8");
  const manifest = JSON.parse(raw) as PackageManifest;
  cachedVersion = manifest.version;
  return cachedVersion;
}

/** Text printed by `/korwf version`. */
export function versionMessage(): string {
  return `korwf-pi v${getPackageVersion()}`;
}
