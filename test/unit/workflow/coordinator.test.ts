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

describe("AC1: two concurrent run invocations — exactly one proceeds", () => {
  it("refuses the second coordinator while the first process is alive", () => {
    const root = tempRoot();
    const first = acquireCoordinatorLock({
      storageRoot: root,
      pid: 4001,
      sessionId: "session-A",
      isProcessAlive: (pid) => pid === 4001,
    });
    expect(first.acquisition).toBe("created");

    expect(() =>
      acquireCoordinatorLock({
        storageRoot: root,
        pid: 4002,
        sessionId: "session-B",
        isProcessAlive: (pid) => pid === 4001,
      }),
    ).toThrow(CoordinatorActiveError);
    first.release();
  });

  it("names the holding session and its start time in the refusal", () => {
    const root = tempRoot();
    const clock = fakeClock();
    const lease = acquireCoordinatorLock({
      storageRoot: root,
      pid: 4101,
      sessionId: "session-A",
      now: clock.now,
      nowMs: clock.nowMs,
      isProcessAlive: () => true,
    });
    let caught: CoordinatorActiveError | null = null;
    try {
      acquireCoordinatorLock({
        storageRoot: root,
        pid: 4102,
        sessionId: "session-B",
        isProcessAlive: () => true,
      });
    } catch (error) {
      caught = error as CoordinatorActiveError;
    }
    expect(caught).toBeInstanceOf(CoordinatorActiveError);
    expect(caught?.code).toBe("KORWF_COORDINATOR_ACTIVE");
    expect(caught?.message).toContain("Coordinator active in session session-A since");
    expect(caught?.message).toContain(lease.contents.startedAt);
    expect(caught?.holder.pid).toBe(4101);
    lease.release();
  });

  it("only one of N simultaneous acquisitions proceeds; the rest are refused", () => {
    const root = tempRoot();
    const live = new Set<number>();
    let winners = 0;
    let refusals = 0;
    for (const pid of [5001, 5002, 5003, 5004, 5005]) {
      try {
        acquireCoordinatorLock({
          storageRoot: root,
          pid,
          sessionId: `session-${pid}`,
          isProcessAlive: (p) => live.has(p),
        });
        live.add(pid);
        winners += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(CoordinatorActiveError);
        refusals += 1;
      }
    }
    expect(winners).toBe(1);
    expect(refusals).toBe(4);
  });

  it("releases the lock so a later run can take it cleanly", () => {
    const root = tempRoot();
    const path = resolveCoordinatorLockPath(root);
    const first = acquireCoordinatorLock({ storageRoot: root, pid: 6001, sessionId: "A" });
    first.release();
    expect(existsSync(path)).toBe(false);
    const second = acquireCoordinatorLock({ storageRoot: root, pid: 6002, sessionId: "B" });
    expect(second.acquisition).toBe("created");
    expect(second.previousOwner).toBeNull();
    second.release();
  });
});
