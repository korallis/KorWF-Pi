/**
 * Coordinator lock (issue #77; PLAN §5, §8 Stage 6; ADR 0006 rule 1).
 *
 * Test names reference the acceptance criterion they exercise:
 * - AC1 "Two concurrent `run` invocations: exactly one proceeds";
 * - AC2 "Killed coordinator → next `run` takes over after staleness window
 *   (fake clock)".
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  acquireCoordinatorLock,
  CoordinatorActiveError,
  COORDINATOR_LOCK_ACTOR,
  inspectCoordinator,
} from "../../../src/workflow/coordinator.ts";
import { classifyHolder } from "../../../src/storage/lock.ts";
import { resolveCoordinatorLockPath, resolveLockfilePath } from "../../../src/storage/paths.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";

const dirs: TempDir[] = [];

afterEach(() => {
  while (dirs.length > 0) dirs.pop()?.cleanup();
});

function tempRoot(): string {
  const dir = makeTempDir("korwf-coordinator-");
  dirs.push(dir);
  return dir.path;
}

/** A clock the test drives by hand (the issue asks for a fake clock). */
function fakeClock(startMs = Date.parse("2026-03-01T00:00:00.000Z")) {
  let ms = startMs;
  return {
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
    advance: (by: number) => {
      ms += by;
    },
  };
}
