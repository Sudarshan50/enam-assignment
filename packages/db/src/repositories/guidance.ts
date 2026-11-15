import type { Sql } from "../client";

export interface GuidanceItemInput {
  symbol: string;
  documentId: string;
  chunkId: string | null;
  page: number | null;
  metric: string;
  statementType: "explicit_guidance" | "target" | "aspiration";
  low: number | null;
  high: number | null;
  unit: "pct" | "inr_crore" | "x";
  horizonLabel: string;
  horizonStart: string | null;
  horizonEnd: string | null;
  scope: string;
  segment: string | null;
  speaker: string | null;
  quote: string;
  saidIn: string;
  saidOn: string | null;
  withdrawn: boolean;
  extractorVersion: number;
}

export interface GuidanceItemRow {
  id: string;
  symbol: string;
  document_id: string;
  chunk_id: string | null;
  page: number | null;
  metric: string;
  statement_type: "explicit_guidance" | "target" | "aspiration";
  low: number | null;
  high: number | null;
  unit: "pct" | "inr_crore" | "x";
  horizon_label: string;
  horizon_start: Date | null;
  horizon_end: Date | null;
  scope: string;
  segment: string | null;
  speaker: string | null;
  quote: string;
  said_in: string;
  said_on: Date | null;
  withdrawn: boolean;
  extractor_version: number;
}

export interface GuidanceCheckInput {
  guidanceId: string;
  actual: number | null;
  actualPeriod: string | null;
  actualSource: string | null;
  verdict: "delivered" | "missed" | "pending" | "quietly_dropped" | "not_scored";
  explanation: string;
}

export function guidanceRepo(sql: Sql) {
  return {
    /**
     * Replaces the items extracted from one document: upserts keep ids (and their checks) stable across
     * re-runs, and items no longer extracted are removed so stale promises never linger.
     */
    async replaceForDocument(documentId: string, items: GuidanceItemInput[]): Promise<{ id: string }[]> {
      return sql.begin(async (tx) => {
        const out: { id: string }[] = [];
        for (const i of items) {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO guidance_items (symbol, document_id, chunk_id, page, metric, statement_type, low, high, unit,
              horizon_label, horizon_start, horizon_end, scope, segment, speaker, quote, said_in, said_on, withdrawn, extractor_version)
            VALUES (${i.symbol}, ${i.documentId}, ${i.chunkId}, ${i.page}, ${i.metric}, ${i.statementType}, ${i.low}, ${i.high}, ${i.unit},
              ${i.horizonLabel}, ${i.horizonStart}, ${i.horizonEnd}, ${i.scope}, ${i.segment}, ${i.speaker}, ${i.quote}, ${i.saidIn},
              ${i.saidOn}, ${i.withdrawn}, ${i.extractorVersion})
            ON CONFLICT (document_id, metric, horizon_label, quote) DO UPDATE SET
              low = EXCLUDED.low, high = EXCLUDED.high, unit = EXCLUDED.unit, withdrawn = EXCLUDED.withdrawn,
              statement_type = EXCLUDED.statement_type, chunk_id = EXCLUDED.chunk_id, page = EXCLUDED.page,
              horizon_start = EXCLUDED.horizon_start, horizon_end = EXCLUDED.horizon_end, scope = EXCLUDED.scope,
              segment = EXCLUDED.segment, speaker = EXCLUDED.speaker, said_in = EXCLUDED.said_in, said_on = EXCLUDED.said_on,
              extractor_version = EXCLUDED.extractor_version
            RETURNING id`;
          if (row) out.push(row);
        }
        const keep = out.map((r) => r.id);
        await tx`DELETE FROM guidance_items WHERE document_id = ${documentId} AND NOT (id = ANY(${keep}::uuid[]))`;
        return out;
      });
    },

    async listBySymbol(symbol: string): Promise<GuidanceItemRow[]> {
      return sql<GuidanceItemRow[]>`
        SELECT id, symbol, document_id, chunk_id, page, metric, statement_type, low::float8 AS low, high::float8 AS high, unit,
               horizon_label, horizon_start, horizon_end, scope, segment, speaker, quote, said_in, said_on, withdrawn, extractor_version
        FROM guidance_items WHERE symbol = ${symbol} ORDER BY said_on NULLS LAST, created_at`;
    },

    async listForDocument(documentId: string, extractorVersion: number): Promise<GuidanceItemRow[]> {
      return sql<GuidanceItemRow[]>`
        SELECT id, symbol, document_id, chunk_id, page, metric, statement_type, low::float8 AS low, high::float8 AS high, unit,
               horizon_label, horizon_start, horizon_end, scope, segment, speaker, quote, said_in, said_on, withdrawn, extractor_version
        FROM guidance_items WHERE document_id = ${documentId} AND extractor_version = ${extractorVersion}`;
    },

    async upsertChecks(checks: GuidanceCheckInput[]): Promise<void> {
      for (const c of checks) {
        await sql`
          INSERT INTO guidance_checks (guidance_id, actual, actual_period, actual_source, verdict, explanation, checked_at)
          VALUES (${c.guidanceId}, ${c.actual}, ${c.actualPeriod}, ${c.actualSource}, ${c.verdict}, ${c.explanation}, now())
          ON CONFLICT (guidance_id) DO UPDATE SET actual = EXCLUDED.actual, actual_period = EXCLUDED.actual_period,
            actual_source = EXCLUDED.actual_source, verdict = EXCLUDED.verdict, explanation = EXCLUDED.explanation, checked_at = now()`;
      }
    },
  };
}

export type GuidanceRepo = ReturnType<typeof guidanceRepo>;
