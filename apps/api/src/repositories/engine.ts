import type { Sql } from "@finn/db";
import type { EngineRepository, LlmUsage } from "../services/engineService";

/** Embedding calls share llm_calls; they are the Cloudflare rows that report neurons. */
const isLlm = (sql: Sql) => sql`(l.provider <> 'cloudflare' AND l.neurons IS NULL)`;

/**
 * Matches @finn/ai's budget count: provider calls that were not cache hits and not rejected by the cap.
 * `status` arrives with migration 020, so it is read through to_jsonb to work before and after it.
 */
const isBillable = (sql: Sql) => sql`(NOT l.cache_hit AND (to_jsonb(l) ->> 'status') IS DISTINCT FROM 'rejected')`;

export function createEngineRepository(sql: Sql): EngineRepository {
  return {
    async llmUsageSince(since) {
      const [row] = await sql<LlmUsage[]>`
        SELECT count(*)::int AS calls,
               count(*) FILTER (WHERE ${isBillable(sql)})::int AS "billableCalls",
               count(*) FILTER (WHERE l.cache_hit)::int AS "cacheHits",
               COALESCE(sum(l.prompt_tokens), 0)::float8 AS "promptTokens",
               COALESCE(sum(l.completion_tokens), 0)::float8 AS "completionTokens",
               count(l.schema_valid)::int AS "schemaChecked",
               count(*) FILTER (WHERE l.schema_valid)::int AS "schemaValid"
        FROM llm_calls l WHERE l.created_at >= ${since} AND ${isLlm(sql)}`;
      return row ?? { calls: 0, billableCalls: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, schemaChecked: 0, schemaValid: 0 };
    },

    async billableLlmCallsSince(since) {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM llm_calls l
        WHERE l.created_at >= ${since} AND ${isLlm(sql)} AND ${isBillable(sql)}`;
      return row?.n ?? 0;
    },

    async llmByPurposeSince(since) {
      return sql<{ purpose: string; calls: number; tokens: number; cacheHits: number }[]>`
        SELECT l.purpose, count(*)::int AS calls,
               COALESCE(sum(coalesce(l.prompt_tokens, 0) + coalesce(l.completion_tokens, 0)), 0)::float8 AS tokens,
               count(*) FILTER (WHERE l.cache_hit)::int AS "cacheHits"
        FROM llm_calls l WHERE l.created_at >= ${since} AND ${isLlm(sql)}
        GROUP BY l.purpose ORDER BY calls DESC`;
    },

    async neuronsSince(since) {
      const [row] = await sql<{ n: number }[]>`SELECT COALESCE(sum(neurons), 0)::float8 AS n FROM llm_calls WHERE created_at >= ${since}`;
      return row?.n ?? 0;
    },

    async chunksTotal() {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM doc_chunks WHERE embedding IS NOT NULL`;
      return row?.n ?? 0;
    },

    async documentCounts() {
      const [row] = await sql<{ ready: number; failed: number; scanned: number }[]>`
        SELECT count(*) FILTER (WHERE status = 'ready')::int AS ready,
               count(*) FILTER (WHERE status = 'failed')::int AS failed,
               count(*) FILTER (WHERE status = 'scanned')::int AS scanned
        FROM documents`;
      return row ?? { ready: 0, failed: 0, scanned: 0 };
    },

    async announcementCounts(today, week) {
      const [row] = await sql<{ processedToday: number; processed7d: number; ready: number; pending: number; failed: number }[]>`
        SELECT count(*) FILTER (WHERE status = 'ready' AND created_at >= ${today})::int AS "processedToday",
               count(*) FILTER (WHERE status IN ('ready','failed','review'))::int AS "processed7d",
               count(*) FILTER (WHERE status = 'ready')::int AS ready,
               count(*) FILTER (WHERE status IN ('raw','classified','enriched','review'))::int AS pending,
               count(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM announcements WHERE created_at >= ${week}`;
      return row ?? { processedToday: 0, processed7d: 0, ready: 0, pending: 0, failed: 0 };
    },
  };
}

export function createMaintenanceRepository(sql: Sql) {
  return {
    async ping(): Promise<void> {
      await sql`SELECT 1`;
    },
    async pruneLlmCache(olderThanDays: number): Promise<number> {
      const rows = await sql`
        DELETE FROM llm_cache WHERE coalesce(last_hit_at, created_at) < now() - make_interval(days => ${olderThanDays}::int)
        RETURNING cache_key`;
      return rows.length;
    },
  };
}
