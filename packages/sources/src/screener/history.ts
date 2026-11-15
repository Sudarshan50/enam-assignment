import type { HTMLElement } from "node-html-parser";
import type { ScreenerHistoryTable } from "../types";
import { collapseWhitespace as clean, parseLooseNumber } from "../util/values";

const SECTIONS: [string, ScreenerHistoryTable["statement"]][] = [
  ["quarters", "quarters"],
  ["profit-loss", "profit_loss"],
  ["balance-sheet", "balance_sheet"],
  ["cash-flow", "cash_flow"],
  ["ratios", "ratios"],
];

/** Figures are as screener shows them: Rs crore for amounts, plain numbers for % and days. */
export function parseScreenerHistory(root: HTMLElement): ScreenerHistoryTable[] {
  const tables: ScreenerHistoryTable[] = [];
  for (const [id, statement] of SECTIONS) {
    const section = root.querySelector(`section#${id}`);
    const table = section?.querySelector("[data-result-table] table") ?? section?.querySelector("table");
    if (!table) continue;
    const columns = table
      .querySelectorAll("thead th")
      .slice(1)
      .map((th) => clean(th.text));
    const rows: ScreenerHistoryTable["rows"] = [];
    for (const tr of table.querySelectorAll("tbody tr")) {
      const [labelCell, ...valueCells] = tr.querySelectorAll("td");
      // Rows of links (e.g. "Raw PDF") are not data.
      if (!labelCell || valueCells.some((td) => td.querySelector("a"))) continue;
      const label = rowLabel(labelCell);
      if (!label) continue;
      rows.push({ label, values: columns.map((_, i) => parseLooseNumber(clean(valueCells[i]?.text ?? ""))) });
    }
    tables.push({ statement, columns, rows });
  }
  return tables;
}

function rowLabel(cell: HTMLElement): string {
  for (const tip of cell.querySelectorAll(".has-tooltip, .tooltip")) tip.remove();
  return clean(cell.text).replace(/\s*\+$/, "");
}
