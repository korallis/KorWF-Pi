/**
 * Fake clock for tests (issue #20 Scope).
 *
 * Deterministic, manually-advanced time source. Nothing in this repo should
 * call `Date.now()` / `new Date()` directly in code whose behaviour depends
 * on time — pass a `Clock` instead so tests can control it without real
 * delays or flakiness.
 */

export interface Clock {
  /** Current time in epoch milliseconds. */
  now: () => number;
}

export class FakeClock implements Clock {
  #ms: number;

  constructor(startMs = 0) {
    this.#ms = startMs;
  }

  now(): number {
    return this.#ms;
  }

  /** Advance the clock by `ms` milliseconds and return the new time. */
  advance(ms: number): number {
    if (ms < 0) {
      throw new RangeError(`FakeClock.advance: ms must be >= 0, got ${ms}`);
    }
    this.#ms += ms;
    return this.#ms;
  }

  /** Set the clock to an absolute epoch-millisecond value. */
  set(ms: number): void {
    this.#ms = ms;
  }
}

/** The real system clock, for production code paths. */
export const systemClock: Clock = { now: () => Date.now() };
