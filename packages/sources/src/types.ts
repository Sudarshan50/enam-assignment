import type { StatementFamily } from "@finn/shared";

/** One row of the NSE market-wide corporate-announcements feed, normalised. */
export interface RawAnnouncement {
  seqId: string;
  symbol: string;
  companyName: string;
  isin: string | null;
  industry: string | null;
  /** NSE's own subject bucket, e.g. "Outcome of Board Meeting". */
  subject: string;
  /** Free-text description of the filing. */
  text: string;
  /** Exchange-generated summary when present (labelled as exchange-provided in the UI). */
  exchangeSummary: string | null;
  attachmentUrl: string | null;
  attachmentSizeKb: number | null;
  hasXbrl: boolean;
  publishedAt: Date;
  raw: Record<string, unknown>;
}

/** One row from NSE `integrated-filing-results` (the index of quarterly XBRL filings). */
export interface IntegratedFilingRef {
  seqId: string;
  symbol: string;
  companyName: string;
  periodEnd: string; // ISO date, e.g. 2026-09-30
  basis: "consolidated" | "standalone";
  audited: boolean;
  revision: "original" | "revised";
  xbrlUrl: string;
  ixbrlUrl: string | null;
  broadcastAt: Date;
  /** Inferred from the XBRL filename: INDAS -> industrial, BANKING -> banking, NBFC_INDAS -> nbfc. */
  statementFamily: StatementFamily;
}

/** One equity row from the NSE CM bhavcopy (UDiFF format). */
export interface BhavRow {
  symbol: string;
  series: string;
  isin: string;
  sessionDate: string; // ISO date
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  volume: number;
  turnover: number;
  trades: number;
}

/** The filings a results card needs, all on the same basis. Any slot can be missing. */
export interface FilingSelection {
  basis: "consolidated" | "standalone";
  current: IntegratedFilingRef | null;
  previousQuarter: IntegratedFilingRef | null;
  yearAgoQuarter: IntegratedFilingRef | null;
}

/** Yahoo daily bar shaped like a BhavRow; fields Yahoo does not provide are null. */
export interface YahooDailyRow extends Omit<BhavRow, "isin" | "turnover" | "trades"> {
  isin: null;
  turnover: null;
  trades: null;
  source: "yahoo";
}

export interface MasterListEntry {
  symbol: string;
  name: string;
  series: string;
  isin: string;
  listedOn: string | null;
  faceValue: number | null;
}

export type ScreenerDocKind =
  | "annual_report"
  | "concall_transcript"
  | "concall_ppt"
  | "concall_recording"
  | "credit_rating";

export interface ScreenerDocumentLink {
  kind: ScreenerDocKind;
  title: string;
  url: string;
  /** Fiscal year for annual reports (e.g. 2026) or the call date (ISO) for concalls. */
  period: string;
}

export interface ScreenerHistoryTable {
  statement: "profit_loss" | "quarters" | "balance_sheet" | "cash_flow" | "ratios";
  columns: string[]; // e.g. ["Mar 2016", ..., "Mar 2026", "TTM"]
  rows: { label: string; values: (number | null)[] }[];
}

export interface ScreenerCompany {
  symbol: string;
  basis: "consolidated" | "standalone";
  documents: ScreenerDocumentLink[];
  history: ScreenerHistoryTable[];
  fetchedAt: Date;
}

export interface PdfPage {
  page: number; // 1-based
  text: string;
}
