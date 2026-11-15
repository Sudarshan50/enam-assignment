/** Indian fiscal periods (April–March). FY27 = 1 Apr 2026 – 31 Mar 2027. */
export interface FiscalPeriod {
  /** Canonical label: "FY27", "H2 FY27" or "Q3 FY27". */
  label: string;
  kind: "FY" | "H" | "Q";
  /** Calendar year in which the fiscal year ends (FY27 -> 2027). */
  fy: number;
  index: number | null;
  start: string;
  end: string;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function normaliseFy(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (raw.length === 2) return 2000 + n;
  if (raw.length === 4) return n;
  return null;
}

export function fiscalYearPeriod(fy: number): FiscalPeriod {
  return { label: `FY${String(fy).slice(-2)}`, kind: "FY", fy, index: null, start: iso(fy - 1, 4, 1), end: iso(fy, 3, 31) };
}

export function halfPeriod(fy: number, half: 1 | 2): FiscalPeriod {
  const label = `H${half} FY${String(fy).slice(-2)}`;
  return half === 1
    ? { label, kind: "H", fy, index: 1, start: iso(fy - 1, 4, 1), end: iso(fy - 1, 9, 30) }
    : { label, kind: "H", fy, index: 2, start: iso(fy - 1, 10, 1), end: iso(fy, 3, 31) };
}

export function quarterPeriod(fy: number, q: 1 | 2 | 3 | 4): FiscalPeriod {
  const startMonth = [4, 7, 10, 1][q - 1]!;
  const year = q === 4 ? fy : fy - 1;
  const endMonth = startMonth + 2;
  return { label: `Q${q} FY${String(fy).slice(-2)}`, kind: "Q", fy, index: q, start: iso(year, startMonth, 1), end: iso(year, endMonth, lastDay(year, endMonth)) };
}

/** Parses "FY27", "FY2027", "FY 27", "H2 FY27", "2HFY27", "Q3 FY27", "Q3FY27", "3QFY27". */
export function parseFiscalLabel(input: string): FiscalPeriod | null {
  const s = input.toUpperCase().replace(/[\s'-]+/g, "");
  let m = /^FY(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const fy = normaliseFy(m[1]!);
    return fy ? fiscalYearPeriod(fy) : null;
  }
  m = /^(?:H([12])|([12])H)FY(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const fy = normaliseFy(m[3]!);
    return fy ? halfPeriod(fy, Number(m[1] ?? m[2]) as 1 | 2) : null;
  }
  m = /^(?:Q([1-4])|([1-4])Q)FY(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const fy = normaliseFy(m[3]!);
    return fy ? quarterPeriod(fy, Number(m[1] ?? m[2]) as 1 | 2 | 3 | 4) : null;
  }
  return null;
}

/** Fiscal year containing the date (FY ends in March). */
export function fiscalYearOf(date: string | Date): number {
  const d = typeof date === "string" ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : date;
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 3 ? y + 1 : y;
}

/** The fiscal quarter whose results a call held on this date discusses: the last quarter ending before the call's month. */
export function quarterDiscussedOn(callDate: string): FiscalPeriod {
  const [y, m] = callDate.slice(0, 10).split("-").map(Number) as [number, number];
  // Last quarter-end strictly before the first day of the call month.
  const endMonth = m <= 3 ? 12 : m <= 6 ? 3 : m <= 9 ? 6 : 9;
  const endYear = m <= 3 ? y - 1 : y;
  const fy = endMonth <= 3 ? endYear : endYear + 1;
  const q = endMonth === 6 ? 1 : endMonth === 9 ? 2 : endMonth === 12 ? 3 : 4;
  return quarterPeriod(fy, q as 1 | 2 | 3 | 4);
}

/** Screener column header for a month end, e.g. 2027-03-31 -> "Mar 2027". */
export function screenerColumn(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  return `${MONTH_ABBR[m - 1]} ${y}`;
}

/** Quarter-end columns (screener "quarters" table) that make up the period, oldest first. */
export function quarterColumns(period: FiscalPeriod): string[] {
  const qs = period.kind === "Q" ? [period.index!] : period.kind === "H" ? (period.index === 1 ? [1, 2] : [3, 4]) : [1, 2, 3, 4];
  return qs.map((q) => screenerColumn(quarterPeriod(period.fy, q as 1 | 2 | 3 | 4).end));
}

export function previousYear(period: FiscalPeriod): FiscalPeriod {
  if (period.kind === "FY") return fiscalYearPeriod(period.fy - 1);
  if (period.kind === "H") return halfPeriod(period.fy - 1, period.index as 1 | 2);
  return quarterPeriod(period.fy - 1, period.index as 1 | 2 | 3 | 4);
}
