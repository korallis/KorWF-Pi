/**
 * End-to-end leak paths (issue #22).
 *
 * AC1: "Test writes a known fake key through every log/error/export path and
 *       asserts it is absent from all outputs."
 *
 * The suites in `redact.test.ts` exercise the redactor directly. This one
 * drives the *product* surfaces a key can actually reach: the extension's UI
 * boundary, the `/korwf jev` and `/korwf config` messages, the config loader
 * with the key present in the environment, and a file written to disk.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import {
  clearRegisteredSecrets,
  resolveJevKey,
  redactedStringify,
  redactString,
  DEFAULT_KEY_ENV_VAR,
  REDACTED,
} from "../../../src/security/index.ts";
import { redactedUi, uiLogger, guardHandler } from "../../../src/extension/redacted-ui.ts";
import { jevStatusMessage } from "../../../src/extension/commands/jev-status.ts";
import { configMessage } from "../../../src/extension/commands/config.ts";
import { loadConfig, PROJECT_CONFIG_RELATIVE_PATH } from "../../../src/config/index.ts";
import { buildDisclosure } from "../../../src/extension/disclosure.ts";
import type { KorwfConfig } from "../../../src/config/types.ts";

/** A fake key with a credential shape. Not a real credential. */
const FAKE_KEY = "apikey_XXXXfakefakefakeabcdef01234567"; // check-secrets:allow

/** Collects everything a fake Pi UI was told. */
function recordingUi() {
  const messages: string[] = [];
  return {
    messages,
    notify: (message: string, _level?: "info" | "warning" | "error") => {
      messages.push(message);
    },
  };
}

/** Project dir whose config turns Jev on, with the key only in the environment. */
function jevProject(): { root: string; cleanup: () => void; env: Record<string, string> } {
  const dir = makeTempDir();
  const root = join(dir.path, "project");
  mkdirSync(join(root, ".korwf"), { recursive: true });
  writeFileSync(join(root, PROJECT_CONFIG_RELATIVE_PATH), JSON.stringify({ jev: { enabled: true } }));
  return { root, cleanup: dir.cleanup, env: { [DEFAULT_KEY_ENV_VAR]: FAKE_KEY } };
}

beforeEach(() => {
  clearRegisteredSecrets();
});

describe("AC1: the key is absent from every product output path", () => {
  it("the loaded config never contains the key, only the name of its source", () => {
    const p = jevProject();
    try {
      const result = loadConfig(p.root, { userConfigDir: null, env: p.env });
      expect(result.ok).toBe(true);
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(FAKE_KEY);
      expect(serialised).toContain(DEFAULT_KEY_ENV_VAR);
    } finally {
      p.cleanup();
    }
  });

  it("/korwf config output never contains the key", () => {
    const p = jevProject();
    try {
      resolveJevKey((loadConfig(p.root, { userConfigDir: null, env: p.env }) as { config: KorwfConfig }).config, { env: p.env });
      const message = configMessage(loadConfig(p.root, { userConfigDir: null, env: p.env }));
      expect(message).not.toContain(FAKE_KEY);
    } finally {
      p.cleanup();
    }
  });

  it("/korwf jev output reports the source, length and fingerprint but never the key", () => {
    const p = jevProject();
    try {
      const message = jevStatusMessage(loadConfig(p.root, { userConfigDir: null, env: p.env }), { env: p.env });
      expect(message).not.toContain(FAKE_KEY);
      expect(message).toContain("enabled");
      expect(message).toContain(DEFAULT_KEY_ENV_VAR);
      expect(message).toContain(`${FAKE_KEY.length} characters`);
    } finally {
      p.cleanup();
    }
  });

  it("the first-use disclosure text names the source, never the key", () => {
    const p = jevProject();
    try {
      const loaded = loadConfig(p.root, { userConfigDir: null, env: p.env }) as { config: KorwfConfig };
      resolveJevKey(loaded.config, { env: p.env });
      const text = buildDisclosure(loaded.config).lines.join("\n");
      expect(text).not.toContain(FAKE_KEY);
      expect(text).toContain(DEFAULT_KEY_ENV_VAR);
    } finally {
      p.cleanup();
    }
  });

  it("the extension UI boundary redacts anything a command tries to notify", () => {
    const p = jevProject();
    try {
      resolveJevKey((loadConfig(p.root, { userConfigDir: null, env: p.env }) as { config: KorwfConfig }).config, { env: p.env });
      const ui = recordingUi();
      // A careless caller inside the package: the boundary still holds.
      redactedUi(ui).notify(`about to call Jev with ${FAKE_KEY}`, "info");
      uiLogger(ui).error("request failed", { Authorization: `Bearer ${FAKE_KEY}` });
      expect(ui.messages.join("\n")).not.toContain(FAKE_KEY);
      expect(ui.messages.join("\n")).toContain(REDACTED);
    } finally {
      p.cleanup();
    }
  });

  it("an error thrown inside a command is redacted and never crashes the session", async () => {
    const p = jevProject();
    try {
      resolveJevKey((loadConfig(p.root, { userConfigDir: null, env: p.env }) as { config: KorwfConfig }).config, { env: p.env });
      const ui = recordingUi();
      const outcome = await guardHandler(ui, "/korwf jev", () => {
        throw new Error(`transport failed: Authorization: Bearer ${FAKE_KEY}`);
      });
      expect(outcome).toBeUndefined();
      expect(ui.messages).toHaveLength(1);
      expect(ui.messages[0]).not.toContain(FAKE_KEY);
      expect(ui.messages[0]).toContain("could not complete /korwf jev");
    } finally {
      p.cleanup();
    }
  });

  it("an artifact written to disk through redactedStringify contains no key", () => {
    const p = jevProject();
    try {
      resolveJevKey((loadConfig(p.root, { userConfigDir: null, env: p.env }) as { config: KorwfConfig }).config, { env: p.env });
      const file = join(p.root, "trace.json");
      writeFileSync(file, redactedStringify({ request: { headers: { authorization: `Bearer ${FAKE_KEY}` } }, env: p.env }, 2));
      const onDisk = readFileSync(file, "utf8");
      expect(onDisk).not.toContain(FAKE_KEY);
      expect(onDisk).toContain(REDACTED);
    } finally {
      p.cleanup();
    }
  });

  it("AC2: the same project with no key in the environment loads fine with Jev off", () => {
    const p = jevProject();
    try {
      const result = loadConfig(p.root, { userConfigDir: null, env: {} });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // #21's V9 downgrade and #22's resolver agree: disabled, warned, not an error.
      expect(result.config.jev.enabled).toBe(false);
      expect(result.warnings.some((w) => w.rule === "V9")).toBe(true);
      const resolution = resolveJevKey({ jev: { ...result.config.jev, enabled: true } }, { env: {} });
      expect(resolution.status).toBe("key_absent");
      expect(jevStatusMessage(result, { env: {} })).toContain("disabled");
    } finally {
      p.cleanup();
    }
  });

  it("a simulated crash dump of the whole session state contains no key", () => {
    const p = jevProject();
    try {
      const loaded = loadConfig(p.root, { userConfigDir: null, env: p.env }) as { config: KorwfConfig };
      const resolution = resolveJevKey(loaded.config, { env: p.env });
      const session = {
        config: loaded.config,
        resolution,
        secret: resolution.secret,
        env: p.env,
        lastError: new Error(`POST /v1/systemone: Bearer ${FAKE_KEY}`),
      };
      const dump = redactString(inspect(session, { depth: null }));
      expect(dump).not.toContain(FAKE_KEY);
    } finally {
      p.cleanup();
    }
  });
});
