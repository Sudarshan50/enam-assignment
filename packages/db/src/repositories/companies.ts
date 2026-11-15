import type { StatementFamily } from "@finn/shared/taxonomy";
import type { Sql } from "../client";

export interface CompanyRow {
  symbol: string;
  name: string;
  isin: string | null;
  series: string | null;
  statementFamily: StatementFamily | null;
  screenerSlug: string | null;
  sector: string | null;
}

export interface MasterListUpsert {
  symbol: string;
  name: string;
  isin: string | null;
  series: string | null;
  /** Used only when the company is new; an existing family (seeded or learned from XBRL) is never overwritten. */
  statementFamily: StatementFamily | null;
}

const BATCH = 1000;

export function companiesRepo(sql: Sql) {
  const select = () => sql`
    symbol, name, isin, series, statement_family AS "statementFamily", screener_slug AS "screenerSlug", sector`;

  return {
    async get(symbol: string): Promise<CompanyRow | null> {
      const [row] = await sql<CompanyRow[]>`SELECT ${select()} FROM companies WHERE symbol = ${symbol.toUpperCase()}`;
      return row ?? null;
    },

    async getMany(symbols: readonly string[]): Promise<CompanyRow[]> {
      if (symbols.length === 0) return [];
      return sql<CompanyRow[]>`SELECT ${select()} FROM companies WHERE symbol = ANY(${symbols.map((s) => s.toUpperCase())}) ORDER BY symbol`;
    },

    async listAll(): Promise<CompanyRow[]> {
      return sql<CompanyRow[]>`SELECT ${select()} FROM companies ORDER BY symbol`;
    },

    async exists(symbol: string): Promise<boolean> {
      const [row] = await sql<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM companies WHERE symbol = ${symbol.toUpperCase()}) AS ok`;
      return row?.ok ?? false;
    },

    async listHoldingSymbols(): Promise<string[]> {
      const rows = await sql<{ symbol: string }[]>`SELECT symbol FROM holdings ORDER BY symbol`;
      return rows.map((r) => r.symbol);
    },

    /**
     * Companies FINN actively follows: holdings, curated research names (they carry a screener slug)
     * and anything that has been researched. Master-list-only rows are excluded so ingestion and EOD
     * stay focused and the LLM budget isn't spent on 2,000 untracked tickers.
     */
    async listTracked(): Promise<CompanyRow[]> {
      return sql<CompanyRow[]>`
        SELECT ${select()} FROM companies c
        WHERE EXISTS (SELECT 1 FROM holdings h WHERE h.symbol = c.symbol)
           OR c.screener_slug IS NOT NULL
           OR EXISTS (SELECT 1 FROM research_runs r WHERE r.symbol = c.symbol)
        ORDER BY symbol`;
    },

    async familyMap(): Promise<Map<string, StatementFamily | null>> {
      const rows = await sql<{ symbol: string; statementFamily: StatementFamily | null }[]>`
        SELECT symbol, statement_family AS "statementFamily" FROM companies`;
      return new Map(rows.map((r) => [r.symbol, r.statementFamily]));
    },

    async symbolsInFamily(family: StatementFamily, trackedOnly = true): Promise<string[]> {
      const rows = trackedOnly
        ? await sql<{ symbol: string }[]>`
            SELECT symbol FROM companies c WHERE statement_family = ${family}
              AND (EXISTS (SELECT 1 FROM holdings h WHERE h.symbol = c.symbol) OR c.screener_slug IS NOT NULL)
            ORDER BY symbol`
        : await sql<{ symbol: string }[]>`SELECT symbol FROM companies WHERE statement_family = ${family} ORDER BY symbol`;
      return rows.map((r) => r.symbol);
    },

    /** Bulk upsert from the NSE equity master list. Curated names and families are preserved. */
    async upsertMasterList(entries: readonly MasterListUpsert[]): Promise<number> {
      let written = 0;
      for (let i = 0; i < entries.length; i += BATCH) {
        const rows = entries.slice(i, i + BATCH).map((e) => ({
          symbol: e.symbol.toUpperCase(),
          name: e.name,
          isin: e.isin,
          series: e.series,
          statement_family: e.statementFamily,
        }));
        const result = await sql`
          INSERT INTO companies ${sql(rows, "symbol", "name", "isin", "series", "statement_family")}
          ON CONFLICT (symbol) DO UPDATE SET
            isin = EXCLUDED.isin,
            series = EXCLUDED.series,
            statement_family = COALESCE(companies.statement_family, EXCLUDED.statement_family),
            updated_at = now()
          WHERE companies.isin IS DISTINCT FROM EXCLUDED.isin
             OR companies.series IS DISTINCT FROM EXCLUDED.series
             OR companies.statement_family IS NULL`;
        written += result.count ?? 0;
      }
      return written;
    },

    /** Learned from the XBRL filename, which is authoritative over sector heuristics. */
    async setStatementFamily(symbol: string, family: StatementFamily): Promise<void> {
      await sql`
        UPDATE companies SET statement_family = ${family}, updated_at = now()
        WHERE symbol = ${symbol.toUpperCase()} AND statement_family IS DISTINCT FROM ${family}`;
    },

    async count(): Promise<number> {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM companies`;
      return row?.n ?? 0;
    },
  };
}

export type CompaniesRepo = ReturnType<typeof companiesRepo>;
