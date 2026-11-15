const CRORE = 1e7;
const LAKH = 1e5;

/** Formats absolute rupees in Indian notation: ₹73,188 Cr, ₹4.2 L. */
export function formatInr(rupees: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (rupees == null || !Number.isFinite(rupees)) return "—";
  const sign = rupees < 0 ? "-" : "";
  const abs = Math.abs(rupees);
  if (abs >= CRORE) {
    const cr = abs / CRORE;
    const digits = opts.compact && cr >= 100 ? 0 : cr >= 100 ? 0 : 1;
    return `${sign}₹${cr.toLocaleString("en-IN", { maximumFractionDigits: digits })} Cr`;
  }
  if (abs >= LAKH) return `${sign}₹${(abs / LAKH).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L`;
  return `${sign}₹${abs.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function pctChange(current: number | null | undefined, base: number | null | undefined): number | null {
  if (current == null || base == null || base === 0) return null;
  return ((current - base) / Math.abs(base)) * 100;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parses NSE timestamps like "09-Nov-2026 17:12:15" or "30-SEP-2026" as Asia/Kolkata time. */
export function parseNseDate(input: string): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(input.trim());
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (month === undefined) return null;
  const [day, year, hh, mm, ss] = [Number(m[1]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  return new Date(Date.UTC(year, month, day, hh, mm, ss) - IST_OFFSET_MS);
}

export const IST_OFFSET_MS = 330 * 60 * 1000;

/** YYYY-MM-DD of the given instant in India time. */
export function istDateString(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** NSE query format DD-MM-YYYY in India time. */
export function nseQueryDate(date: Date): string {
  const [y, m, d] = istDateString(date).split("-");
  return `${d}-${m}-${y}`;
}

/** Indian fiscal quarter label for a period end, e.g. 2026-09-30 -> "Q2 FY27". */
export function fiscalQuarterLabel(periodEnd: string): string {
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  const q = m <= 3 ? 4 : m <= 6 ? 1 : m <= 9 ? 2 : 3;
  const fy = m <= 3 ? y : y + 1;
  return `Q${q} FY${String(fy).slice(-2)}`;
}
