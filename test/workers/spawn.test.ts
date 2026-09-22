/**
 * #68 AC1 (observed, not asserted on a builder) and ADR 0004 "Invocation
 * shape": launch a real subprocess standing in for `pi --mode rpc`, ask it
 * what argv and environment it actually received, and check those.
 *
 * No model call, no network, no key: `test/workers/fixtures/fake-pi.mjs` is a
 * Node script speaking the RPC subset `src/workers/spawn.ts` uses.
 */
import { spawn as spawnReal } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { draftToContract, type ContractPolicy } from "../../src/workers/contract.ts";
import {
  ContractRejectedError,
  buildWorkerArgv,
  composePrompt,
  spawnWorker,
  type WorkerHandle,
} from "../../src/workers/spawn.ts";
import { DEPTH_ENV_VAR } from "../../src/workers/env.ts";
import { DEFAULT_KEY_ENV_VAR } from "../../src/security/secrets.ts";
import type { ModelAllowlist, ModelRef } from "../../src/config/types.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const ALLOWED: ModelRef = "provider-a/model-one";
const allowlist: ModelAllowlist = { providers: [], models: [ALLOWED], pins: {} };
const policy: ContractPolicy = { allowlist };

const parentEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  [DEFAULT_KEY_ENV_VAR]: "value-not-a-real-key",
  KORWF_TEST_ONLY_SECRET: "value-not-a-real-key",
};

const live: WorkerHandle[] = [];

function contract(overrides: Record<string, unknown> = {}) {
  return draftToContract({
    workerId: "t1",
    role: "scout",
    task: "list what exists",
    cwd: process.cwd(),
    model: ALLOWED,
    ...overrides,
  });
}

/** Spawn the fake Pi through the real `spawnWorker` path. */
async function start(overrides: Record<string, unknown> = {}): Promise<WorkerHandle> {
  const handle = await spawnWorker(contract(overrides), {
    policy,
    piBin: process.execPath,
    parentEnv,
    // `process.execPath <script>` is how the fixture is run; the argv the code
    // built is passed through untouched after the script path.
    spawnFn: ((bin: string, args: readonly string[], opts: Record<string, unknown>) =>
      spawnReal(bin, [FAKE_PI, ...args], opts)) as never,
  });
  live.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of live.splice(0)) {
    if (handle.exit === undefined) await handle.cancel("test cleanup");
  }
});

async function state(handle: WorkerHandle): Promise<{ argv: string[]; env: Record<string, string> }> {
  const response = await handle.call({ type: "get_state" }, 15_000);
  return response.data as { argv: string[]; env: Record<string, string> };
}

describe("AC1 (observed): the spawned process receives no credentials", () => {
  it("has no key variable in the environment it actually got", async () => {
    const { env } = await state(await start());
    expect(env[DEFAULT_KEY_ENV_VAR]).toBeUndefined();
    expect(env.KORWF_TEST_ONLY_SECRET).toBeUndefined();
    expect(Object.values(env)).not.toContain("value-not-a-real-key");
  });

  it("carries the depth marker the extension reads", async () => {
    const { env } = await state(await start());
    expect(env[DEPTH_ENV_VAR]).toBe("1");
    expect(env.KORWF_WORKER).toBe("1");
    expect(env.KORWF_WORKER_ROLE).toBe("scout");
  });
});

describe("ADR 0004 invocation shape", () => {
  it("always isolates resources, whatever the contract asks for", async () => {
    const { argv } = await state(await start());
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-prompt-templates");
    expect(argv).toContain("--no-context-files");
    expect(argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
  });

  it("passes the role tool allowlist and the split provider/model", async () => {
    const { argv } = await state(await start());
    const tools = argv[argv.indexOf("--tools") + 1];
    expect(tools).toBe("read,grep,find,ls");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("provider-a");
    expect(argv[argv.indexOf("--model") + 1]).toBe("model-one");
  });

  it("keeps --no-extensions even when a role extension is explicitly permitted", () => {
    const argv = buildWorkerArgv(contract({ inheritance: { extensions: ["/x/role.ts"] } }));
    expect(argv).toContain("--no-extensions");
    expect(argv[argv.indexOf("-e") + 1]).toBe("/x/role.ts");
    expect(argv.indexOf("--no-extensions")).toBeLessThan(argv.indexOf("-e"));
  });

  it("never puts the task text on the command line", async () => {
    const secretTask = "SENSITIVE-TASK-TEXT-SHOULD-NOT-BE-IN-ARGV";
    const { argv } = await state(await start({ task: secretTask }));
    expect(argv.join(" ")).not.toContain(secretTask);
    expect(composePrompt(contract({ task: secretTask }))).toContain(secretTask);
  });

  it("sends the role contract with the task in the prompt", async () => {
    const handle = await start();
    const response = await handle.call(
      { type: "prompt", message: composePrompt(handle.contract) },
      15_000,
    );
    const prompt = String((response.data as { prompt: string }).prompt);
    expect(prompt).toContain("Role: scout");
    expect(prompt.toLowerCase()).toContain("create each file with a short write");
    expect(prompt).toContain("list what exists");
    expect(prompt).toContain("You may not start other agents.");
  });

  it("accumulates usage from the streamed responses", async () => {
    const handle = await start();
    await handle.call({ type: "prompt", message: "hi" }, 15_000);
    expect(handle.usage.inputTokens).toBe(7);
    expect(handle.usage.outputTokens).toBe(11);
    expect(handle.usage.requests).toBe(1);
  });
});

describe("AC3 (at the spawn point): policy is enforced before a process exists", () => {
  it("throws ContractRejectedError and spawns nothing for a model outside the allowlist", async () => {
    let spawnCalls = 0;
    await expect(
      spawnWorker(contract({ model: "provider-b/model-two" as ModelRef }), {
        policy,
        parentEnv,
        spawnFn: (() => {
          spawnCalls += 1;
          throw new Error("must not be reached");
        }) as never,
      }),
    ).rejects.toBeInstanceOf(ContractRejectedError);
    expect(spawnCalls).toBe(0);
  });
});
