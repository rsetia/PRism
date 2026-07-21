import type { Clock } from "../runtime/ports.js";

/**
 * A manual clock for tests: time only moves when the test moves it, so
 * retry backoff is instant and deterministic.
 */
export interface ManualClock extends Clock {
  /** Move time forward, resolving every wait whose deadline has passed. */
  advance(ms: number): void;
  /**
   * Advance exactly to the earliest pending deadline. Returns how far
   * time moved, or 0 when nothing is waiting — which makes
   * "keep releasing until the run finishes" a two-line test loop.
   */
  advanceToNext(): number;
  /** How many waits are currently unresolved. */
  readonly pending: number;
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Real time. The only place the SDK core is allowed to touch Date.now
 * or setTimeout.
 *
 * - now(): Date.now().
 * - wait(ms, signal): resolve after a setTimeout; if signal is already
 *   aborted, reject immediately; if it aborts while waiting, clear the
 *   timer and reject. Always remove the abort listener on settle — a
 *   leaked listener on a long-lived signal is a real leak.
 * - Rejection value: an Error with `name = "AbortError"` (match what
 *   the platform does; never assume a caught value is an Error, but do
 *   throw one).
 */
export function createSystemClock(): Clock {
  return Object.freeze({
    now: (): number => Date.now(),
    wait(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(createAbortError());
          return;
        }

        const cleanup = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          cleanup();
          reject(createAbortError());
        };

        const timer = setTimeout(
          () => {
            cleanup();
            resolve();
          },
          Math.max(0, ms),
        );
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
}

interface ManualWaiter {
  readonly deadline: number;
  readonly order: number;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  readonly cleanup: () => void;
}

/**
 * - Keep `current` time (start at 0) and a list of waiters:
 *   { deadline, resolve, reject, cleanup }.
 * - wait(ms, signal): a zero/negative ms still resolves asynchronously,
 *   never synchronously — otherwise tests see ordering real timers
 *   would never produce. Aborted signal rejects (same AbortError shape
 *   as the system clock).
 * - advance(ms): move `current` forward, then resolve every waiter with
 *   deadline <= current, in deadline order (ties: insertion order).
 *   Resolve them AFTER removing them from the list, so a waiter that
 *   schedules another wait cannot corrupt the iteration.
 * - advanceToNext(): find the minimum pending deadline, advance exactly
 *   to it, return the delta; return 0 when nothing is pending.
 * - pending: count of unresolved waiters.
 */
export function createManualClock(): ManualClock {
  let current = 0;
  let nextOrder = 0;
  const waiters: ManualWaiter[] = [];

  function remove(waiter: ManualWaiter): boolean {
    const index = waiters.indexOf(waiter);
    if (index < 0) {
      return false;
    }
    waiters.splice(index, 1);
    return true;
  }

  function advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("clock advance must be a finite non-negative number");
    }

    current += ms;
    const ready = waiters
      .filter((waiter) => waiter.deadline <= current)
      .sort(
        (left, right) =>
          left.deadline - right.deadline || left.order - right.order,
      );

    for (const waiter of ready) {
      remove(waiter);
    }
    for (const waiter of ready) {
      waiter.cleanup();
      waiter.resolve();
    }
  }

  return Object.freeze({
    now: (): number => current,
    wait(ms: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted === true) {
        return Promise.reject(createAbortError());
      }

      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          if (!remove(waiter)) {
            return;
          }
          waiter.cleanup();
          waiter.reject(createAbortError());
        };
        const cleanup = (): void => {
          signal?.removeEventListener("abort", onAbort);
        };
        const waiter: ManualWaiter = {
          deadline: current + Math.max(0, ms),
          order: nextOrder++,
          resolve,
          reject,
          cleanup,
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    advance,
    advanceToNext(): number {
      if (waiters.length === 0) {
        return 0;
      }
      const deadline = Math.min(...waiters.map((waiter) => waiter.deadline));
      const delta = deadline - current;
      advance(delta);
      return delta;
    },
    get pending(): number {
      return waiters.length;
    },
  });
}
