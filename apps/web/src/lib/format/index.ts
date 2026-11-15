export { formatInr, formatPct, fiscalQuarterLabel, pctChange } from "@finn/shared/format";

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

/** Classifier provenance (which rule or field matched); the category kicker already says what it is. */
const HIDDEN_REASON_KEYS = new Set(["category", "subject", "text"]);

const REASON_PHRASES: Record<string, string> = {
  llm_unavailable: "Rule-classified",
  routine: "Routine",
  "seniority:kmp": "KMP",
  "seniority:board_or_cxo": "Board / CXO",
  "seniority:senior_management": "Senior management",
};

/**
 * "pat_yoy_+14.9%" → "PAT YoY +14.9%"; "size:small_vs_mcap" → "Small vs mcap". Returns null for codes
 * that only record how the classifier decided ("category:results", "subject:generic", "text:…").
 * Codes that already read as text pass through.
 */
export function humanizeReason(code: string): string | null {
  if (/\s/.test(code)) return code;
  if (REASON_PHRASES[code]) return REASON_PHRASES[code];
  const colon = code.indexOf(":");
  if (colon > 0) {
    const key = code.slice(0, colon).toLowerCase();
    const value = code.slice(colon + 1);
    if (HIDDEN_REASON_KEYS.has(key) || !value) return null;
    if (key === "impact") {
      const n = Number(value);
      return !Number.isFinite(n) ? null : n >= 1.1 ? "Large for the company" : n <= 0.9 ? "Minor for the company" : null;
    }
    return humanizeReason(value);
  }
  const words = code.split("_").filter(Boolean);
  const acronyms = new Set(["pat", "pbt", "nii", "ebitda", "ppop", "cfo", "ceo", "cxo", "md", "ncd", "xbrl", "agm", "egm", "esop", "mcap"]);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (lower === "yoy") return "YoY";
      if (lower === "qoq") return "QoQ";
      if (acronyms.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ")
    .replace(/(\d)x\b/g, "$1×")
    .replace(/(^|\s)-(?=\d)/g, "$1\u2212");
}

const SMALL = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
export function numberWord(n: number): string {
  return SMALL[n] ?? String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
