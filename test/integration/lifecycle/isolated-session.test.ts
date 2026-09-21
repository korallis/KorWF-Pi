/**
 * Stage 2 exit criterion, part 1: "loads in an isolated Pi session"
 * (issue #32 Scope test 1; PLAN §8 Stage 2 Exit).
 *
 * A fresh temporary Pi config directory, the package installed from its local
 * path, a real Pi process started in a fresh project, one `/korwf` command
 * run, and the transcript captured. The session must load with no error and
 * must write nothing outside the temp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  installPackage,
  makeIsolatedPi,
  piCliAvailable,
  runKorwf,
  PACKAGE_ROOT,
  type IsolatedPi,
} from "./pi-session.ts";

const available = piCliAvailable();

/**
 * Comparing the whole repository tree would race with the test runner's own
 * output, so the "writes nothing outside the temp dir" assertion watches
 * `src/` — the shipped code the session loads. A session that wrote state
 * beside its own source would show up here immediately.
 */
const PACKAGE_SOURCE_DIR = join(PACKAGE_ROOT, "src");

/** Every path under `dir`, relative and sorted, for before/after comparison. */
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      out.push(relative(dir, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

describe.skipIf(!available)("M2 exit: the package loads in an isolated Pi session", () => {
  let pi: IsolatedPi;

  beforeAll(() => {
    pi = makeIsolatedPi("korwf-isolated-");
    const install = installPackage(pi);
    expect(install.status, `pi install failed: ${install.stderr}`).toBe(0);
  });

  afterAll(() => {
    pi.cleanup();
  });

  it("installs from the local path into the temporary config dir only", () => {
    const settings = JSON.parse(readFileSync(join(pi.configDir, "settings.json"), "utf8")) as {
      packages?: unknown[];
    };
    expect(settings.packages).toHaveLength(1);
    // The recorded entry resolves back to this repository, whatever form the
    // path takes (pi may store it relative to the settings file).
    const entry = String(settings.packages?.[0]);
    const resolved = entry.startsWith("/") ? entry : join(pi.configDir, entry);
    expect(statSync(join(resolved, "package.json")).isFile()).toBe(true);
    expect(resolved.replace(/\/+$/, "")).toBe(PACKAGE_ROOT);
  });

  it("runs /korwf version in the session and reports the package version", () => {
    const run = runKorwf(pi, ["/korwf version"]);
    const version = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(run.stderr).not.toMatch(/Failed to load extension/);
    expect(run.transcript).toContain(`v${version.version}`);
    expect(run.events.some((e) => e.type === "response" && e.command === "prompt" && e.success === true)).toBe(
      true,
    );
  });

  it("exposes the whole /korwf namespace without an error notification", () => {
    const run = runKorwf(pi, ["/korwf version", "/korwf status", "/korwf config", "/korwf jev"]);
    const errors = run.events.filter(
      (e) => e.type === "extension_ui_request" && e.method === "notify" && e["notifyType"] === "error",
    );
    expect(errors).toEqual([]);
    expect(run.transcript).toContain("korwf status:");
    expect(run.transcript).toContain("KorWF-Pi configuration");
    expect(run.transcript).toContain("Jev credential status");
  });

  it("writes nothing outside the temp dir: the package source tree is untouched", () => {
    const before = listTree(PACKAGE_SOURCE_DIR);
    runKorwf(pi, ["/korwf version", "/korwf config"]);
    expect(listTree(PACKAGE_SOURCE_DIR)).toEqual(before);
  });

  it("writes only under .korwf/ inside the isolated project", () => {
    // `/korwf why` opens the store, which is the only thing that creates
    // project state. Everything it creates must be under `.korwf/`.
    runKorwf(pi, ["/korwf why"]);
    const projectEntries = listTree(pi.project).filter((p) => !p.startsWith(".korwf"));
    expect(projectEntries).toEqual([]);
    expect(listTree(pi.project)).toContain(".korwf");
  });
});
