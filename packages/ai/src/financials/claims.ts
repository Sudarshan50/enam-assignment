import type { Claim } from "@finn/shared/contracts/research";
import type { HistoryTable } from "./history";

const STATEMENT_LABEL: Record<HistoryTable["statement"], string> = {
  profit_loss: "screener.in profit & loss (secondary)",
  quarters: "screener.in quarterly results (secondary)",
  balance_sheet: "screener.in balance sheet (secondary)",
  cash_flow: "screener.in cash flow (secondary)",
  ratios: "screener.in ratios (secondary)",
};

/**
 * A deterministic takeaway computed from history tables. It cites the table row it was computed from, so the
 * UI can show the provenance, and is grounded by construction (no model involved).
 */
export function historyClaim(symbol: string, statement: HistoryTable["statement"], text: string, quote: string): Claim {
  return {
    text,
    grounded: true,
    citations: [
      {
        chunkId: `history:${symbol}:${statement}`,
        documentId: `history:${symbol}`,
        documentLabel: STATEMENT_LABEL[statement],
        page: null,
        quote,
        url: `https://www.screener.in/company/${encodeURIComponent(symbol)}/consolidated/`,
      },
    ],
  };
}

export function fmtCr(v: number): string {
  return `₹${Math.round(v).toLocaleString("en-IN")} Cr`;
}

export function fmtPct(v: number, digits = 1): string {
  return `${v.toFixed(digits)}%`;
}
