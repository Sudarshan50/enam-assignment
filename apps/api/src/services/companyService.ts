import { StatementFamilySchema, fiscalQuarterLabel } from "@finn/shared";
import type { CompanySearchResult, FinancialsResponse } from "../contracts";
import { notFound } from "../http/errors";
import { toIso, toIsoRequired } from "../lib/time";

export interface CompanyRow {
  symbol: string;
  name: string;
  statementFamily: string | null;
  isHolding: boolean;
}

export interface FilingRow {
  seqId: string;
  periodEnd: string;
  basis: "consolidated" | "standalone";
  statementFamily: string;
  audited: boolean;
  status: string;
  broadcastAt: Date | null;
  xbrlUrl: string;
  facts: { concept: string; context: string; value: number; derived: boolean }[];
}

export interface HistoryRow {
  statement: string;
  basis: "consolidated" | "standalone";
  periods: string[];
  rows: unknown;
  unit: string;
  source: string;
  fetchedAt: Date;
}

export interface CompanyRepository {
  search(q: string, limit: number): Promise<CompanyRow[]>;
  get(symbol: string): Promise<CompanyRow | null>;
  listFilings(symbol: string, limit: number): Promise<FilingRow[]>;
  listHistory(symbol: string): Promise<HistoryRow[]>;
}

export interface CompanyService {
  search(q: string): Promise<CompanySearchResult[]>;
  financials(symbol: string): Promise<FinancialsResponse>;
}

const XBRL_LABEL = "NSE integrated filing (XBRL), as filed";
const SCREENER_LABEL = "Standardised by screener.in from company filings";
const QUARTERS = 8;

function family(value: string | null) {
  const parsed = StatementFamilySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createCompanyService(repo: CompanyRepository): CompanyService {
  return {
    async search(q) {
      return (await repo.search(q, 10)).map((r) => ({
        symbol: r.symbol,
        name: r.name,
        statementFamily: family(r.statementFamily),
        isHolding: r.isHolding,
      }));
    },

    async financials(symbol) {
      const company = await repo.get(symbol);
      if (!company) throw notFound("Company");
      const [filings, history] = await Promise.all([repo.listFilings(symbol, QUARTERS * 2), repo.listHistory(symbol)]);

      // Never mix bases: consolidated when the company files it, otherwise standalone.
      const basis = filings.some((f) => f.basis === "consolidated") ? "consolidated" : filings.length ? "standalone" : null;
      const quarters = filings
        .filter((f) => f.basis === basis)
        .slice(0, QUARTERS)
        .map((f) => {
          const quarter: Record<string, number> = {};
          const yearToDate: Record<string, number> = {};
          const derived: string[] = [];
          for (const fact of f.facts) {
            if (fact.context === "OneD") quarter[fact.concept] = fact.value;
            else if (fact.context === "FourD") yearToDate[fact.concept] = fact.value;
            else continue;
            if (fact.derived && !derived.includes(fact.concept)) derived.push(fact.concept);
          }
          return {
            seqId: f.seqId,
            periodEnd: f.periodEnd,
            periodLabel: fiscalQuarterLabel(f.periodEnd),
            basis: f.basis,
            statementFamily: family(f.statementFamily) ?? "industrial",
            audited: f.audited,
            status: f.status,
            broadcastAt: toIso(f.broadcastAt),
            xbrlUrl: f.xbrlUrl,
            quarter,
            yearToDate,
            derived,
            source: "nse_xbrl" as const,
            sourceLabel: XBRL_LABEL,
          };
        });

      return {
        symbol: company.symbol,
        name: company.name,
        statementFamily: family(company.statementFamily),
        basis,
        quarters,
        history: history.map((h) => ({
          statement: h.statement,
          basis: h.basis,
          periods: h.periods,
          rows: h.rows,
          unit: h.unit,
          source: h.source,
          sourceLabel: h.source === "screener" ? SCREENER_LABEL : h.source,
          fetchedAt: toIsoRequired(h.fetchedAt),
        })),
      };
    },
  };
}
