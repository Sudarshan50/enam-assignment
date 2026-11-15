import { IST_OFFSET_MS, istDateString } from "@finn/shared/format";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Midnight Asia/Kolkata of the day containing `now`, as a UTC instant. */
export function startOfIstDay(now: Date): Date {
  return new Date(Date.parse(`${istDateString(now)}T00:00:00Z`) - IST_OFFSET_MS);
}

/** Day of week (0 = Sunday) and minutes since midnight, both in India time. */
export function istClock(now: Date): { dayOfWeek: number; minutes: number } {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return { dayOfWeek: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export function isWeekday(dayOfWeek: number): boolean {
  return dayOfWeek !== 0 && dayOfWeek !== 6;
}

/** The most recent Mon-Fri instant at `minutesOfDay` IST that is not after `now`. */
export function lastWeekdayAt(now: Date, minutesOfDay: number): Date {
  const midnight = startOfIstDay(now).getTime();
  for (let back = 0; back < 8; back++) {
    const t = midnight - back * DAY + minutesOfDay * MINUTE;
    if (t <= now.getTime() && isWeekday(istClock(new Date(t)).dayOfWeek)) return new Date(t);
  }
  return new Date(midnight - 7 * DAY + minutesOfDay * MINUTE);
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toIsoRequired(value: Date | string): string {
  return toIso(value) ?? new Date(0).toISOString();
}
