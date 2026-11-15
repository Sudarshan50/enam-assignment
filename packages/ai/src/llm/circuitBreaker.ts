export interface CircuitBreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Opens after N consecutive failures and rejects calls for `openMs`. After that one trial call is let
 * through (half-open): success closes the circuit, failure re-opens it.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.openMs = opts.openMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.openMs ? "half_open" : "open";
  }

  /** Milliseconds until a trial call is allowed, or 0 when calls may proceed. */
  retryAfterMs(): number {
    if (this.openedAt === null) return 0;
    return Math.max(0, this.openMs - (this.now() - this.openedAt));
  }

  /** Returns false when the call must be rejected without contacting the provider. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "open") return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  recordFailure(): void {
    this.failures++;
    if (this.trialInFlight || this.failures >= this.threshold) this.openedAt = this.now();
    this.trialInFlight = false;
  }
}
