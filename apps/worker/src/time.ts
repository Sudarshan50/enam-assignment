import { IST_OFFSET_MS, istDateString } from "@finn/shared/format";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of an India-time calendar day (YYYY-MM-DD) as a UTC instant. */
export function istDayStart(isoDate: string): Date {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - IST_OFFSET_MS);
}

/** Midday India time on that date: a safe instant for APIs that format the date in IST. */
export function istNoon(isoDate: string): Date {
  return new Date(istDayStart(isoDate).getTime() + DAY_MS / 2);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function todayIst(now: Date = new Date()): string {
  return istDateString(now);
}

export function isWeekend(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Inclusive list of IST dates from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
