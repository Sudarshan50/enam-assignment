import type { Sql } from "../client";

export type HistoryStatement = "quarters" | "profit_loss" | "balance_sheet" | "cash_flow" | "ratios";

export interface HistoryRowValues {
  label: string;
  values: (number | null)[];
}

export interface HistoryTableRow {
  symbol: string;
  statement: HistoryStatement;
  basis: "consolidated" | "standalone";
  periods: string[];
  rows: HistoryRowValues[];
  unit: string;
  source: string;
  fetched_at: Date;
}

export function historyRepo(sql: Sql) {
  return {
    async upsert(table: Omit<HistoryTableRow, "fetched_at" | "unit" | "source"> & { unit?: string; source?: string }): Promise<void> {
      await sql`
        INSERT INTO history_financials (symbol, statement, basis, periods, rows, unit, source, fetched_at)
        VALUES (${table.symbol}, ${table.statement}, ${table.basis}, ${table.periods},
                ${sql.json(table.rows as unknown as Parameters<typeof sql.json>[0])}, ${table.unit ?? "INR_CRORE"},
                ${table.source ?? "screener"}, now())
        ON CONFLICT (symbol, statement, basis) DO UPDATE SET
          periods = EXCLUDED.periods, rows = EXCLUDED.rows, unit = EXCLUDED.unit, source = EXCLUDED.source, fetched_at = now()`;
    },

    /** Tables for a symbol, preferring consolidated when both bases exist. */
    async listForSymbol(symbol: string): Promise<HistoryTableRow[]> {
      const rows = await sql<HistoryTableRow[]>`
        SELECT * FROM history_financials WHERE symbol = ${symbol}
        ORDER BY statement, (basis = 'consolidated') DESC`;
      const seen = new Set<string>();
      return rows.filter((r) => (seen.has(r.statement) ? false : (seen.add(r.statement), true)));
    },
  };
}

export type HistoryRepo = ReturnType<typeof historyRepo>;
