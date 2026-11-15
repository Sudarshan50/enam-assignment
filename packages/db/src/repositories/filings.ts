import type { StatementFamily } from "@finn/shared/taxonomy";
import type { Sql } from "../client";

export type FactContext = "OneD" | "FourD" | "OneI" | "PY_I";
export type FilingStatus = "discovered" | "parsed" | "failed" | "under_review";

export interface FilingUpsert {
  seqId: string;
  symbol: string;
  periodStart: string | null;
  periodEnd: string;
  basis: "consolidated" | "standalone";
  statementFamily: StatementFamily;
  taxonomy: string;
  audited: boolean;
  revision: string | null;
  broadcastAt: Date | null;
  xbrlUrl: string;
  sha256: string | null;
  parserVersion: number;
  status: FilingStatus;
  error: string | null;
}

export interface FilingRow extends FilingUpsert {
  createdAt: Date;
}

export interface FactUpsert {
  concept: string;
  context: FactContext;
  periodStart: string | null;
  periodEnd: string;
  value: number;
  unit: string;
  derived: boolean;
}

export interface FactRow extends FactUpsert {
  filingSeqId: string;
}

const BATCH = 500;

export function filingsRepo(sql: Sql) {
  const columns = () => sql`
    seq_id AS "seqId", symbol, period_start::text AS "periodStart", period_end::text AS "periodEnd", basis,
    statement_family AS "statementFamily", taxonomy, audited, revision, broadcast_at AS "broadcastAt",
    xbrl_url AS "xbrlUrl", sha256, parser_version AS "parserVersion", status, error, created_at AS "createdAt"`;

  return {
    /** Idempotent on the NSE filing seq id. */
    async upsertFiling(f: FilingUpsert): Promise<void> {
      await sql`
        INSERT INTO quarterly_filings (seq_id, symbol, period_start, period_end, basis, statement_family, taxonomy, audited,
                                       revision, broadcast_at, xbrl_url, sha256, parser_version, status, error)
        VALUES (${f.seqId}, ${f.symbol}, ${f.periodStart}, ${f.periodEnd}, ${f.basis}, ${f.statementFamily}, ${f.taxonomy},
                ${f.audited}, ${f.revision}, ${f.broadcastAt}, ${f.xbrlUrl}, ${f.sha256}, ${f.parserVersion}, ${f.status}, ${f.error})
        ON CONFLICT (seq_id) DO UPDATE SET
          period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, basis = EXCLUDED.basis,
          statement_family = EXCLUDED.statement_family, taxonomy = EXCLUDED.taxonomy, audited = EXCLUDED.audited,
          revision = EXCLUDED.revision, broadcast_at = EXCLUDED.broadcast_at, xbrl_url = EXCLUDED.xbrl_url,
          sha256 = COALESCE(EXCLUDED.sha256, quarterly_filings.sha256), parser_version = EXCLUDED.parser_version,
          status = EXCLUDED.status, error = EXCLUDED.error`;
    },

    /**
     * Upserts facts on (filing, concept, context). Called only after a successful parse, so a malformed
     * re-download never wipes earlier good facts.
     */
    async upsertFacts(filingSeqId: string, facts: readonly FactUpsert[]): Promise<number> {
      const seen = new Set<string>();
      const rows = [];
      for (const f of facts) {
        const key = `${f.concept}|${f.context}`;
        if (seen.has(key) || !Number.isFinite(f.value)) continue;
        seen.add(key);
        rows.push({
          filing_seq_id: filingSeqId,
          concept: f.concept,
          context: f.context,
          period_start: f.periodStart,
          period_end: f.periodEnd,
          value: String(f.value),
          unit: f.unit,
          derived: f.derived,
        });
      }
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        await sql`
          INSERT INTO financial_facts ${sql(batch, "filing_seq_id", "concept", "context", "period_start", "period_end", "value", "unit", "derived")}
          ON CONFLICT (filing_seq_id, concept, context) DO UPDATE SET
            value = EXCLUDED.value, unit = EXCLUDED.unit, period_start = EXCLUDED.period_start,
            period_end = EXCLUDED.period_end, derived = EXCLUDED.derived`;
      }
      return rows.length;
    },

    async markFailed(seqId: string, error: string): Promise<void> {
      await sql`UPDATE quarterly_filings SET status = 'failed', error = ${error.slice(0, 1000)} WHERE seq_id = ${seqId}`;
    },

    async get(seqId: string): Promise<FilingRow | null> {
      const [row] = await sql<FilingRow[]>`SELECT ${columns()} FROM quarterly_filings WHERE seq_id = ${seqId}`;
      return row ?? null;
    },

    async listBySymbol(symbol: string, basis?: "consolidated" | "standalone"): Promise<FilingRow[]> {
      return basis
        ? sql<FilingRow[]>`SELECT ${columns()} FROM quarterly_filings WHERE symbol = ${symbol} AND basis = ${basis} ORDER BY period_end DESC`
        : sql<FilingRow[]>`SELECT ${columns()} FROM quarterly_filings WHERE symbol = ${symbol} ORDER BY period_end DESC, basis`;
    },

    /** Latest parsed filing, consolidated preferred. */
    async latestParsed(symbol: string): Promise<FilingRow | null> {
      const [row] = await sql<FilingRow[]>`
        SELECT ${columns()} FROM quarterly_filings
        WHERE symbol = ${symbol} AND status = 'parsed'
        ORDER BY period_end DESC, (basis = 'consolidated') DESC, broadcast_at DESC NULLS LAST
        LIMIT 1`;
      return row ?? null;
    },

    async getFacts(filingSeqId: string, contexts?: readonly FactContext[]): Promise<FactRow[]> {
      const rows = await sql<(Omit<FactRow, "value"> & { value: string })[]>`
        SELECT filing_seq_id AS "filingSeqId", concept, context, period_start::text AS "periodStart",
               period_end::text AS "periodEnd", value::text AS value, unit, derived
        FROM financial_facts
        WHERE filing_seq_id = ${filingSeqId} ${contexts?.length ? sql`AND context = ANY(${[...contexts]})` : sql``}
        ORDER BY concept, context`;
      return rows.map((r) => ({ ...r, value: Number(r.value) }));
    },

    async countFacts(filingSeqId?: string): Promise<number> {
      const [row] = filingSeqId
        ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM financial_facts WHERE filing_seq_id = ${filingSeqId}`
        : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM financial_facts`;
      return row?.n ?? 0;
    },
  };
}

export type FilingsRepo = ReturnType<typeof filingsRepo>;
