/**
 * Helper process for `lifecycle-cleanup.test.ts` (issue #32).
 *
 * Opens the KorWF store in a *real* second process, takes the write lock,
 * prints one JSON line saying so, and then waits to be killed. The parent
 * test SIGKILLs it, which is the only way to leave a lockfile behind with no
 * chance for `store.close()` or any exit hook to run — exactly the situation
 * "the lock is recovered after a crash" has to survive.
 *
 * Modes:
 *   --mode hold   take the lock, announce, wait forever (to be SIGKILLed)
 *   --mode open   take the lock, announce, release cleanly, exit 0
 */
import { openStore } from "../../../src/storage/db.ts";
import { StoreError } from "../../../src/storage/errors.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const root = arg("root");
const mode = arg("mode") ?? "hold";

if (root === undefined) {
  emit({ ok: false, message: "--root is required" });
  process.exit(2);
}

try {
  const { store, report } = openStore({ storageRoot: root, lockTimeoutMs: 500 });
  emit({ ok: true, pid: process.pid, lockKind: report.lock?.kind ?? null, ready: true });
  if (mode === "open") {
    store.close();
    process.exit(0);
  }
  // Hold the lock until killed. A bare interval keeps the loop alive without
  // burning CPU; nothing here ever resolves.
  setInterval(() => {}, 1_000);
} catch (error) {
  emit({
    ok: false,
    code: error instanceof StoreError ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
