/**
 * Loading and layered merge (issue #21).
 *
 * AC1: "Empty config → valid, Jev disabled, all defaults."
 * Merge order from the issue Scope: shipped defaults < user < project < env.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import {
  loadConfig,
  defaultConfig,
  mergeLayer,
  envOverrides,
  ENV_OVERRIDES,
  defaultUserConfigDir,
  PROJECT_CONFIG_RELATIVE_PATH,
  USER_CONFIG_RELATIVE_PATH,
} from "../../../src/config/index.ts";
import type { ConfigLoadResult, LoadedConfig } from "../../../src/config/index.ts";

/** Narrow a load result to success, failing the test with the errors if not. */
function expectOk(result: ConfigLoadResult): LoadedConfig {
  if (!result.ok) expect.unreachable(result.message);
  return result;
}

/** A project dir with an optional user dir; both are temp dirs. */
function fixture(project: unknown, user?: unknown) {
  const dir = makeTempDir();
  const projectRoot = join(dir.path, "project");
  const userDir = join(dir.path, "user");
  mkdirSync(join(projectRoot, ".korwf"), { recursive: true });
  mkdirSync(join(userDir, "korwf"), { recursive: true });
  if (project !== undefined)
    writeFileSync(join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH), JSON.stringify(project));
  if (user !== undefined) writeFileSync(join(userDir, USER_CONFIG_RELATIVE_PATH), JSON.stringify(user));
  return { projectRoot, userDir, cleanup: dir.cleanup };
}

describe("AC1: an empty config is valid, Jev is disabled, every default applies", () => {
  it("loads with no config files at all", () => {
    const f = fixture(undefined, undefined);
    try {
      const { config, warnings } = expectOk(loadConfig(f.projectRoot, { userConfigDir: f.userDir, env: {} }));
      expect(warnings).toEqual([]);
      expect(config.configVersion).toBe(1);
      expect(config.mode).toBe("shadow");
      expect(config.jev.enabled).toBe(false);
      expect(config.models.allowlist.providers).toEqual([]);
      expect(config.fallback.staticOrder).toEqual([]);
      expect(config.storage.path).toBeNull();
      expect(config.approvals.classes.remote_push.bounded_autonomous).toBe("stop");
    } finally {
      f.cleanup();
    }
  });

  it("an explicitly empty `{}` file is equivalent to no file", () => {
    const f = fixture({}, {});
    try {
      const { config } = expectOk(loadConfig(f.projectRoot, { userConfigDir: f.userDir, env: {} }));
      expect(config).toEqual(defaultConfig());
    } finally {
      f.cleanup();
    }
  });

  it("threat-model §4.3 defaults are exactly as documented", () => {
    const c = defaultConfig();
    expect(c.jev.enabled).toBe(false);
    expect(c.privacy.rawLogging.enabled).toBe(false);
    expect(c.privacy.rawLogging.redactBeforeWrite).toBe(true);
    expect(c.privacy.outbound.sendRepoIdentity).toBe(false);
    expect(c.privacy.outbound.sendFilePaths).toBe(true);
    expect(c.privacy.outbound.maxRequestBytes).toBe(262144);
    expect(c.privacy.firstUseDisclosure).toBe(true);
    expect(c.notifications.channels.desktop.enabled).toBe(false);
    expect(c.notifications.channels.command.enabled).toBe(false);
    expect(c.notifications.channels.webhook.enabled).toBe(false);
    expect(c.storage.allowOutsideProject).toBe(false);
    expect(c.privacy.denyPaths).toHaveLength(40);
    expect(c.privacy.denyPatterns).toHaveLength(10);
  });

  it("the resolved config is deep-frozen", () => {
    const c = defaultConfig();
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.privacy)).toBe(true);
    expect(Object.isFrozen(c.privacy.denyPaths)).toBe(true);
    expect(() => {
      (c as { mode: string }).mode = "bounded_autonomous";
    }).toThrow();
  });
});

describe("merge order: defaults < user < project < env", () => {
  it("project overrides user, user overrides defaults", () => {
    const f = fixture({ mode: "supervised" }, { mode: "advisory", approvals: { queueTimeoutMinutes: 15 } });
    try {
      const { config, layers } = expectOk(loadConfig(f.projectRoot, { userConfigDir: f.userDir, env: {} }));
      expect(config.mode).toBe("supervised");
      expect(config.approvals.queueTimeoutMinutes).toBe(15);
      expect(config.budgets.workflow.maxSpendUsd).toBe(10);
      expect(layers.map((l) => l.layer)).toEqual(["defaults", "user", "project", "env"]);
      expect(layers.filter((l) => l.present).map((l) => l.layer)).toEqual(["defaults", "user", "project"]);
    } finally {
      f.cleanup();
    }
  });

  it("environment overrides win over every file, and only documented vars are read", () => {
    const f = fixture({ mode: "supervised" });
    try {
      const { config, layers } = expectOk(
        loadConfig(f.projectRoot, {
          userConfigDir: f.userDir,
          env: { KORWF_MODE: "advisory", KORWF_UNKNOWN: "x", HOME: "/nowhere" },
        }),
      );
      expect(config.mode).toBe("advisory");
      expect(layers.find((l) => l.layer === "env")?.present).toBe(true);
      expect(envOverrides({ KORWF_UNKNOWN: "x" })).toEqual({ data: {}, present: false });
      expect(ENV_OVERRIDES.every((o) => o.env.startsWith("KORWF_"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("objects merge key by key while arrays and scalars are replaced", () => {
    expect(mergeLayer({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
    expect(mergeLayer({ a: [1, 2, 3] }, { a: [4] })).toEqual({ a: [4] });
    expect(mergeLayer({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("the default user config dir comes from the environment, never a shipped path", () => {
    expect(defaultUserConfigDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent-dir" })).toBe("/tmp/custom-agent-dir");
    expect(defaultUserConfigDir({})).toMatch(/\.pi[/\\]agent$/);
  });
});
