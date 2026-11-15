import { istDateString } from "@finn/shared/format";
import type { Category } from "@finn/shared/taxonomy";

export interface ClusterKeyInput {
  symbol: string;
  category: Category;
  publishedAt: Date;
  /** Fiscal period end (YYYY-MM-DD); used for results so the outcome PDF, XBRL and newspaper ad collapse together. */
  periodEnd?: string | null;
}

/** Results cluster by fiscal period; everything else by (symbol, category, IST day). */
export function clusterKey(input: ClusterKeyInput): string {
  const symbol = input.symbol.toUpperCase();
  if (input.category === "results") {
    return `${symbol}:results:${input.periodEnd ?? latestQuarterEndBefore(input.publishedAt)}`;
  }
  return `${symbol}:${input.category}:${istDateString(input.publishedAt)}`;
}

export interface ClusterMember {
  seqId: string;
  score: number | null;
  publishedAt: Date;
}

/** Highest score wins; ties go to the earliest filing, then the lowest seq id (deterministic). */
export function pickClusterHead<T extends ClusterMember>(items: readonly T[]): T | null {
  let head: T | null = null;
  for (const item of items) {
    if (!head) {
      head = item;
      continue;
    }
    const a = item.score ?? -1;
    const b = head.score ?? -1;
    if (a > b) head = item;
    else if (a === b) {
      const ta = item.publishedAt.getTime();
      const tb = head.publishedAt.getTime();
      if (ta < tb || (ta === tb && item.seqId < head.seqId)) head = item;
    }
  }
  return head;
}

const QUARTER_ENDS = ["03-31", "06-30", "09-30", "12-31"] as const;

/** The most recent fiscal quarter end strictly before the IST date of `at`. */
export function latestQuarterEndBefore(at: Date): string {
  const today = istDateString(at);
  const year = Number(today.slice(0, 4));
  for (const y of [year, year - 1]) {
    for (let i = QUARTER_ENDS.length - 1; i >= 0; i--) {
      const candidate = `${y}-${QUARTER_ENDS[i]}`;
      if (candidate < today) return candidate;
    }
  }
  return `${year - 1}-12-31`;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const DATE_PATTERNS: RegExp[] = [
  // 30th September, 2026 / 30 Sep 2026
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi,
  // September 30, 2026
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
  // 30-09-2026, 30.09.2026, 30/09/2026
  /\b(\d{1,2})[-./](\d{1,2})[-./](\d{4})\b/g,
];

/**
 * Fiscal period a results filing refers to: the latest quarter-end date mentioned in the text
 * that is not after the publish date, else the latest quarter end before publication.
 */
export function inferPeriodEnd(text: string, publishedAt: Date): string {
  const published = istDateString(publishedAt);
  const found: string[] = [];
  for (const re of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      let iso: string | null = null;
      if (/^\d/.test(m[1]!) && m[2] && /^[a-z]/i.test(m[2])) {
        const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
        if (month) iso = `${m[3]}-${month}-${m[1]!.padStart(2, "0")}`;
      } else if (/^[a-z]/i.test(m[1]!)) {
        const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
        if (month) iso = `${m[3]}-${month}-${m[2]!.padStart(2, "0")}`;
      } else {
        iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
      }
      if (iso && QUARTER_ENDS.some((q) => iso.endsWith(q)) && iso < published) found.push(iso);
    }
  }
  found.sort();
  return found.at(-1) ?? latestQuarterEndBefore(publishedAt);
}
