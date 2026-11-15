/** Calendar quarter end `offset` quarters away from an ISO quarter-end date (negative = earlier). */
export function shiftQuarterEnd(periodEnd: string, offset: number): string {
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  const monthIndex = y * 12 + (m - 1) + offset * 3;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}
