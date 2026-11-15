import type { GuidanceMetric } from "@finn/shared/contracts/research";
import { HISTORY_SOURCE_LABEL, valueAt, type HistoryTables, type RowKey } from "../financials/history";
import { previousYear, quarterColumns, screenerColumn, type FiscalPeriod } from "./periods";

export type ActualLookup =
  | { status: "ok"; value: number; period: string; source: string; detail: string }
  | { status: "not_available"; reason: string }
  | { status: "not_computable"; reason: string };

export type ActualsResolver = (metric: GuidanceMetric, period: FiscalPeriod) => ActualLookup;

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Sum of a row over the period: the annual column for FY when present, else the quarter columns. */
function periodSum(tables: HistoryTables, key: RowKey, period: FiscalPeriod): number | null {
  if (period.kind === "FY") {
    const annual = valueAt(tables.profit_loss, key, screenerColumn(period.end));
    if (annual !== null) return annual;
  }
  const cols = quarterColumns(period);
  let total = 0;
  for (const c of cols) {
    const v = valueAt(tables.quarters, key, c);
    if (v === null) return null;
    total += v;
  }
  return total;
}

function growth(tables: HistoryTables, key: RowKey, period: FiscalPeriod, what: string): ActualLookup {
  const cur = periodSum(tables, key, period);
  if (cur === null) return { status: "not_available", reason: `${what} for ${period.label} is not in the history tables yet` };
  const base = periodSum(tables, key, previousYear(period));
  if (base === null || base <= 0) return { status: "not_computable", reason: `no positive ${what} base for ${previousYear(period).label}` };
  return {
    status: "ok",
    value: round(((cur - base) / base) * 100),
    period: period.label,
    source: HISTORY_SOURCE_LABEL,
    detail: `${what} ₹${round(cur, 0)} Cr vs ₹${round(base, 0)} Cr in ${previousYear(period).label}`,
  };
}

/**
 * Same-period actuals from screener history tables. Full-year guidance is compared only with a full-year
 * figure, half-year with the two matching quarters, never a single quarter.
 */
export function createHistoryActuals(tables: HistoryTables): ActualsResolver {
  return (metric, period) => {
    switch (metric) {
      case "revenue_growth":
        return growth(tables, "revenue", period, "Revenue");
      case "pat_growth":
        return growth(tables, "netProfit", period, "Net profit");
      case "ebitda_margin": {
        const rev = periodSum(tables, "revenue", period);
        const op = periodSum(tables, "operatingProfit", period);
        if (rev === null || op === null) return { status: "not_available", reason: `EBITDA for ${period.label} is not in the history tables yet` };
        if (rev <= 0) return { status: "not_computable", reason: "revenue is zero or negative" };
        return {
          status: "ok",
          value: round((op / rev) * 100),
          period: period.label,
          source: HISTORY_SOURCE_LABEL,
          detail: `operating profit ₹${round(op, 0)} Cr on revenue ₹${round(rev, 0)} Cr`,
        };
      }
      case "capex": {
        if (period.kind !== "FY") return { status: "not_computable", reason: "capex is only available for full years" };
        const col = screenerColumn(period.end);
        const purchased = valueAt(tables.cash_flow, "fixedAssetsPurchased", col);
        if (purchased !== null) {
          return { status: "ok", value: round(Math.abs(purchased), 0), period: period.label, source: HISTORY_SOURCE_LABEL, detail: "fixed assets purchased" };
        }
        const cfo = valueAt(tables.cash_flow, "cfo", col);
        const fcf = valueAt(tables.cash_flow, "fcf", col);
        if (!tables.cash_flow) return { status: "not_computable", reason: "no cash-flow table" };
        if (cfo === null || fcf === null) return { status: "not_available", reason: `cash flow for ${period.label} is not in the history tables yet` };
        return { status: "ok", value: round(cfo - fcf, 0), period: period.label, source: HISTORY_SOURCE_LABEL, detail: "derived as cash from operations minus free cash flow" };
      }
      case "order_book":
      case "volume_growth":
      case "net_debt":
        return { status: "not_computable", reason: `${metric.replace("_", " ")} is not reported in the financial statements we hold` };
    }
  };
}
