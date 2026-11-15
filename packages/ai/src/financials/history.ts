/** Read helpers over screener-standardised history tables (values in ₹ crore). */
export interface HistoryTable {
  statement: "quarters" | "profit_loss" | "balance_sheet" | "cash_flow" | "ratios";
  periods: string[];
  rows: { label: string; values: (number | null)[] }[];
}

export type HistoryTables = Partial<Record<HistoryTable["statement"], HistoryTable>>;

export const HISTORY_SOURCE_LABEL = "screener.in, standardised from company filings (secondary)";

export function labelKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/\+$/, "")
    .replace(/[^a-z0-9%]/g, "");
}

/** Row aliases across industrial, bank and NBFC layouts on screener. */
export const ROW_ALIASES = {
  revenue: ["sales", "revenue", "revenuefromoperations", "totalrevenue"],
  operatingProfit: ["operatingprofit", "financingprofit"],
  opm: ["opm%", "financingmargin%"],
  otherIncome: ["otherincome"],
  interest: ["interest"],
  depreciation: ["depreciation"],
  pbt: ["profitbeforetax"],
  netProfit: ["netprofit", "profitaftertax", "pat"],
  cfo: ["cashfromoperatingactivity", "cashfromoperatingactivities"],
  cfi: ["cashfrominvestingactivity", "cashfrominvestingactivities"],
  fcf: ["freecashflow"],
  fixedAssetsPurchased: ["fixedassetspurchased", "purchaseoffixedassets"],
  cfoToEbitda: ["cfoebitda", "cfoebitda%"],
  equityCapital: ["equitycapital"],
  reserves: ["reserves"],
  borrowings: ["borrowings", "borrowing"],
  debtorDays: ["debtordays"],
  inventoryDays: ["inventorydays"],
  daysPayable: ["dayspayable"],
  cashConversionCycle: ["cashconversioncycle"],
  workingCapitalDays: ["workingcapitaldays"],
  roce: ["roce%"],
} as const satisfies Record<string, readonly string[]>;

export type RowKey = keyof typeof ROW_ALIASES;

export function findRow(table: HistoryTable | undefined, key: RowKey): (number | null)[] | null {
  if (!table) return null;
  const aliases = ROW_ALIASES[key] as readonly string[];
  const keyed = table.rows.map((row) => ({ k: labelKey(row.label), values: row.values }));
  // Screener appends explanations to some labels ("CFO/EBITDA Share of operating profit..."), so fall back to a prefix match.
  const exact = keyed.find((r) => aliases.includes(r.k));
  if (exact) return exact.values;
  return keyed.find((r) => aliases.some((a) => r.k.startsWith(a)))?.values ?? null;
}

export function valueAt(table: HistoryTable | undefined, key: RowKey, column: string): number | null {
  if (!table) return null;
  const idx = table.periods.indexOf(column);
  if (idx < 0) return null;
  const v = findRow(table, key)?.[idx];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Columns that are fiscal periods ("Mar 2026"), excluding TTM and other summary columns. */
export function periodColumns(table: HistoryTable | undefined): string[] {
  return (table?.periods ?? []).filter((p) => /^[A-Z][a-z]{2} \d{4}$/.test(p));
}

/** "Mar 2026" -> "FY26"; other month-ends map to the fiscal year they fall in. */
export function fyLabelOfColumn(column: string): string {
  const [mon, year] = column.split(" ") as [string, string];
  const monthIdx = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(mon);
  const y = Number(year);
  const fy = monthIdx >= 3 ? y + 1 : y;
  return `FY${String(fy).slice(-2)}`;
}

export function tablesFromRows(rows: HistoryTable[]): HistoryTables {
  const out: HistoryTables = {};
  for (const r of rows) out[r.statement] = r;
  return out;
}
