/**
 * Temp-dir fixture for tests (issue #20 Scope).
 *
 * Creates a unique directory under the OS temp dir and guarantees cleanup,
 * even if the test throws. Never touches the user's project tree.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDir {
  /** Absolute path to the created directory. */
  path: string;
  /** Remove the directory and everything in it. Safe to call more than once. */
  cleanup: () => void;
}

/** Create a fresh temp directory prefixed for easy identification in `/tmp`. */
export function makeTempDir(prefix = "korwf-test-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  let cleaned = false;
  return {
    path,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * Run `fn` with a fresh temp dir, cleaning up afterwards regardless of
 * success or failure. Returns `fn`'s return value.
 */
export async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const { path, cleanup } = makeTempDir();
  try {
    return await fn(path);
  } finally {
    cleanup();
  }
}
