import type { Sql } from "@finn/db";
import type { CompanyRepository, CompanyRow, FilingRow, HistoryRow } from "../services/companyService";
import { escapeLike } from "./sql";

export function createCompaniesRepository(sql: Sql): CompanyRepository {
  return {
    async search(q, limit) {
      const upper = q.toUpperCase();
      const prefix = `${escapeLike(upper)}%`;
      const contains = `%${escapeLike(q)}%`;
      return sql<CompanyRow[]>`
        SELECT c.symbol, c.name, c.statement_family AS "statementFamily",
               EXISTS (SELECT 1 FROM holdings h WHERE h.symbol = c.symbol) AS "isHolding"
        FROM companies c
        WHERE c.symbol LIKE ${prefix} OR c.name ILIKE ${contains}
        ORDER BY (c.symbol = ${upper}) DESC, (c.symbol LIKE ${prefix}) DESC, length(c.symbol), c.symbol
        LIMIT ${limit}`;
    },

    async get(symbol) {
      const [row] = await sql<CompanyRow[]>`
        SELECT c.symbol, c.name, c.statement_family AS "statementFamily",
               EXISTS (SELECT 1 FROM holdings h WHERE h.symbol = c.symbol) AS "isHolding"
        FROM companies c WHERE c.symbol = ${symbol}`;
      return row ?? null;
    },

    async listFilings(symbol, limit) {
      // Latest revision per (period, basis).
      return sql<FilingRow[]>`
        SELECT * FROM (
          SELECT DISTINCT ON (f.period_end, f.basis)
            f.seq_id AS "seqId", f.period_end::text AS "periodEnd", f.basis, f.statement_family AS "statementFamily",
            f.audited, f.status, f.broadcast_at AS "broadcastAt", f.xbrl_url AS "xbrlUrl",
            COALESCE((
              SELECT json_agg(json_build_object('concept', ff.concept, 'context', ff.context, 'value', ff.value::float8, 'derived', ff.derived))
              FROM financial_facts ff WHERE ff.filing_seq_id = f.seq_id
            ), '[]'::json) AS facts
          FROM quarterly_filings f
          WHERE f.symbol = ${symbol}
          ORDER BY f.period_end DESC, f.basis, f.broadcast_at DESC NULLS LAST, f.created_at DESC
        ) latest
        ORDER BY "periodEnd" DESC
        LIMIT ${limit}`;
    },

    async listHistory(symbol) {
      return sql<HistoryRow[]>`
        SELECT statement, basis, periods, rows, unit, source, fetched_at AS "fetchedAt"
        FROM history_financials WHERE symbol = ${symbol}
        ORDER BY statement, basis`;
    },
  };
}
