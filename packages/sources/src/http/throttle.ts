export interface Throttle {
  /** Resolves once at least `minIntervalMs` has passed since the previous call resolved. */
  wait(): Promise<void>;
}

export interface ThrottleOptions {
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createThrottle(options: ThrottleOptions): Throttle {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = Number.NEGATIVE_INFINITY;
  let queue: Promise<void> = Promise.resolve();

  return {
    wait() {
      queue = queue.then(async () => {
        const delay = last + options.minIntervalMs - now();
        if (delay > 0) await sleep(delay);
        last = now();
      });
      return queue;
    },
  };
}
