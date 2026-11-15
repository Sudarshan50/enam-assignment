import type { HTMLElement } from "node-html-parser";
import { istDateString } from "@finn/shared/format";
import type { ScreenerDocKind, ScreenerDocumentLink } from "../types";
import { collapseWhitespace as clean } from "../util/values";

export const SCREENER_BASE = "https://www.screener.in";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const CONCALL_CHIPS: Record<string, { kind: ScreenerDocKind; label: string }> = {
  transcript: { kind: "concall_transcript", label: "Concall transcript" },
  ppt: { kind: "concall_ppt", label: "Concall presentation" },
  rec: { kind: "concall_recording", label: "Concall recording" },
};

/** Annual reports, concall links and credit-rating rationales from the #documents section. */
export function parseScreenerDocuments(root: HTMLElement, fetchedAt: Date): ScreenerDocumentLink[] {
  const section = root.querySelector("section#documents");
  if (!section) return [];
  const docs = [
    ...annualReports(section),
    ...concalls(section),
    ...creditRatings(section, fetchedAt),
  ];
  const seen = new Set<string>();
  return docs.filter((d) => {
    const key = `${d.kind}|${d.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function annualReports(section: HTMLElement): ScreenerDocumentLink[] {
  const out: ScreenerDocumentLink[] = [];
  for (const a of section.querySelectorAll(".annual-reports li a")) {
    const url = absoluteUrl(a.getAttribute("href"));
    const title = clean(a.text).replace(/\s*from\s+\w+$/i, "");
    const year = /\b(19|20)\d{2}\b/.exec(title)?.[0];
    if (!url || !year) continue;
    out.push({ kind: "annual_report", title, url, period: year });
  }
  return out;
}

function concalls(section: HTMLElement): ScreenerDocumentLink[] {
  const out: ScreenerDocumentLink[] = [];
  for (const li of section.querySelectorAll(".concalls li")) {
    const label = clean(li.querySelector("div.nowrap")?.text ?? li.querySelector("div")?.text ?? "");
    const period = monthYearToIso(label);
    if (!period) continue;
    for (const a of li.querySelectorAll("a")) {
      const chip = CONCALL_CHIPS[clean(a.text).toLowerCase()];
      const url = absoluteUrl(a.getAttribute("href"));
      if (!chip || !url) continue;
      out.push({ kind: chip.kind, title: `${chip.label} ${label}`, url, period });
    }
  }
  return out;
}

function creditRatings(section: HTMLElement, fetchedAt: Date): ScreenerDocumentLink[] {
  const out: ScreenerDocumentLink[] = [];
  for (const a of section.querySelectorAll(".credit-ratings li a")) {
    const url = absoluteUrl(a.getAttribute("href"));
    const meta = clean(a.querySelector("div")?.text ?? "");
    const heading = clean(a.text.replace(a.querySelector("div")?.text ?? "", "")) || "Credit rating";
    const m = /^(\d{1,2})\s+([A-Za-z]{3})(?:\s+(\d{4}))?(?:\s+from\s+(.+))?$/.exec(meta);
    if (!url || !m) continue;
    const period = dayMonthToIso(Number(m[1]), m[2]!, m[3] ? Number(m[3]) : null, fetchedAt);
    if (!period) continue;
    out.push({ kind: "credit_rating", title: m[4] ? `${heading} (${m[4]})` : heading, url, period });
  }
  return out;
}

/** "Oct 2026" -> "2026-10-01". */
export function monthYearToIso(label: string): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(label.trim());
  const month = m ? MONTHS[m[1]!.toLowerCase()] : undefined;
  if (!m || !month) return null;
  return `${m[2]}-${String(month).padStart(2, "0")}-01`;
}

/** Screener omits the year for dates in the current year; a date that would be in the future belongs to last year. */
function dayMonthToIso(day: number, mon: string, year: number | null, fetchedAt: Date): string | null {
  const month = MONTHS[mon.toLowerCase()];
  if (!month || day < 1 || day > 31) return null;
  const today = istDateString(fetchedAt);
  const iso = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (year !== null) return iso(year);
  const thisYear = Number(today.slice(0, 4));
  return iso(thisYear) > today ? iso(thisYear - 1) : iso(thisYear);
}

function absoluteUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, SCREENER_BASE);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
