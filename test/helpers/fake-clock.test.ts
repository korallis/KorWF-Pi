/**
 * Unit test for the fake clock helper (issue #20 AC1: real unit test).
 */
import { describe, expect, it } from "vitest";
import { FakeClock, systemClock } from "./fake-clock.ts";

describe("FakeClock", () => {
  it("starts at 0 by default and reports it via now()", () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(0);
  });

  it("starts at a given epoch ms when provided", () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it("advance() moves time forward deterministically and returns the new value", () => {
    const clock = new FakeClock(0);
    expect(clock.advance(500)).toBe(500);
    expect(clock.now()).toBe(500);
    expect(clock.advance(250)).toBe(750);
  });

  it("advance() rejects negative durations (time never runs backwards)", () => {
    const clock = new FakeClock(0);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });

  it("set() jumps to an absolute time", () => {
    const clock = new FakeClock(0);
    clock.set(42_000);
    expect(clock.now()).toBe(42_000);
  });
});

describe("systemClock", () => {
  it("reports the real current time, close to Date.now()", () => {
    const before = Date.now();
    const reported = systemClock.now();
    const after = Date.now();
    expect(reported).toBeGreaterThanOrEqual(before);
    expect(reported).toBeLessThanOrEqual(after);
  });
});
