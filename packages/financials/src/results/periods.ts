import { fiscalQuarterLabel } from "@finn/shared/format";

export { fiscalQuarterLabel };

/** Calendar quarter end `offset` quarters away from an ISO quarter-end date (negative = earlier). */
export function shiftQuarterEnd(periodEnd: string, offset: number): string {
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  const monthIndex = y * 12 + (m - 1) + offset * 3;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(lastDay)}`;
}

export function previousQuarterEnd(periodEnd: string): string {
  return shiftQuarterEnd(periodEnd, -1);
}

export function yearAgoQuarterEnd(periodEnd: string): string {
  return shiftQuarterEnd(periodEnd, -4);
}

export function isQuarterEnd(date: string): boolean {
  return /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(date);
}

/** Label for a FourD window: "H1 FY27", "9M FY27", "FY26"; Q1 windows read as the quarter. */
export function fiscalYtdLabel(ytdStart: string, periodEnd: string): string {
  const [sy, sm] = ytdStart.split("-").map(Number) as [number, number];
  const [ey, em] = periodEnd.split("-").map(Number) as [number, number];
  const months = (ey - sy) * 12 + (em - sm) + 1;
  const fy = `FY${String(em <= 3 ? ey : ey + 1).slice(-2)}`;
  if (months >= 12) return fy;
  if (months === 6) return `H1 ${fy}`;
  if (months === 9) return `9M ${fy}`;
  return fiscalQuarterLabel(periodEnd);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
