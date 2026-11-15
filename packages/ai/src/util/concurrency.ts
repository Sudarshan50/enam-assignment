export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Maps over items with at most `limit` promises in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Exponential backoff with full jitter: base * 2^attempt, scaled by a random factor in [0.5, 1). */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 8_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}
