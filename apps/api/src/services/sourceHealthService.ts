import type { SourceHealth } from "@finn/shared";
import { type Clock, HOUR, MINUTE, istClock, isWeekday, lastWeekdayAt, systemClock, toIso } from "../lib/time";

export interface SourceHealthRow {
  source: string;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface SourceHealthRepository {
  list(): Promise<SourceHealthRow[]>;
}

export interface SourceHealthService {
  list(): Promise<SourceHealth[]>;
}

/** Announcements are polled every 15 minutes, 08:30-22:00 IST on weekdays. */
const POLL_OPEN_MIN = 9 * 60 + 15; // first poll + grace
const POLL_CLOSE_MIN = 22 * 60;
const ANNOUNCEMENT_GRACE = 45 * MINUTE;
/** End-of-day prices are fetched 18:30-21:30 IST. */
const EOD_DUE_MIN = 22 * 60;
const EOD_EARLIEST = 4 * HOUR;
const MAX_FAILURES = 3;

export const isAnnouncementSource = (source: string) => /announc/i.test(source);
const isEodSource = (source: string) => /bhav|price|eod|yahoo/i.test(source);
const isWeeklySource = (source: string) => /master/i.test(source);

/**
 * Whether a source should be shown as stale. Market-aware so that nights and weekends
 * (when nothing is polled) are not flagged.
 */
export function isStale(row: Pick<SourceHealthRow, "source" | "lastSuccessAt" | "consecutiveFailures">, now: Date): boolean {
  const last = row.lastSuccessAt;
  if (!last) return true;
  if (row.consecutiveFailures >= MAX_FAILURES) return true;
  const age = now.getTime() - last.getTime();

  if (isAnnouncementSource(row.source)) {
    const { dayOfWeek, minutes } = istClock(now);
    if (isWeekday(dayOfWeek) && minutes >= POLL_OPEN_MIN && minutes <= POLL_CLOSE_MIN) return age > ANNOUNCEMENT_GRACE;
    return last.getTime() < lastWeekdayAt(now, POLL_CLOSE_MIN).getTime() - ANNOUNCEMENT_GRACE;
  }
  if (isEodSource(row.source)) {
    return last.getTime() < lastWeekdayAt(now, EOD_DUE_MIN).getTime() - EOD_EARLIEST;
  }
  if (isWeeklySource(row.source)) return age > 8 * 24 * HOUR;
  return age > 24 * HOUR;
}

export function toSourceHealth(row: SourceHealthRow, now: Date): SourceHealth {
  return {
    source: row.source,
    lastSuccessAt: toIso(row.lastSuccessAt),
    lastAttemptAt: toIso(row.lastAttemptAt),
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
    stale: isStale(row, now),
  };
}

export function createSourceHealthService(repo: SourceHealthRepository, now: Clock = systemClock): SourceHealthService {
  return {
    async list() {
      const at = now();
      return (await repo.list()).map((r) => toSourceHealth(r, at));
    },
  };
}
