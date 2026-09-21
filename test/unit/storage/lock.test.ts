/**
 * Lockfile tests (issue #23; ADR 0006 rule 1).
 *
 * AC: "Second process opening the store while lock is held gets a clear
 * read-only/denied result; stale lock is taken over."
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { acquireLock, hashHost, readLockfile } from "../../../src/storage/lock.ts";
import { LockfileCorruptError, StoreLockedError } from "../../../src/storage/errors.ts";
import { resolveLockfilePath } from "../../../src/storage/paths.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";

function fixture() {
  const dir = makeTempDir("korwf-lock-");
  return { dir, path: resolveLockfilePath(dir.path) };
}

describe("acquireLock writes pid and start time (ADR 0006 rule 1)", () => {
  it("creates the lockfile with pid, startedAt, hostHash and packageVersion", () => {
    const { dir, path } = fixture();
    try {
      const handle = acquireLock(path, { pid: 4242, packageVersion: "9.9.9", now: () => "2026-01-01T00:00:00.000Z" });
      expect(handle.kind).toBe("created");
      const contents = readLockfile(path);
      expect(contents.pid).toBe(4242);
      expect(contents.startedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(contents.packageVersion).toBe("9.9.9");
      expect(contents.hostHash).toMatch(/^[0-9a-f]{16}$/);
      handle.release();
      expect(existsSync(path)).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it("never writes the hostname itself (threat model: the lockfile is in the user's repo)", () => {
    const { dir, path } = fixture();
    try {
      const handle = acquireLock(path, { pid: 1 });
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toContain(hostname());
      expect(hashHost("example-host")).not.toContain("example-host");
      handle.release();
    } finally {
      dir.cleanup();
    }
  });
});

describe("AC: a second process gets a clear denial while a live lock is held", () => {
  it("throws StoreLockedError naming the holder's pid after the timeout", () => {
    const { dir, path } = fixture();
    try {
      const first = acquireLock(path, { pid: 111, isProcessAlive: () => true });
      let slept = 0;
      expect(() =>
        acquireLock(path, {
          pid: 222,
          isProcessAlive: () => true,
          timeoutMs: 200,
          pollIntervalMs: 50,
          sleep: (ms) => {
            slept += ms;
          },
        }),
      ).toThrowError(StoreLockedError);
      expect(slept).toBe(200);
      // The message must name the holder so the user can act on it.
      try {
        acquireLock(path, { pid: 222, isProcessAlive: () => true, timeoutMs: 0 });
      } catch (error) {
        expect((error as StoreLockedError).holderPid).toBe(111);
        expect((error as Error).message).toContain("111");
        expect((error as StoreLockedError).code).toBe("KORWF_STORE_LOCKED");
      }
      // The first holder's lock is untouched.
      expect(readLockfile(path).pid).toBe(111);
      first.release();
    } finally {
      dir.cleanup();
    }
  });

  it("acquires the lock when the holder releases it during the wait", () => {
    const { dir, path } = fixture();
    try {
      const first = acquireLock(path, { pid: 111, isProcessAlive: () => true });
      let polls = 0;
      const handle = acquireLock(path, {
        pid: 222,
        isProcessAlive: () => true,
        timeoutMs: 1000,
        pollIntervalMs: 10,
        sleep: () => {
          polls += 1;
          if (polls === 2) first.release();
        },
      });
      expect(handle.kind).toBe("created");
      expect(readLockfile(path).pid).toBe(222);
      handle.release();
    } finally {
      dir.cleanup();
    }
  });
});

describe("AC: a stale lock is taken over", () => {
  it("takes over a lockfile whose pid is dead and reports the previous holder", () => {
    const { dir, path } = fixture();
    try {
      acquireLock(path, { pid: 999, isProcessAlive: () => true, now: () => "2020-01-01T00:00:00.000Z" });
      const handle = acquireLock(path, { pid: 555, isProcessAlive: (pid) => pid !== 999 });
      expect(handle.kind).toBe("took_over_stale");
      expect(handle.previousHolder?.pid).toBe(999);
      expect(readLockfile(path).pid).toBe(555);
      handle.release();
    } finally {
      dir.cleanup();
    }
  });

  it("treats an unreadable lockfile left by a crash as stale", () => {
    const { dir, path } = fixture();
    try {
      writeFileSync(path, "{ this is not json");
      expect(() => readLockfile(path)).toThrow(LockfileCorruptError);
      const handle = acquireLock(path, { pid: 7, isProcessAlive: () => true });
      expect(handle.kind).toBe("took_over_stale");
      expect(handle.previousHolder).toBeNull();
      handle.release();
    } finally {
      dir.cleanup();
    }
  });

  it("release() does not delete a lock another process has since taken over", () => {
    const { dir, path } = fixture();
    try {
      const first = acquireLock(path, { pid: 111, isProcessAlive: () => true });
      const second = acquireLock(path, { pid: 222, isProcessAlive: (pid) => pid !== 111 });
      first.release();
      // Second's lock survives first's shutdown.
      expect(existsSync(path)).toBe(true);
      expect(readLockfile(path).pid).toBe(222);
      second.release();
      expect(existsSync(path)).toBe(false);
    } finally {
      dir.cleanup();
    }
  });
});

describe("readLockfile validation", () => {
  it("rejects a lockfile with no integer pid", () => {
    const { dir, path } = fixture();
    try {
      writeFileSync(path, JSON.stringify({ startedAt: "2026-01-01T00:00:00.000Z" }));
      expect(() => readLockfile(path)).toThrow(/pid/);
    } finally {
      dir.cleanup();
    }
  });

  it("rejects a lockfile with no startedAt", () => {
    const { dir, path } = fixture();
    try {
      writeFileSync(path, JSON.stringify({ pid: 5 }));
      expect(() => readLockfile(path)).toThrow(/startedAt/);
    } finally {
      dir.cleanup();
    }
  });
});
