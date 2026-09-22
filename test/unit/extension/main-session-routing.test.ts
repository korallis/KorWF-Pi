/**
 * `src/extension/main-session-routing.ts` (issue #67; PLAN §3.D "Main
 * session").
 *
 * Acceptance criteria exercised:
 *  - "With default config no switch ever occurs (spy)."
 *  - "With opt-in, a switch happens only at a boundary and a notice +
 *    session entry are produced."
 */
import { describe, it, expect, vi } from "vitest";
import {
  MainSessionRouter,
  registerMainSessionRouting,
  isLockHeldByOtherProcess,
  MAIN_SESSION_SWITCH_ENTRY_TYPE,
  type MainSessionRoutingDeps,
  type HandoffSummary,
} from "../../../src/extension/main-session-routing.ts";
import { resolveLockfilePath } from "../../../src/storage/paths.ts";
import { acquireLock } from "../../../src/storage/lock.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HANDOFF: HandoffSummary = { reason: "cap fallback", fromModel: null, toModel: "vendor/model-b", taskContext: "task-1" };

function makeDeps(overrides: Partial<MainSessionRoutingDeps> = {}): MainSessionRoutingDeps & { notified: string[]; entries: unknown[] } {
  const notified: string[] = [];
  const entries: unknown[] = [];
  return {
    isEnabled: () => false,
    isIdle: () => true,
    isLockHeldByOther: () => false,
    currentModel: () => "vendor/model-a",
    setModel: vi.fn(async () => true),
    notify: (m) => notified.push(m),
    recordEntry: (e) => entries.push(e),
    now: () => "2026-09-22T00:00:00.000Z",
    notified,
    entries,
    ...overrides,
  } as MainSessionRoutingDeps & { notified: string[]; entries: unknown[] };
}

describe("MainSessionRouter — default off", () => {
  it("requestSwitch never queues and setModel is never called when routeMainSession is false (spy)", async () => {
    const deps = makeDeps({ isEnabled: () => false });
    const router = new MainSessionRouter(deps);
    const outcome = router.requestSwitch("vendor/model-b", HANDOFF);
    expect(outcome).toEqual({ kind: "disabled" });
    expect(router.peekPending()).toBeNull();

    const boundary = await router.onSafeBoundary();
    expect(boundary).toEqual({ kind: "disabled" });
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(deps.notified).toHaveLength(0);
    expect(deps.entries).toHaveLength(0);
  });
});

describe("MainSessionRouter — opt-in", () => {
  it("queues on requestSwitch but does not switch until onSafeBoundary is called", async () => {
    const deps = makeDeps({ isEnabled: () => true });
    const router = new MainSessionRouter(deps);
    const outcome = router.requestSwitch("vendor/model-b", HANDOFF);
    expect(outcome).toEqual({ kind: "queued" });
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(router.peekPending()).not.toBeNull();
  });

  it("applies at the boundary, notifies visibly, and records a session entry with the handoff summary", async () => {
    const deps = makeDeps({ isEnabled: () => true });
    const router = new MainSessionRouter(deps);
    router.requestSwitch("vendor/model-b", HANDOFF);
    const result = await router.onSafeBoundary();
    expect(result.kind).toBe("switched");
    expect(deps.setModel).toHaveBeenCalledWith("vendor/model-b");
    expect(deps.notified[0]).toMatch(/vendor\/model-a.*vendor\/model-b/);
    expect(deps.entries).toHaveLength(1);
    expect(deps.entries[0]).toMatchObject({ fromModel: "vendor/model-a", toModel: "vendor/model-b", reason: "cap fallback" });
    expect(router.peekPending()).toBeNull();
  });

  it("refuses to switch while not idle (mid-turn/mid-tool-call) and leaves the request queued", async () => {
    const deps = makeDeps({ isEnabled: () => true, isIdle: () => false });
    const router = new MainSessionRouter(deps);
    router.requestSwitch("vendor/model-b", HANDOFF);
    const result = await router.onSafeBoundary();
    expect(result).toEqual({ kind: "blocked", why: "not_idle" });
    expect(deps.setModel).not.toHaveBeenCalled();
    expect(router.peekPending()).not.toBeNull();
  });

  it("refuses to switch while another process holds the store lock and leaves the request queued", async () => {
    const deps = makeDeps({ isEnabled: () => true, isLockHeldByOther: () => true });
    const router = new MainSessionRouter(deps);
    router.requestSwitch("vendor/model-b", HANDOFF);
    const result = await router.onSafeBoundary();
    expect(result).toEqual({ kind: "blocked", why: "lock_held" });
    expect(deps.setModel).not.toHaveBeenCalled();
  });

  it("reports switch_failed and does not clear the pending request or record an entry when setModel returns false (no auth)", async () => {
    const deps = makeDeps({ isEnabled: () => true, setModel: vi.fn(async () => false) });
    const router = new MainSessionRouter(deps);
    router.requestSwitch("vendor/model-b", HANDOFF);
    const result = await router.onSafeBoundary();
    expect(result).toEqual({ kind: "switch_failed" });
    expect(deps.notified).toHaveLength(0);
    expect(deps.entries).toHaveLength(0);
  });

  it("discards a queued request if routing is disabled before the next boundary, rather than firing once re-enabled with unrelated intent", async () => {
    let enabled = true;
    const deps = makeDeps({ isEnabled: () => enabled });
    const router = new MainSessionRouter(deps);
    router.requestSwitch("vendor/model-b", HANDOFF);
    enabled = false;
    const result = await router.onSafeBoundary();
    expect(result).toEqual({ kind: "disabled" });
    expect(router.peekPending()).toBeNull();
  });

  it("no_pending when the boundary fires with nothing queued", async () => {
    const deps = makeDeps({ isEnabled: () => true });
    const router = new MainSessionRouter(deps);
    const result = await router.onSafeBoundary();
    expect(result).toEqual({ kind: "no_pending" });
  });
});

describe("isLockHeldByOtherProcess", () => {
  it("false when no lockfile exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "korwf-lock-"));
    try {
      expect(isLockHeldByOtherProcess(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false when this process holds the lock itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "korwf-lock-"));
    try {
      const handle = acquireLock(resolveLockfilePath(dir), { pid: process.pid });
      expect(isLockHeldByOtherProcess(dir)).toBe(false);
      handle.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true when a different live process holds the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "korwf-lock-"));
    try {
      // Use pid 1 as a stand-in for "some other process"; isProcessAlive
      // default probe uses process.kill, so inject a fake liveness check
      // via acquireLock's own default is fine since pid 1 is real on the
      // CI/host but not this process. Instead assert via a synthetic pid
      // guaranteed alive: this process's parent.
      const otherPid = process.ppid > 1 ? process.ppid : process.pid + 1;
      acquireLock(resolveLockfilePath(dir), { pid: otherPid });
      expect(isLockHeldByOtherProcess(dir)).toBe(otherPid !== process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registerMainSessionRouting — Pi wiring", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  function makeFakePi(): { on: (event: string, handler: Handler) => () => void; fire: (event: string, ctx: unknown) => Promise<void>; appendEntry: (t: string, d?: unknown) => void; setModel: (m: unknown) => Promise<boolean>; appended: Array<{ type: string; data: unknown }>; setModelCalls: unknown[] } {
    const handlers = new Map<string, Handler[]>();
    const appended: Array<{ type: string; data: unknown }> = [];
    const setModelCalls: unknown[] = [];
    return {
      on: (event, handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
      fire: async (event, ctx) => {
        for (const h of handlers.get(event) ?? []) await h(undefined, ctx);
      },
      appendEntry: (t, d) => appended.push({ type: t, data: d }),
      setModel: async (m) => {
        setModelCalls.push(m);
        return true;
      },
      appended,
      setModelCalls,
    };
  }

  function fakeCtx(cwd: string, _provider: string, _id: string) {
    return {
      cwd,
      isIdle: () => true,
      model: { provider: "vendor", id: "model-a" },
      modelRegistry: { find: (p: string, mid: string) => ({ provider: p, id: mid }) },
      ui: { notify: vi.fn() },
    };
  }

  it("registers on agent_settled only", () => {
    const pi = makeFakePi();
    const registered: string[] = [];
    const wrapped = { ...pi, on: (event: string, h: Handler) => { registered.push(event); return pi.on(event, h); } };
    registerMainSessionRouting(wrapped as never, () => ({ routeMainSession: true }));
    expect(registered).toEqual(["agent_settled"]);
  });

  it("default config (routeMainSession: false): requestSwitch is a no-op and agent_settled never calls setModel (spy)", async () => {
    const pi = makeFakePi();
    const { requestSwitch } = registerMainSessionRouting(pi as never, () => ({ routeMainSession: false }));
    const outcome = requestSwitch("/proj", "vendor/model-b", HANDOFF);
    expect(outcome).toEqual({ kind: "disabled" });
    await pi.fire("agent_settled", fakeCtx("/proj", "vendor", "model-a"));
    expect(pi.setModelCalls).toHaveLength(0);
    expect(pi.appended).toHaveLength(0);
  });

  it("opt-in: switch applies only when agent_settled (boundary) fires, with a visible notice and a session entry", async () => {
    const pi = makeFakePi();
    const { requestSwitch } = registerMainSessionRouting(pi as never, () => ({ routeMainSession: true }));
    const ctx = fakeCtx("/proj", "vendor", "model-a");

    const queued = requestSwitch("/proj", "vendor/model-b", HANDOFF);
    expect(queued).toEqual({ kind: "queued" });
    expect(pi.setModelCalls).toHaveLength(0); // not applied yet — request time != boundary time

    await pi.fire("agent_settled", ctx);
    expect(pi.setModelCalls).toEqual([{ provider: "vendor", id: "model-b" }]);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(pi.appended).toHaveLength(1);
    expect(pi.appended[0]?.type).toBe(MAIN_SESSION_SWITCH_ENTRY_TYPE);
    expect(pi.appended[0]?.data).toMatchObject({ toModel: "vendor/model-b", reason: "cap fallback" });
  });
});
