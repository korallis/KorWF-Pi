/**
 * `/korwf models pin <model> [--task <kind>|--phase]` and `unpin` (issue #61;
 * PLAN §3.D "user pins are not overridden by fallback without asking").
 *
 * Pins are persisted to the project config file
 * (`PROJECT_CONFIG_RELATIVE_PATH`, `.korwf/config.json`) under
 * `models.allowlist.pins[<kind>]` — the config layer `selectModel`'s caller
 * already reads via `resolvePin`. This module never talks to the store or
 * Jev; it only reads/writes that one JSON file, validating the result
 * against the schema before it is saved so a pin can never write an invalid
 * config (e.g. a model outside the allowlist — V9 catches that on next load
 * and downgrades to a warning, but this command rejects it outright instead
 * of writing something that would immediately misbehave).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_CONFIG_RELATIVE_PATH } from "../../config/defaults.ts";
import { TASK_KINDS, type ModelRef, type TaskKind } from "../../config/types.ts";
import { loadConfig } from "../../config/load.ts";

export interface PinCommandResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface ParsedPinArgs {
  readonly ok: true;
  readonly model: ModelRef;
  readonly taskKind: TaskKind;
}

export interface PinArgsError {
  readonly ok: false;
  readonly message: string;
}

/** Parse `/korwf models pin <model> [--task <kind>]`. Defaults to `default`. */
export function parsePinArgs(argv: readonly string[]): ParsedPinArgs | PinArgsError {
  const positional: string[] = [];
  let taskKind: TaskKind = "default";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--task") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || !(TASK_KINDS as readonly string[]).includes(value)) {
        return { ok: false, message: `--task must be one of: ${TASK_KINDS.join(", ")}` };
      }
      taskKind = value as TaskKind;
    } else if (arg !== undefined && arg !== "") {
      positional.push(arg);
    }
  }
  const model = positional[0];
  if (model === undefined || !model.includes("/")) {
    return { ok: false, message: "Usage: /korwf models pin <provider/model> [--task <kind>]" };
  }
  return { ok: true, model: model as ModelRef, taskKind };
}

/** Parse `/korwf models unpin [--task <kind>]`. Defaults to `default`. */
export function parseUnpinArgs(argv: readonly string[]): { readonly taskKind: TaskKind } | PinArgsError {
  let taskKind: TaskKind = "default";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--task") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || !(TASK_KINDS as readonly string[]).includes(value)) {
        return { ok: false, message: `--task must be one of: ${TASK_KINDS.join(", ")}` };
      }
      taskKind = value as TaskKind;
    }
  }
  return { taskKind };
}

function readProjectConfigRaw(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeProjectConfigRaw(configPath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function projectConfigPath(projectRoot: string): string {
  return resolve(join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH));
}

/**
 * Set `models.allowlist.pins[taskKind] = model` in the project config, then
 * reload with the new pin in place and require it to still validate — a pin
 * outside the allowlist (V9) is rejected here rather than silently written.
 */
export function pinModel(projectRoot: string, model: ModelRef, taskKind: TaskKind): PinCommandResult {
  const configPath = projectConfigPath(projectRoot);
  const raw = readProjectConfigRaw(configPath);
  const models = (raw["models"] as Record<string, unknown> | undefined) ?? {};
  const allowlist = (models["allowlist"] as Record<string, unknown> | undefined) ?? {};
  const pins = (allowlist["pins"] as Record<string, unknown> | undefined) ?? {};
  const next = {
    ...raw,
    models: { ...models, allowlist: { ...allowlist, pins: { ...pins, [taskKind]: model } } },
  };

  const check = loadConfig(projectRoot, { readFile: (p) => (p === configPath ? JSON.stringify(next) : readFileWithFallback(p)) });
  if (!check.ok) {
    return { ok: false, message: `Cannot pin ${model} for "${taskKind}": ${check.message}` };
  }

  writeProjectConfigRaw(configPath, next);
  return { ok: true, message: `Pinned ${model} for task kind "${taskKind}". Fallback from this pin will always ask first.` };
}

/** Remove `models.allowlist.pins[taskKind]` from the project config, if present. */
export function unpinModel(projectRoot: string, taskKind: TaskKind): PinCommandResult {
  const configPath = projectConfigPath(projectRoot);
  const raw = readProjectConfigRaw(configPath);
  const models = raw["models"] as Record<string, unknown> | undefined;
  const allowlist = models?.["allowlist"] as Record<string, unknown> | undefined;
  const pins = allowlist?.["pins"] as Record<string, unknown> | undefined;
  if (pins === undefined || !(taskKind in pins)) {
    return { ok: true, message: `No pin set for task kind "${taskKind}".` };
  }
  const { [taskKind]: _removed, ...restPins } = pins;
  const next = { ...raw, models: { ...models, allowlist: { ...allowlist, pins: restPins } } };
  writeProjectConfigRaw(configPath, next);
  return { ok: true, message: `Unpinned task kind "${taskKind}".` };
}

function readFileWithFallback(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
