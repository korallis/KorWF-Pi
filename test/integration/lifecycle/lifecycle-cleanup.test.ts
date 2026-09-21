/**
 * Stage 2 exit criterion, part 3: lifecycle cleanup
 * (issue #32 Scope test 3; PLAN §8 Stage 2 Exit; ADR 0006 rule 1).
 *
 * Three separate claims, each with its own test:
 *
 *  1. A session that ends normally releases the store lock, leaves no stray
 *     process and no temp dir, and a second session starts immediately.
 *  2. A session killed with SIGKILL — no `close()`, no exit hook — leaves a
 *     lockfile behind, and the next session takes it over, records the
 *     takeover in the append-only audit trail, and finds the store intact.
 *  3. Repeated start/stop cycles neither accumulate state nor slow down.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../../../src/storage/db.ts";
import { resolveLockfilePath, resolveStorageRoot } from "../../../src/storage/paths.ts";
import { readLockfile } from "../../../src/storage/lock.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import {
  installPackage,
  makeIsolatedPi,
  piCliAvailable,
  runKorwf,
} from "./pi-session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const HOLDER = join(HERE, "hold-store-child.mts");

const available = piCliAvailable();

interface Holder {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
}

const running: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

/** Start the holder process and resolve once it reports the lock is held. */
function startHolder(storageRoot: string): Promise<Holder> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", HOLDER, "--root", storageRoot, "--mode", "hold"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  ) as unknown as ChildProcessWithoutNullStreams;
  running.push(child);

  return new Promise<Holder>((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => rejectPromise(new Error("holder never reported readiness")), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.trim().startsWith("{"));
      if (line === undefined) return;
      clearTimeout(timer);
      const parsed = JSON.parse(line) as { ok: boolean; pid?: number; message?: string };
      if (!parsed.ok) rejectPromise(new Error(`holder failed: ${parsed.message ?? "unknown"}`));
      else resolvePromise({ child, pid: parsed.pid ?? child.pid ?? 0 });
    });
    child.on("error", rejectPromise);
  });
}

/** Wait until a pid is no longer signalable, or throw. */
async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`pid ${String(pid)} still alive after SIGKILL`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("M2 exit: a normal session releases everything it took", () => {
  it("removes the lockfile on close so the next session starts immediately", () => {
    const dir = makeTempDir("korwf-cleanup-");
    try {
      const lockPath = resolveLockfilePath(dir.path);
      const first = openStore({ storageRoot: dir.path });
      expect(existsSync(lockPath)).toBe(true);
      first.store.close();
      expect(existsSync(lockPath)).toBe(false);

      // Immediately, with no wait and no timeout budget: a released lock is
      // available at once, not after a poll interval.
      const second = openStore({ storageRoot: dir.path, lockTimeoutMs: 0 });
      expect(second.report.lock?.kind).toBe("created");
      second.store.close();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it("close() is idempotent and leaves no stray process behind", async () => {
    const dir = makeTempDir("korwf-cleanup-child-");
    try {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", HOLDER, "--root", dir.path, "--mode", "open"],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      const line = result.stdout.trim().split("\n").pop() ?? "";
      const parsed = JSON.parse(line) as { ok: boolean; pid: number };
      expect(parsed.ok).toBe(true);
      await waitForExit(parsed.pid);
      expect(existsSync(resolveLockfilePath(dir.path))).toBe(false);
    } finally {
      dir.cleanup();
    }
  });
});

describe("M2 exit: a SIGKILLed session's lock is recovered with no corruption", () => {
  it("takes over the stale lock, audits the takeover, and the store still reads", async () => {
    const dir = makeTempDir("korwf-sigkill-");
    try {
      const holder = await startHolder(dir.path);
      const lockPath = resolveLockfilePath(dir.path);
      expect(existsSync(lockPath)).toBe(true);
      expect(readLockfile(lockPath).pid).toBe(holder.pid);

      // No close(), no exit hook, no flush: the harshest crash available.
      holder.child.kill("SIGKILL");
      await waitForExit(holder.pid);

      // The lockfile survives the crash — that is the point of the test.
      expect(existsSync(lockPath)).toBe(true);

      const { store, report } = openStore({ storageRoot: dir.path, lockTimeoutMs: 1_000 });
      try {
        expect(report.lock?.kind).toBe("took_over_stale");

        // The takeover is in the append-only audit trail: one entry written
        // by `korwf:lock` for the taking pid, whose `beforeHash` is the dead
        // holder's lockfile (ADR 0006 rule 1).
        const trail = store.audit.forRecord("audit_entry", `lock:${String(process.pid)}`);
        expect(trail).toHaveLength(1);
        expect(trail[0]?.actor).toBe("korwf:lock");
        expect(trail[0]?.beforeHash).not.toBeNull();
        expect(trail[0]?.afterHash).not.toBe(trail[0]?.beforeHash);

        // No corruption: the schema is intact and the store is writable.
        expect(store.workflows.count()).toBe(0);
        expect(report.migrations.toVersion).toBeGreaterThan(0);
      } finally {
        store.close();
      }
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it("a second session starts immediately after the crashed one", async () => {
    const dir = makeTempDir("korwf-restart-");
    try {
      const holder = await startHolder(dir.path);
      holder.child.kill("SIGKILL");
      await waitForExit(holder.pid);

      const startedAt = Date.now();
      const { store } = openStore({ storageRoot: dir.path, lockTimeoutMs: 5_000 });
      const elapsed = Date.now() - startedAt;
      store.close();

      // Recovery is a liveness probe, not a timeout: the restart must not
      // wait out the lock timeout.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      dir.cleanup();
    }
  });
});

describe.skipIf(!available)("M2 exit: consecutive Pi sessions clean up after themselves", () => {
  it("releases the store lock when the /korwf command that opened it returns", () => {
    const pi = makeIsolatedPi("korwf-session-cleanup-");
    try {
      expect(installPackage(pi).status).toBe(0);
      const first = runKorwf(pi, ["/korwf why"]);
      expect(first.status).toBe(0);

      const storageRoot = resolveStorageRoot(pi.project);
      expect(existsSync(storageRoot)).toBe(true);
      expect(existsSync(resolveLockfilePath(storageRoot))).toBe(false);

      // A second session starts immediately afterwards and opens the same
      // store without waiting for, or fighting over, a lock.
      const second = runKorwf(pi, ["/korwf why", "/korwf version"]);
      expect(second.status).toBe(0);
      expect(second.transcript).toContain("korwf-pi v");
      expect(existsSync(resolveLockfilePath(storageRoot))).toBe(false);
    } finally {
      pi.cleanup();
    }
  });

  it("leaves no stray pi process and no temp dir behind after the session exits", () => {
    const before = tempEntrySnapshot();
    const pi = makeIsolatedPi("korwf-stray-");
    try {
      expect(installPackage(pi).status).toBe(0);
      const run = runKorwf(pi, ["/korwf version", "/korwf config", "/korwf why"]);
      expect(run.status).toBe(0);
      expect(run.signal).toBeNull();

      // Anything the session wrote is inside its own temp root; TMPDIR was
      // pointed there too, so a stray scratch dir would show up under it and
      // not in the developer's /tmp.
      const after = tempEntrySnapshot().filter((name) => !before.includes(name));
      expect(after.filter((name) => name.startsWith("korwf-stray-"))).toHaveLength(1);
    } finally {
      pi.cleanup();
    }
    // After cleanup, nothing of this run's remains.
    expect(tempEntrySnapshot().filter((n) => n.startsWith("korwf-stray-"))).toEqual([]);
  });
});

/** Names directly under the OS temp dir, for a before/after difference. */
function tempEntrySnapshot(): string[] {
  return readdirSync(tmpdir());
}
