import { FinancialSnapshotPayloadSchema, type Claim } from "@finn/shared/contracts/research";
import { fiscalQuarterLabel } from "@finn/shared/format";
import { fmtCr, fmtPct, historyClaim } from "../financials/claims";
import { findRow, fyLabelOfColumn, HISTORY_SOURCE_LABEL, periodColumns, type HistoryTable, type RowKey } from "../financials/history";
import { insufficient, type ResearchModuleRunner } from "./types";
import type { z } from "zod";

type Payload = z.infer<typeof FinancialSnapshotPayloadSchema>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function quarterLabel(column: string): string {
  const [mon, year] = column.split(" ") as [string, string];
  const m = MONTHS.indexOf(mon) + 1;
  return fiscalQuarterLabel(`${year}-${String(m).padStart(2, "0")}-28`);
}

function series(table: HistoryTable, key: RowKey, columns: string[]): (number | null)[] {
  const row = findRow(table, key);
  return columns.map((c) => {
    const v = row?.[table.periods.indexOf(c)];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
}

function margins(op: (number | null)[], rev: (number | null)[]): (number | null)[] {
  return op.map((o, i) => {
    const r = rev[i];
    return o !== null && r !== null && r !== undefined && r > 0 ? Math.round((o / r) * 1000) / 10 : null;
  });
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

export const financialSnapshotModule: ResearchModuleRunner = {
  key: "financial_snapshot",
  version: "1",
  inputs: { documents: false, history: true },
  async run(ctx) {
    const pl = ctx.history.profit_loss;
    const q = ctx.history.quarters;
    if (!pl || periodColumns(pl).length < 2) return insufficient("No multi-year profit & loss history is available for this company.");

    const years = periodColumns(pl).slice(-6);
    const yLabels = years.map(fyLabelOfColumn);
    const rev = series(pl, "revenue", years);
    const op = series(pl, "operatingProfit", years);
    const pat = series(pl, "netProfit", years);
    const opm = margins(op, rev);

    const out: Payload = { headline: [], series: [], takeaways: [] };
    const points = (labels: string[], vals: (number | null)[]) => labels.map((period, i) => ({ period, value: vals[i] ?? null }));
    out.series.push(
      { key: "revenue_annual", label: "Revenue", unit: "inr_crore", source: HISTORY_SOURCE_LABEL, points: points(yLabels, rev) },
      { key: "ebitda_annual", label: "EBITDA (operating profit)", unit: "inr_crore", source: HISTORY_SOURCE_LABEL, points: points(yLabels, op) },
      { key: "pat_annual", label: "Net profit", unit: "inr_crore", source: HISTORY_SOURCE_LABEL, points: points(yLabels, pat) },
      { key: "ebitda_margin_annual", label: "EBITDA margin", unit: "pct", source: HISTORY_SOURCE_LABEL, points: points(yLabels, opm) },
    );

    const fy = last(yLabels)!;
    const head = (label: string, value: number | null | undefined, unit: string, period: string) =>
      out.headline.push({ label, value: value ?? null, unit, period, source: HISTORY_SOURCE_LABEL });
    head("Revenue", last(rev), "inr_crore", fy);
    head("EBITDA", last(op), "inr_crore", fy);
    head("Net profit", last(pat), "inr_crore", fy);
    head("EBITDA margin", last(opm), "pct", fy);

    const takeaways: Claim[] = [];
    const firstIdx = rev.findIndex((v) => v !== null && v > 0);
    const lastRev = last(rev);
    if (firstIdx >= 0 && lastRev != null && years.length - 1 - firstIdx >= 2) {
      const n = years.length - 1 - firstIdx;
      const cagr = ((lastRev / rev[firstIdx]!) ** (1 / n) - 1) * 100;
      takeaways.push(
        historyClaim(
          ctx.symbol,
          "profit_loss",
          `Revenue compounded at ${fmtPct(cagr)} a year over ${n} years, from ${fmtCr(rev[firstIdx]!)} in ${yLabels[firstIdx]} to ${fmtCr(lastRev)} in ${fy}.`,
          `Sales ${yLabels[firstIdx]}: ${rev[firstIdx]}; Sales ${fy}: ${lastRev}`,
        ),
      );
    }
    const opmFirst = opm.find((v) => v !== null);
    const opmLast = last(opm);
    if (opmFirst != null && opmLast != null && opm.length >= 3) {
      const diff = opmLast - opmFirst;
      takeaways.push(
        historyClaim(
          ctx.symbol,
          "profit_loss",
          `EBITDA margin ${Math.abs(diff) < 0.5 ? "held steady" : diff > 0 ? "expanded" : "contracted"} from ${fmtPct(opmFirst)} to ${fmtPct(opmLast)} over the period.`,
          `Operating profit / Sales, ${yLabels[opm.indexOf(opmFirst)]} and ${fy}`,
        ),
      );
    }

    if (q) {
      const qCols = periodColumns(q).slice(-12);
      const qLabels = qCols.map(quarterLabel);
      const qRev = series(q, "revenue", qCols);
      const qOp = series(q, "operatingProfit", qCols);
      const qPat = series(q, "netProfit", qCols);
      out.series.push(
        { key: "revenue_quarterly", label: "Quarterly revenue", unit: "inr_crore", source: HISTORY_SOURCE_LABEL, points: points(qLabels, qRev) },
        { key: "pat_quarterly", label: "Quarterly net profit", unit: "inr_crore", source: HISTORY_SOURCE_LABEL, points: points(qLabels, qPat) },
        { key: "ebitda_margin_quarterly", label: "Quarterly EBITDA margin", unit: "pct", source: HISTORY_SOURCE_LABEL, points: points(qLabels, margins(qOp, qRev)) },
      );
      const lq = last(qLabels);
      const lqRev = last(qRev);
      const lqPat = last(qPat);
      if (lq) {
        head("Quarterly revenue", lqRev, "inr_crore", lq);
        head("Quarterly net profit", lqPat, "inr_crore", lq);
      }
      const yoIdx = qRev.length - 5;
      const yoRev = yoIdx >= 0 ? qRev[yoIdx] : null;
      const yoPat = yoIdx >= 0 ? qPat[yoIdx] : null;
      if (lq && lqRev != null && yoRev != null && yoRev > 0) {
        const g = ((lqRev - yoRev) / yoRev) * 100;
        head("Quarterly revenue YoY", Math.round(g * 10) / 10, "pct", lq);
        const patPart =
          lqPat != null && yoPat != null && yoPat > 0 ? ` and net profit ${lqPat >= yoPat ? "grew" : "fell"} ${fmtPct(Math.abs(((lqPat - yoPat) / yoPat) * 100))}` : "";
        takeaways.push(
          historyClaim(
            ctx.symbol,
            "quarters",
            `In ${lq}, revenue ${g >= 0 ? "grew" : "fell"} ${fmtPct(Math.abs(g))} year on year to ${fmtCr(lqRev)}${patPart}.`,
            `Sales ${qLabels[yoIdx]}: ${yoRev}; Sales ${lq}: ${lqRev}`,
          ),
        );
      }
    }

    out.takeaways = takeaways;
    return { status: "done", payload: FinancialSnapshotPayloadSchema.parse(out) };
  },
};
