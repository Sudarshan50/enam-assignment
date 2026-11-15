import { IST_OFFSET_MS } from "@finn/shared/format";

export interface ScheduledJob {
  name: string;
  command: string;
  args: Record<string, string | boolean>;
  /** Minimum gap between runs at this moment, or null when the job should not run now. */
  intervalMs(now: Date): number | null;
}

const MINUTE = 60_000;

/** Minutes since midnight and day of week, in India time. */
export function istClock(now: Date): { minutes: number; weekday: number } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return { minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(), weekday: ist.getUTCDay() };
}

const isWeekday = (weekday: number) => weekday >= 1 && weekday <= 5;

export const DEFAULT_JOBS: readonly ScheduledJob[] = [
  {
    name: "ingest",
    command: "ingest",
    args: {},
    // Filings cluster around market hours and post-close board meetings.
    intervalMs: (now) => {
      const { minutes } = istClock(now);
      return minutes >= 8 * 60 && minutes < 23 * 60 ? 10 * MINUTE : 60 * MINUTE;
    },
  },
  {
    name: "eod",
    command: "eod",
    args: { "if-missing": true },
    // Bhavcopy usually lands around 18:00 IST; keep retrying until it does.
    intervalMs: (now) => {
      const { minutes, weekday } = istClock(now);
      return isWeekday(weekday) && minutes >= 18 * 60 + 30 && minutes < 23 * 60 + 30 ? 30 * MINUTE : null;
    },
  },
  {
    name: "results-backfill",
    command: "results-backfill",
    args: {},
    intervalMs: (now) => {
      const { minutes } = istClock(now);
      return minutes >= 21 * 60 && minutes < 22 * 60 ? 24 * 60 * MINUTE : null;
    },
  },
  {
    name: "master-list",
    command: "master-list",
    args: {},
    intervalMs: (now) => {
      const { minutes, weekday } = istClock(now);
      return weekday === 0 && minutes >= 6 * 60 && minutes < 7 * 60 ? 7 * 24 * 60 * MINUTE : null;
    },
  },
  {
    name: "module-retries",
    command: "module-retries",
    args: {},
    // Each retry carries its own backoff; this only bounds how soon a due one is picked up.
    intervalMs: () => 5 * MINUTE,
  },
];

/** Jobs whose interval has elapsed since their last start, in declaration order. */
export function dueJobs(jobs: readonly ScheduledJob[], lastStarted: ReadonlyMap<string, number>, now: Date): ScheduledJob[] {
  return jobs.filter((job) => {
    const interval = job.intervalMs(now);
    if (interval === null) return false;
    const last = lastStarted.get(job.name);
    return last === undefined || now.getTime() - last >= interval;
  });
}
