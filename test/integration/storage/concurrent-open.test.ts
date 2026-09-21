/**
 * Concurrent-open integration test (issue #23).
 *
 * AC: "Second process opening the store while lock is held gets a clear
 * read-only/denied result; stale lock is taken over."
 *
 * This is deliberately an *integration* test with real child processes: the
 * author's own single-session environment cannot reproduce a second
 * coordinator, and AGENTS.md §4 says that is exactly when the test must be
 * written (`node:sqlite` locking, pid liveness, and `O_EXCL` all behave
 * differently in-process).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { openStore } from "../../../src/storage/db.ts";
import { StoreLockedError } from "../../../src/storage/errors.ts";
import { resolveLockfilePath } from "../../../src/storage/paths.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import { makeWorkflow } from "../../helpers/records.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const HELPER = join(HERE, "open-store-child.mts");

interface ChildResult {
  ok: boolean;
  code?: string;
  message?: string;
  pid?: number;
  workflows?: number;
  lockKind?: string;
}

/** Run the helper in a real second process and parse its single JSON line. */
function runChild(args: readonly string[]): ChildResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", HELPER, ...args],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const line = result.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as ChildResult;
  } catch {
    throw new Error(`child produced no JSON result.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

describe("AC: a second process is denied while the lock is held", () => {
  it("fails with KORWF_STORE_LOCKED naming the holder pid", () => {
    const dir = makeTempDir("korwf-concurrent-");
    try {
      const { store } = openStore({ storageRoot: dir.path });
      store.workflows.insert(makeWorkflow());

      const child = runChild(["--root", dir.path, "--mode", "write", "--timeout", "100"]);
      expect(child.ok).toBe(false);
      expect(child.code).toBe("KORWF_STORE_LOCKED");
      expect(child.message).toContain(String(process.pid));

      store.close();
    } finally {
      dir.cleanup();
    }
  });

  it("lets the second process read the store read-only while the lock is held", () => {
    const dir = makeTempDir("korwf-ro-");
    try {
      const { store } = openStore({ storageRoot: dir.path });
      store.workflows.insert(makeWorkflow());

      const child = runChild(["--root", dir.path, "--mode", "read"]);
      expect(child.ok).toBe(true);
      expect(child.workflows).toBe(1);

      store.close();
    } finally {
      dir.cleanup();
    }
  });

  it("lets the second process take the lock once the first releases it", () => {
    const dir = makeTempDir("korwf-handover-");
    try {
      const first = openStore({ storageRoot: dir.path });
      first.store.close();

      const child = runChild(["--root", dir.path, "--mode", "write", "--timeout", "100"]);
      expect(child.ok).toBe(true);
      expect(child.lockKind).toBe("created");
    } finally {
      dir.cleanup();
    }
  });
});

describe("AC: a stale lock is taken over", () => {
  it("takes over a lockfile left behind by a dead process", () => {
    const dir = makeTempDir("korwf-stale-");
    try {
      // A pid that cannot be running: the child's own pid is long gone.
      const dead = runChild(["--root", dir.path, "--mode", "pid"]);
      expect(dead.ok).toBe(true);
      writeFileSync(
        resolveLockfilePath(dir.path),
        JSON.stringify({ pid: dead.pid, startedAt: "2020-01-01T00:00:00.000Z", hostHash: "", packageVersion: "" }),
      );

      const { store, report } = openStore({ storageRoot: dir.path, lockTimeoutMs: 100 });
      expect(report.lock?.kind).toBe("took_over_stale");
      // The takeover is auditable (ADR 0006 rule 1).
      const trail = store.audit.forRecord("audit_entry", `lock:${process.pid}`);
      expect(trail).toHaveLength(1);
      expect(trail[0]?.actor).toBe("korwf:lock");
      store.close();
    } finally {
      dir.cleanup();
    }
  });

  it("surfaces StoreLockedError from openStore when the holder is alive", () => {
    const dir = makeTempDir("korwf-alive-");
    try {
      const first = openStore({ storageRoot: dir.path });
      expect(() => openStore({ storageRoot: dir.path, lockTimeoutMs: 0 })).toThrow(StoreLockedError);
      first.store.close();
    } finally {
      dir.cleanup();
    }
  });
});

describe("two writers never corrupt the store", () => {
  it("the denied process wrote nothing", () => {
    const dir = makeTempDir("korwf-nowrite-");
    try {
      const { store } = openStore({ storageRoot: dir.path });
      store.workflows.insert(makeWorkflow());
      runChild(["--root", dir.path, "--mode", "write", "--timeout", "50"]);
      expect(store.workflows.count()).toBe(1);
      store.close();

      // Reopening finds exactly what the single writer wrote.
      const reopened = openStore({ storageRoot: dir.path });
      expect(reopened.store.workflows.count()).toBe(1);
      reopened.store.close();
    } finally {
      dir.cleanup();
    }
  });
});
