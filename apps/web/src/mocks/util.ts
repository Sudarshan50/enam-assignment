export const CR = 1e7;

export function hoursAgo(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

export function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

/** Deterministic PRNG so sparklines and backtests are stable across reloads. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Last completed NSE session on or before `now` (weekends skipped, holidays ignored). */
export function lastSessionDate(now: Date): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const day = ist.getUTCDay();
  const back = day === 0 ? 2 : day === 6 ? 1 : 0;
  ist.setUTCDate(ist.getUTCDate() - back);
  return ist.toISOString().slice(0, 10);
}
