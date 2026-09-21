/**
 * Helper process for `concurrent-open.test.ts` (issue #23).
 *
 * Opens the store in a *real* second process and prints one JSON line
 * describing the result, so the test can assert the denial a second
 * coordinator actually receives.
 *
 * Modes:
 *   --mode write   take the write lock (this is what must be denied)
 *   --mode read    open read-only (must succeed while the lock is held)
 *   --mode pid     print this process's pid and exit without opening
 */
import { openStore, openStoreReadOnly } from "../../../src/storage/db.ts";
import { StoreError } from "../../../src/storage/errors.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const root = arg("root");
const mode = arg("mode") ?? "write";
const timeout = Number(arg("timeout") ?? "1000");

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (root === undefined) {
  emit({ ok: false, message: "--root is required" });
  process.exit(2);
}

if (mode === "pid") {
  emit({ ok: true, pid: process.pid });
  process.exit(0);
}

try {
  if (mode === "read") {
    const store = openStoreReadOnly(root);
    emit({ ok: true, workflows: store.workflows.count() });
    store.close();
  } else {
    const { store, report } = openStore({ storageRoot: root, lockTimeoutMs: timeout });
    emit({ ok: true, pid: process.pid, lockKind: report.lock?.kind, workflows: store.workflows.count() });
    store.close();
  }
  process.exit(0);
} catch (error) {
  emit({
    ok: false,
    code: error instanceof StoreError ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
