export { formatInr, formatPct, fiscalQuarterLabel, pctChange } from "@finn/shared/format";
export { describeReason as humanizeReason, describeReasons } from "@finn/shared/reasons";

const IST = "Asia/Kolkata";

export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Indian grouping without currency: 12,50,000 → "12.5 lakh" when compact. */
export function formatCount(value: number | null | undefined, compact = false): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (compact) {
    if (Math.abs(value) >= 1e7) return `${(value / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr`;
    if (Math.abs(value) >= 1e5) return `${(value / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L`;
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function formatMultiple(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}×`;
}

export function formatBps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(Math.round(value));
  const sign = abs === 0 ? "" : value > 0 ? "+" : "−";
  return `${sign}${abs.toLocaleString("en-IN")} bps`;
}

/** Signed percentage with a true minus sign, for tables. Values that round to zero are unsigned. */
export function formatSignedPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value).toFixed(digits);
  const sign = Number(abs) === 0 ? "" : value > 0 ? "+" : "−";
  return `${sign}${abs}%`;
}

export function formatPlainPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function istDateLong(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
}

export function istTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

export function istDateShort(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" }).format(d);
}

export function istDateTime(date: Date | string): string {
  return `${istDateShort(date)}, ${istTime(date)} IST`;
}

/** "Just now", "12m", "5h", "Yesterday", "3d", then a date. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, now.getTime() - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return istDateShort(iso);
}

const SMALL = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
export function numberWord(n: number): string {
  return SMALL[n] ?? String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
