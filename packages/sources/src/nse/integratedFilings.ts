import { istDateString, parseNseDate } from "@finn/shared/format";
import type { StatementFamily } from "@finn/shared/taxonomy";
import type { HttpClient } from "../http/client";
import type { FilingSelection, IntegratedFilingRef } from "../types";
import { nseRows, str } from "../util/values";
import { NSE_API_BASE, NSE_API_HEADERS } from "./endpoints";
import { shiftQuarterEnd } from "./quarterEnds";

const FINANCIALS_TYPE_PREFIX = "Integrated Filing- Financials";

/** NBFC_INDAS must be tested before INDAS, since the latter is a suffix of the former. */
const FAMILY_BY_FILENAME: [RegExp, StatementFamily][] = [
  [/INTEGRATED_FILING_NBFC_INDAS_/i, "nbfc"],
  [/INTEGRATED_FILING_BANKING_/i, "banking"],
  [/INTEGRATED_FILING_INDAS_/i, "industrial"],
];

export function familyFromXbrlUrl(url: string): StatementFamily | null {
  const file = url.split("/").pop() ?? "";
  return FAMILY_BY_FILENAME.find(([re]) => re.test(file))?.[1] ?? null;
}

/**
 * Keeps financial-results rows whose XBRL family we can parse. Rows for other templates
 * (e.g. insurance) are dropped because no statement strategy exists for them.
 */
export function parseIntegratedFilingList(json: unknown): IntegratedFilingRef[] {
  const rows = nseRows(json);
  if (!rows) throw new Error("Unexpected integrated-filing payload: expected an array or { data: [] }");

  const bySeq = new Map<string, IntegratedFilingRef>();
  for (const row of rows) {
    const ref = toRef(row);
    if (ref && !bySeq.has(ref.seqId)) bySeq.set(ref.seqId, ref);
  }
  return [...bySeq.values()];
}

function toRef(row: Record<string, unknown>): IntegratedFilingRef | null {
  if (!(str(row.type) ?? "").startsWith(FINANCIALS_TYPE_PREFIX)) return null;
  const seqId = str(row.seq_Id);
  const symbol = str(row.symbol);
  const xbrlUrl = str(row.xbrl);
  const qeDate = parseNseDate(str(row.qe_Date) ?? "");
  const broadcastAt = parseNseDate(str(row.broadcast_Date) ?? "") ?? parseNseDate(str(row.creation_Date) ?? "");
  const basis = parseBasis(str(row.consolidated));
  if (!seqId || !symbol || !xbrlUrl || !qeDate || !broadcastAt || !basis) return null;
  const family = familyFromXbrlUrl(xbrlUrl);
  if (!family) return null;

  return {
    seqId,
    symbol,
    companyName: str(row.cmName) ?? str(row.smName) ?? symbol,
    periodEnd: istDateString(qeDate),
    basis,
    audited: str(row.audited) === "Audited",
    revision: /revis/i.test(str(row.type_Sub) ?? "") ? "revised" : "original",
    xbrlUrl,
    ixbrlUrl: usableUrl(str(row.ixbrl)),
    broadcastAt,
    statementFamily: family,
  };
}

function parseBasis(value: string | null): IntegratedFilingRef["basis"] | null {
  const v = value?.toLowerCase();
  return v === "consolidated" ? "consolidated" : v === "standalone" ? "standalone" : null;
}

function usableUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) && !url.endsWith("/null") ? url : null;
}

export function integratedFilingsUrl(symbol: string): string {
  const params = new URLSearchParams({
    index: "equities",
    symbol,
    period_ended: "all",
    type: FINANCIALS_TYPE_PREFIX,
  });
  return `${NSE_API_BASE}/integrated-filing-results?${params.toString().replace(/\+/g, "%20")}`;
}

export async function listIntegratedFilings(http: HttpClient, symbol: string): Promise<IntegratedFilingRef[]> {
  return parseIntegratedFilingList(await http.getJson<unknown>(integratedFilingsUrl(symbol), NSE_API_HEADERS));
}

export function fetchXbrl(http: HttpClient, url: string): Promise<string> {
  return http.getText(url, NSE_API_HEADERS);
}

/**
 * Picks the current, previous-quarter and year-ago filings on one basis. Consolidated wins when
 * the current period has it (unless `basis` is forced); comparisons never mix bases.
 */
export function selectFilingsForCard(
  refs: IntegratedFilingRef[],
  periodEnd: string,
  basis?: IntegratedFilingRef["basis"],
): FilingSelection {
  const chosenBasis = basis ?? preferredBasis(refs, periodEnd);
  return {
    basis: chosenBasis,
    current: bestFor(refs, periodEnd, chosenBasis),
    previousQuarter: bestFor(refs, shiftQuarterEnd(periodEnd, -1), chosenBasis),
    yearAgoQuarter: bestFor(refs, shiftQuarterEnd(periodEnd, -4), chosenBasis),
  };
}

export function latestPeriodEnd(refs: IntegratedFilingRef[]): string | null {
  return refs.reduce<string | null>((max, r) => (max === null || r.periodEnd > max ? r.periodEnd : max), null);
}

function preferredBasis(refs: IntegratedFilingRef[], periodEnd: string): IntegratedFilingRef["basis"] {
  const hasConsolidated = bestFor(refs, periodEnd, "consolidated") !== null;
  const hasStandalone = bestFor(refs, periodEnd, "standalone") !== null;
  return !hasConsolidated && hasStandalone ? "standalone" : "consolidated";
}

function bestFor(refs: IntegratedFilingRef[], periodEnd: string, basis: IntegratedFilingRef["basis"]): IntegratedFilingRef | null {
  const candidates = refs.filter((r) => r.periodEnd === periodEnd && r.basis === basis);
  candidates.sort((a, b) => {
    if (a.revision !== b.revision) return a.revision === "revised" ? -1 : 1;
    return b.broadcastAt.getTime() - a.broadcastAt.getTime();
  });
  return candidates[0] ?? null;
}
