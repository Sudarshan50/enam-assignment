import { CashQualityPayloadSchema, type Claim } from "@finn/shared/contracts/research";
import type { z } from "zod";
import { fmtCr, historyClaim } from "../financials/claims";
import { fyLabelOfColumn, periodColumns, valueAt, type HistoryTables } from "../financials/history";
import { insufficient, type ResearchModuleRunner } from "./types";

type Payload = z.infer<typeof CashQualityPayloadSchema>;
type Period = Payload["periods"][number];

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface CashYear extends Period {
  column: string;
  ebitda: number | null;
  cfoToEbitda: number | null;
  workingCapitalDays: number | null;
}

/** Full-year cash metrics (cash flow is only filed at H1/FY; screener carries the FY figures). */
export function cashYears(tables: HistoryTables, maxYears = 5): CashYear[] {
  const { cash_flow: cf, profit_loss: pl, balance_sheet: bs, ratios } = tables;
  const cols = periodColumns(cf).filter((c) => periodColumns(pl).includes(c)).slice(-maxYears);
  return cols.map((col) => {
    const cfo = valueAt(cf, "cfo", col);
    const pat = valueAt(pl, "netProfit", col);
    const ebitda = valueAt(pl, "operatingProfit", col);
    const fcfRow = valueAt(cf, "fcf", col);
    const purchased = valueAt(cf, "fixedAssetsPurchased", col);
    const capex = purchased !== null ? Math.abs(purchased) : cfo !== null && fcfRow !== null ? cfo - fcfRow : null;
    const fcf = fcfRow ?? (cfo !== null && capex !== null ? cfo - capex : null);
    const equity = (valueAt(bs, "equityCapital", col) ?? 0) + (valueAt(bs, "reserves", col) ?? 0);
    const borrowings = valueAt(bs, "borrowings", col);
    const wcDays = valueAt(ratios, "workingCapitalDays", col);
    const notes: string[] = [];
    let cashConversion: number | null = null;
    if (cfo !== null && pat !== null) {
      if (pat > 0) cashConversion = r2(cfo / pat);
      else notes.push("CFO/PAT n/m (PAT ≤ 0)");
    }
    const cfoToEbitda = cfo !== null && ebitda !== null && ebitda > 0 ? r2(cfo / ebitda) : null;
    if (cfoToEbitda !== null) notes.push(`CFO/EBITDA ${cfoToEbitda.toFixed(2)}`);
    if (wcDays !== null) notes.push(`working-capital days ${Math.round(wcDays)}`);
    if (capex !== null && purchased === null) notes.push("capex derived as CFO − FCF");
    let debtToEquity: number | null = null;
    if (borrowings !== null && bs) {
      if (equity > 0) debtToEquity = r2(borrowings / equity);
      else notes.push("D/E n/m (equity ≤ 0)");
    }
    return {
      column: col,
      period: fyLabelOfColumn(col),
      cfo,
      pat,
      cashConversion,
      capex: capex === null ? null : Math.round(capex),
      fcf: fcf === null ? null : Math.round(fcf),
      debtToEquity,
      note: notes.length ? notes.join("; ") : null,
      ebitda,
      cfoToEbitda,
      workingCapitalDays: wcDays,
    };
  });
}

export const cashQualityModule: ResearchModuleRunner = {
  key: "cash_quality",
  version: "1",
  inputs: { documents: false, history: true },
  async run(ctx) {
    if (!ctx.history.cash_flow || !ctx.history.profit_loss) return insufficient("No cash-flow history is available for this company.");
    const years = cashYears(ctx.history);
    if (years.length < 2) return insufficient("Fewer than two years of cash-flow history are available.");

    const takeaways: Claim[] = [];
    const span = `${years[0]!.period}–${years[years.length - 1]!.period}`;
    const sum = (k: "cfo" | "pat" | "ebitda" | "fcf") => years.reduce<number | null>((s, y) => (s === null || y[k] === null ? null : s + (y[k] as number)), 0);
    const cfo = sum("cfo");
    const pat = sum("pat");
    const ebitda = sum("ebitda");
    const fcf = sum("fcf");
    if (cfo !== null && pat !== null && pat > 0) {
      const ratio = cfo / pat;
      takeaways.push(
        historyClaim(
          ctx.symbol,
          "cash_flow",
          `Over ${span}, cumulative cash from operations of ${fmtCr(cfo)} was ${ratio.toFixed(2)}x cumulative net profit of ${fmtCr(pat)}${ratio < 0.8 ? ", a weak conversion of profit into cash" : ratio > 1.1 ? ", ahead of reported profit" : ""}.`,
          `Cash from Operating Activity and Net Profit, ${span}`,
        ),
      );
    }
    if (cfo !== null && ebitda !== null && ebitda > 0) {
      const ratio = cfo / ebitda;
      takeaways.push(
        historyClaim(
          ctx.symbol,
          "cash_flow",
          `Operating cash flow covered ${(ratio * 100).toFixed(0)}% of EBITDA over ${span}${ratio < 0.7 ? "; working capital or taxes absorb a large share of operating profit" : ""}.`,
          `Cash from Operating Activity / Operating Profit, ${span}`,
        ),
      );
    }
    if (fcf !== null) {
      const negYears = years.filter((y) => y.fcf !== null && y.fcf < 0).map((y) => y.period);
      takeaways.push(
        historyClaim(
          ctx.symbol,
          "cash_flow",
          `Free cash flow totalled ${fmtCr(fcf)} over ${span}${negYears.length ? `, negative in ${negYears.join(", ")}` : ", positive every year"}.`,
          `Free Cash Flow, ${span}`,
        ),
      );
    }
    const wc = years.filter((y) => y.workingCapitalDays !== null);
    if (wc.length >= 3) {
      const a = wc[0]!;
      const b = wc[wc.length - 1]!;
      const change = b.workingCapitalDays! - a.workingCapitalDays!;
      if (Math.abs(change) >= 10) {
        takeaways.push(
          historyClaim(
            ctx.symbol,
            "ratios",
            `Working-capital days ${change > 0 ? "rose" : "fell"} from ${Math.round(a.workingCapitalDays!)} in ${a.period} to ${Math.round(b.workingCapitalDays!)} in ${b.period}.`,
            `Working Capital Days, ${a.period} and ${b.period}`,
          ),
        );
      }
    }

    const payload: Payload = {
      periods: years.map(({ period, cfo, pat, cashConversion, capex, fcf, debtToEquity, note }) => ({ period, cfo, pat, cashConversion, capex, fcf, debtToEquity, note })),
      takeaways,
    };
    return { status: "done", payload: CashQualityPayloadSchema.parse(payload) };
  },
};
