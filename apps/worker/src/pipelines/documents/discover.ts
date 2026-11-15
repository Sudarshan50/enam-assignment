import { quarterDiscussedOn } from "@finn/ai/ledger/periods";
import { documentsRepo, type DocumentRow } from "@finn/db/repositories/documents";
import { historyRepo } from "@finn/db/repositories/history";
import { fetchScreenerCompany } from "@finn/sources/screener/company";
import type { ScreenerCompany, ScreenerDocumentLink } from "@finn/sources/types";
import type { WorkerContext } from "../../context";

export const MAX_ANNUAL_REPORTS = 2;
export const MAX_TRANSCRIPTS = 8;

export interface DiscoveryResult {
  documents: DocumentRow[];
  historyTables: number;
  basis: ScreenerCompany["basis"] | null;
  error: string | null;
}

function annualReportPeriod(link: ScreenerDocumentLink): { label: string; end: string } | null {
  const year = Number(/\b(19|20)\d{2}\b/.exec(link.period)?.[0]);
  if (!year) return null;
  return { label: `FY${String(year).slice(-2)}`, end: `${year}-03-31` };
}

function callDate(link: ScreenerDocumentLink): string | null {
  return /^\d{4}-\d{2}(-\d{2})?$/.test(link.period) ? (link.period.length === 7 ? `${link.period}-01` : link.period) : null;
}

/** Picks the latest annual reports and concall transcripts from screener's document list. */
export function selectDocuments(symbol: string, links: ScreenerDocumentLink[]) {
  const ars = links
    .filter((l) => l.kind === "annual_report")
    .map((l) => ({ l, p: annualReportPeriod(l) }))
    .filter((x): x is { l: ScreenerDocumentLink; p: { label: string; end: string } } => x.p !== null)
    .sort((a, b) => b.p.end.localeCompare(a.p.end))
    .slice(0, MAX_ANNUAL_REPORTS)
    .map(({ l, p }) => ({ symbol, docType: "annual_report" as const, periodLabel: p.label, periodEnd: p.end, url: l.url }));

  const seenQuarter = new Set<string>();
  const transcripts = links
    .filter((l) => l.kind === "concall_transcript")
    .map((l) => ({ l, date: callDate(l) }))
    .filter((x): x is { l: ScreenerDocumentLink; date: string } => x.date !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter(({ date }) => {
      const q = quarterDiscussedOn(date).label;
      if (seenQuarter.has(q)) return false;
      seenQuarter.add(q);
      return true;
    })
    .slice(0, MAX_TRANSCRIPTS)
    .map(({ l, date }) => ({ symbol, docType: "transcript" as const, periodLabel: quarterDiscussedOn(date).label, periodEnd: date, url: l.url }));

  return [...ars, ...transcripts];
}

/**
 * Fetches the screener company page, upserts the selected documents (status `discovered` for new rows) and
 * stores the history tables. If screener is unreachable, previously discovered documents are still returned.
 */
export async function discoverDocuments(ctx: WorkerContext, symbol: string): Promise<DiscoveryResult> {
  const docs = documentsRepo(ctx.sql);
  const history = historyRepo(ctx.sql);
  let company: ScreenerCompany;
  try {
    company = await fetchScreenerCompany(ctx.http, symbol);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.warn({ symbol, error: message }, "screener fetch failed; using documents already known");
    const known = (await docs.listBySymbol(symbol)).filter((d) => d.doc_type === "annual_report" || d.doc_type === "transcript");
    return { documents: known, historyTables: 0, basis: null, error: message };
  }

  let historyTables = 0;
  for (const t of company.history) {
    if (t.rows.length === 0) continue;
    await history.upsert({ symbol, statement: t.statement, basis: company.basis, periods: t.columns, rows: t.rows });
    historyTables++;
  }

  const selected = selectDocuments(symbol, company.documents);
  const rows: DocumentRow[] = [];
  for (const d of selected) rows.push(await docs.upsertDiscovered(d));
  return { documents: rows, historyTables, basis: company.basis, error: null };
}
