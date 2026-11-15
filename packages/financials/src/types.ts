import type { ResultsCard, StatementFamily } from "@finn/shared";

export type XbrlContext = "OneD" | "FourD" | "OneI" | "PY_I";

/** OneD is the quarter, FourD the year-to-date. They overlap and must never be summed. */
export type DurationContext = "OneD" | "FourD";

export interface XbrlFact {
  /** Local concept name without the namespace prefix, e.g. "RevenueFromOperations". */
  concept: string;
  context: XbrlContext;
  /** Value in rupees (or the raw unit for ratios/per-share). Never pre-scaled. */
  value: number;
  unit: string | null;
  decimals: string | null;
}

export interface ParsedFiling {
  statementFamily: StatementFamily;
  basis: "consolidated" | "standalone";
  audited: boolean;
  /** Quarter covered by the OneD context. */
  periodStart: string;
  periodEnd: string;
  /** Year-to-date window covered by FourD. */
  ytdStart: string | null;
  currency: string;
  facts: XbrlFact[];
  /** Facts by context then concept, for quick lookup. */
  byContext: Record<XbrlContext, Record<string, number>>;
  /** SEBI taxonomy, e.g. "IntegratedFinance_IndAS/2026-01-31". */
  taxonomy?: string;
  symbol?: string | null;
  companyName?: string | null;
}

export type HeadlineMetricKey =
  | "revenue"
  | "ebitda"
  | "pbt"
  | "pat"
  | "pat_owners"
  | "nii"
  | "ppop"
  | "provisions"
  | "total_income";

export interface HeadlineMetric {
  key: HeadlineMetricKey;
  label: string;
  value: number | null;
  derived: boolean;
  /** Concepts used to compute the value, for provenance. */
  concepts: string[];
}

export interface IdentityCheck {
  name: string;
  passed: boolean;
  expected: number | null;
  actual: number | null;
  tolerancePct: number;
}

export interface QuarterMetrics {
  periodEnd: string;
  statementFamily: StatementFamily;
  metrics: HeadlineMetric[];
  checks: IdentityCheck[];
}

export interface BuildResultsCardInput {
  current: ParsedFiling;
  previousQuarter: ParsedFiling | null;
  yearAgoQuarter: ParsedFiling | null;
  sourceRef: string;
  /** Provenance refs for the comparison filings (e.g. their XBRL URLs or seq ids). */
  previousQuarterRef?: string;
  yearAgoQuarterRef?: string;
}

export type BuildResultsCard = (input: BuildResultsCardInput) => ResultsCard;
