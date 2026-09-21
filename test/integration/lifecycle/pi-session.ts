/**
 * Isolated Pi session harness for the Stage 2 exit criterion (issue #32).
 *
 * Every test in this directory needs the same thing: a Pi process that knows
 * nothing about the developer's machine — its own config directory, its own
 * HOME, its own project directory, and an environment built from scratch
 * rather than inherited — with this package installed from the local path.
 *
 * Pi is driven over its RPC mode (`--mode rpc`, see Pi `docs/rpc.md`): one
 * JSON command per line on stdin, one JSON event per line on stdout. An
 * extension's `ctx.ui.notify()` surfaces as an `extension_ui_request` event
 * with `method: "notify"`, which is how these tests read what `/korwf` said
 * without a terminal.
 *
 * Nothing here touches the network: `PI_OFFLINE=1` disables Pi's startup
 * network operations and no model is ever prompted — only extension
 * commands, which execute locally in the extension process.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root (the package installed under test). */
export const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");

/**
 * Pi's CLI entry point from the dev dependency. Executed with
 * `process.execPath` rather than via its shebang so the test runs under the
 * same Node as the suite (CI pins Node 22.13; `docs/platform-support.md`).
 */
export const PI_CLI = join(
  PACKAGE_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

/** True when the Pi CLI is installed, so tests can skip rather than fail. */
export function piCliAvailable(): boolean {
  return existsSync(PI_CLI);
}

/** A throwaway Pi installation: its own config dir, HOME and project tree. */
export interface IsolatedPi {
  /** Root temp dir; everything below lives inside it. */
  readonly root: string;
  /** `PI_CODING_AGENT_DIR` for the session. */
  readonly configDir: string;
  /** `HOME` for the session. */
  readonly home: string;
  /** The project directory the session runs in (`ctx.cwd`). */
  readonly project: string;
  readonly cleanup: () => void;
}

/** Create the isolated layout. Caller must `cleanup()`. */
export function makeIsolatedPi(prefix = "korwf-lifecycle-"): IsolatedPi {
  const dir: TempDir = makeTempDir(prefix);
  const configDir = join(dir.path, "pi-config");
  const home = join(dir.path, "home");
  const project = join(dir.path, "project");
  for (const path of [configDir, home, project]) mkdirSync(path, { recursive: true });
  return { root: dir.path, configDir, home, project, cleanup: dir.cleanup };
}

/**
 * Credential-shaped variables that must never leak into an isolated session.
 * The no-key test asserts the absence of the first two by name; the provider
 * keys are dropped so a stray one cannot make a model call possible.
 */
export const CREDENTIAL_ENV_VARS: readonly string[] = [
  "TYPESAFE_API_KEY",
  "JEV_API_KEY", // check-secrets:allow — a variable *name*, never a value
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
];

/**
 * Build the session environment from scratch rather than inheriting one.
 *
 * `PATH` is kept because Pi and Node need it; everything else is chosen here,
 * so no developer-specific variable (a real key, a proxy URL, a provider
 * name) can influence the result. `extra` adds variables a specific test
 * needs — the no-key test adds none, which is the point.
 */
export function sessionEnv(
  pi: IsolatedPi,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: pi.home,
    TMPDIR: pi.root,
    // Isolation: Pi's config, packages and sessions all live under the temp dir.
    PI_CODING_AGENT_DIR: pi.configDir,
    PI_CODING_AGENT_SESSION_DIR: join(pi.root, "sessions"),
    // No startup network operations: no update check, no telemetry (docs/environment-variables.md).
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    NO_COLOR: "1",
    ...extra,
  };
  for (const name of CREDENTIAL_ENV_VARS) delete env[name];
  return env;
}

/** Result of one Pi invocation. */
export interface PiRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Every parsed JSON line from stdout, in order. */
  readonly events: readonly PiEvent[];
  /** Concatenated text of every `notify` the extension emitted. */
  readonly transcript: string;
  /** Wall-clock duration, for "a failure must not hang Pi". */
  readonly elapsedMs: number;
}

export interface PiEvent {
  readonly type?: string;
  readonly method?: string;
  readonly message?: string;
  readonly success?: boolean;
  readonly command?: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}

function parseEvents(stdout: string): PiEvent[] {
  const events: PiEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      // Not a protocol line (a warning, a stray write): ignored deliberately,
      // but still visible to assertions through `stdout`.
    }
  }
  return events;
}

/** Text of every extension notification, which is what `/korwf` "printed". */
function transcriptOf(events: readonly PiEvent[]): string {
  return events
    .filter((e) => e.type === "extension_ui_request" && e.method === "notify")
    .map((e) => String(e.message ?? ""))
    .join("\n");
}

export interface RunPiOptions {
  /** Extra environment for this run only (e.g. a fake key, a stub base URL). */
  readonly env?: Readonly<Record<string, string>>;
  /** Hard kill after this long. A hang is a test failure, not a stuck suite. */
  readonly timeoutMs?: number;
  /** Working directory; defaults to the isolated project dir. */
  readonly cwd?: string;
}

/** Run the Pi CLI with arbitrary arguments and no stdin input. */
export function runPiCli(pi: IsolatedPi, args: readonly string[], options: RunPiOptions = {}): PiRun {
  return runPi(pi, args, "", options);
}

/**
 * Send `/korwf ...` commands to a fresh Pi session over RPC and return the
 * transcript. Each command is one `prompt` line; extension commands execute
 * immediately and never reach a model (Pi `docs/rpc.md`, "Extension
 * commands").
 */
export function runKorwf(
  pi: IsolatedPi,
  commands: readonly string[],
  options: RunPiOptions = {},
): PiRun {
  const input = commands
    .map((message, index) => JSON.stringify({ id: `req-${String(index + 1)}`, type: "prompt", message }))
    .join("\n");
  return runPi(pi, ["--mode", "rpc", "--no-session"], `${input}\n`, options);
}

function runPi(pi: IsolatedPi, args: readonly string[], input: string, options: RunPiOptions): PiRun {
  const startedAt = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [PI_CLI, ...args], {
    cwd: options.cwd ?? pi.project,
    env: sessionEnv(pi, options.env ?? {}),
    input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const events = parseEvents(stdout);
  return {
    status: result.status,
    signal: result.signal,
    stdout,
    stderr: result.stderr ?? "",
    events,
    transcript: transcriptOf(events),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Install this package into the isolated config dir from its local path.
 * `pi install <absolute path>` records the path in the isolated
 * `settings.json`; nothing is copied and nothing outside the temp dir is
 * written (Pi `docs/packages.md`, "Local Paths").
 */
export function installPackage(pi: IsolatedPi): PiRun {
  return runPiCli(pi, ["install", PACKAGE_ROOT], { timeoutMs: 120_000 });
}
