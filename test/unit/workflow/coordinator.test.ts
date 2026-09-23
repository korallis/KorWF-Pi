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
  inspectCoordinator,
} from "../../../src/workflow/coordinator.ts";
import { classifyHolder } from "../../../src/storage/lock.ts";
import {
  resolveCoordinatorLockPath,
  resolveLockfilePath,
} from "../../../src/storage/paths.ts";
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
    expect(caught?.message).toContain(
      "Coordinator active in session session-A since",
    );
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

  it("a live owner whose heartbeat has gone stale is still never evicted", () => {
    const root = tempRoot();
    const clock = fakeClock();
    const first = acquireCoordinatorLock({
      storageRoot: root,
      pid: 7001,
      sessionId: "session-stalled",
      now: clock.now,
      nowMs: clock.nowMs,
      heartbeatIntervalMs: 1000,
      heartbeatStaleMultiplier: 3,
      isProcessAlive: () => true,
    });
    // Far beyond the staleness window, with no heartbeat written.
    clock.advance(1000 * 3 * 100);

    const seen = inspectCoordinator({
      storageRoot: root,
      nowMs: clock.nowMs,
      heartbeatIntervalMs: 1000,
      heartbeatStaleMultiplier: 3,
      isProcessAlive: () => true,
    });
    expect(seen?.assessment.heartbeatStale).toBe(true);
    expect(seen?.assessment.liveness).toBe("alive_heartbeat_stale");
    expect(seen?.assessment.mayTakeOver).toBe(false);

    let caught: CoordinatorActiveError | null = null;
    try {
      acquireCoordinatorLock({
        storageRoot: root,
        pid: 7002,
        nowMs: clock.nowMs,
        heartbeatIntervalMs: 1000,
        heartbeatStaleMultiplier: 3,
        isProcessAlive: () => true,
      });
    } catch (error) {
      caught = error as CoordinatorActiveError;
    }
    expect(caught).toBeInstanceOf(CoordinatorActiveError);
    expect(caught?.message).toContain(
      "the process is still running, so it keeps the lock",
    );
    expect(first.isOwned()).toBe(true);
    first.release();
  });

  it("releases the lock so a later run can take it cleanly", () => {
    const root = tempRoot();
    const path = resolveCoordinatorLockPath(root);
    const first = acquireCoordinatorLock({
      storageRoot: root,
      pid: 6001,
      sessionId: "A",
    });
    first.release();
    expect(existsSync(path)).toBe(false);
    const second = acquireCoordinatorLock({
      storageRoot: root,
      pid: 6002,
      sessionId: "B",
    });
    expect(second.acquisition).toBe("created");
    expect(second.previousOwner).toBeNull();
    second.release();
  });
});

describe("AC2: killed coordinator — the next run takes over (fake clock)", () => {
  it("takes over a dead owner's lock and reports the previous owner", () => {
    const root = tempRoot();
    const clock = fakeClock();
    const live = new Set([8001]);
    const dead = acquireCoordinatorLock({
      storageRoot: root,
      pid: 8001,
      sessionId: "session-killed",
      now: clock.now,
      nowMs: clock.nowMs,
      isProcessAlive: (p) => live.has(p),
    });
    expect(dead.heartbeat()).toBe(true);

    // SIGKILL: the process vanishes, the lockfile stays exactly as it was.
    live.delete(8001);
    clock.advance(60_000);

    const next = acquireCoordinatorLock({
      storageRoot: root,
      pid: 8002,
      sessionId: "session-successor",
      now: clock.now,
      nowMs: clock.nowMs,
      isProcessAlive: (p) => live.has(p) || p === 8002,
    });
    expect(next.acquisition).toBe("took_over_stale");
    expect(next.previousOwner?.pid).toBe(8001);
    expect(next.previousOwner?.sessionId).toBe("session-killed");
    expect(next.contents.pid).toBe(8002);
    next.release();
  });

  it("does not take over on the staleness window alone — the pid decides", () => {
    const root = tempRoot();
    const clock = fakeClock();
    acquireCoordinatorLock({
      storageRoot: root,
      pid: 8101,
      sessionId: "session-busy",
      now: clock.now,
      nowMs: clock.nowMs,
      heartbeatIntervalMs: 10,
      heartbeatStaleMultiplier: 2,
      isProcessAlive: () => true,
    });
    clock.advance(10_000_000);

    // Identical clock, identical staleness window: the only difference between
    // this attempt and the next is what the pid probe says.
    const refusedWhileAlive = () =>
      acquireCoordinatorLock({
        storageRoot: root,
        pid: 8102,
        now: clock.now,
        nowMs: clock.nowMs,
        heartbeatIntervalMs: 10,
        heartbeatStaleMultiplier: 2,
        isProcessAlive: () => true,
      });
    expect(refusedWhileAlive).toThrow(CoordinatorActiveError);

    const takenOverWhenDead = acquireCoordinatorLock({
      storageRoot: root,
      pid: 8103,
      now: clock.now,
      nowMs: clock.nowMs,
      heartbeatIntervalMs: 10,
      heartbeatStaleMultiplier: 2,
      isProcessAlive: (p) => p === 8103,
    });
    expect(takenOverWhenDead.acquisition).toBe("took_over_stale");
    takenOverWhenDead.release();
  });

  it("classifyHolder reports a fresh heartbeat as alive and not stale", () => {
    const root = tempRoot();
    const clock = fakeClock();
    const lease = acquireCoordinatorLock({
      storageRoot: root,
      pid: 8201,
      now: clock.now,
      nowMs: clock.nowMs,
      heartbeatIntervalMs: 1000,
      heartbeatStaleMultiplier: 6,
      isProcessAlive: () => true,
    });
    clock.advance(5000);
    expect(lease.heartbeat()).toBe(true);
    expect(lease.lastHeartbeatAt()).toBe(clock.now());

    const holder = inspectCoordinator({
      storageRoot: root,
      isProcessAlive: () => true,
    })?.holder;
    expect(holder).toBeDefined();
    const assessment = classifyHolder(holder!, {
      isProcessAlive: () => true,
      nowMs: clock.nowMs(),
      staleAfterMs: 6000,
    });
    expect(assessment.liveness).toBe("alive");
    expect(assessment.heartbeatAgeMs).toBe(0);
    expect(assessment.heartbeatStale).toBe(false);
    lease.release();
  });

  it("a displaced lease stops heartbeating and never deletes the new owner's lock", () => {
    const root = tempRoot();
    const path = resolveCoordinatorLockPath(root);
    const clock = fakeClock();
    const live = new Set([8301]);
    const displaced = acquireCoordinatorLock({
      storageRoot: root,
      pid: 8301,
      now: clock.now,
      nowMs: clock.nowMs,
      isProcessAlive: (p) => live.has(p),
    });
    live.delete(8301);
    clock.advance(60_000);
    const successor = acquireCoordinatorLock({
      storageRoot: root,
      pid: 8302,
      now: clock.now,
      nowMs: clock.nowMs,
      isProcessAlive: (p) => p === 8302,
    });

    // The zombie comes back: it must neither stamp its heartbeat on the new
    // owner's lockfile nor delete it on shutdown.
    expect(displaced.heartbeat()).toBe(false);
    expect(displaced.isOwned()).toBe(false);
    displaced.release();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(8302);
    expect(successor.isOwned()).toBe(true);
    successor.release();
  });

  it("uses a lockfile distinct from the #23 store lock", () => {
    const root = tempRoot();
    const lease = acquireCoordinatorLock({ storageRoot: root, pid: 8401 });
    expect(resolveCoordinatorLockPath(root)).not.toBe(
      resolveLockfilePath(root),
    );
    expect(existsSync(resolveCoordinatorLockPath(root))).toBe(true);
    expect(existsSync(resolveLockfilePath(root))).toBe(false);
    lease.release();
  });
});
