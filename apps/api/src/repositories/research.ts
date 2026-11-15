import type { Sql } from "@finn/db";
import type { RunStatus } from "@finn/shared";
import type { ResearchEventRow, ResearchEventsSource } from "../services/researchEventStream";
import type { DocumentRow, ModuleRow, PromiseRow, ResearchRepository, RunRecord } from "../services/researchService";
import { json } from "./sql";

const ACTIVE = ["queued", "processing_docs", "synthesizing"];

function runColumns(sql: Sql) {
  return sql`r.id, r.symbol, r.status, r.modules, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
             r.dispatch_attempts AS "dispatchAttempts"`;
}

export function createResearchRepository(sql: Sql): ResearchRepository & ResearchEventsSource {
  return {
    async findCompany(symbol) {
      const [row] = await sql<{ symbol: string; name: string }[]>`SELECT symbol, name FROM companies WHERE symbol = ${symbol}`;
      return row ?? null;
    },

    async findLatestCompleted(symbol, since) {
      const [row] = await sql<RunRecord[]>`
        SELECT ${runColumns(sql)} FROM research_runs r
        WHERE r.symbol = ${symbol} AND r.status = 'completed' AND r.created_at >= ${since}
        ORDER BY r.created_at DESC LIMIT 1`;
      return row ?? null;
    },

    async findActive(symbol) {
      const [row] = await sql<RunRecord[]>`
        SELECT ${runColumns(sql)} FROM research_runs r
        WHERE r.symbol = ${symbol} AND r.status = ANY(${ACTIVE}::text[])
        ORDER BY r.created_at DESC LIMIT 1`;
      return row ?? null;
    },

    async countCreatedSince(since) {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM research_runs WHERE created_at >= ${since}`;
      return row?.n ?? 0;
    },

    async insertQueued({ symbol, modules, requestedBy }) {
      const [row] = await sql<RunRecord[]>`
        INSERT INTO research_runs AS r (symbol, modules, requested_by)
        VALUES (${symbol}, ${modules}::text[], ${requestedBy})
        ON CONFLICT (symbol) WHERE status IN ('queued','processing_docs','synthesizing') DO NOTHING
        RETURNING ${runColumns(sql)}`;
      return row ?? null;
    },

    async appendEvent(runId, type, message, data) {
      await sql`
        INSERT INTO research_events (run_id, type, message, data)
        VALUES (${runId}, ${type}, ${message}, ${data ? json(sql, data) : null})`;
    },

    async markDispatched(runId) {
      await sql`
        UPDATE research_runs
        SET dispatched_at = now(), dispatch_attempts = dispatch_attempts + 1, error = NULL, updated_at = now()
        WHERE id = ${runId}`;
    },

    async recordDispatchFailure(runId, error) {
      await sql`
        UPDATE research_runs
        SET dispatched_at = now(), dispatch_attempts = dispatch_attempts + 1, error = ${error}, updated_at = now()
        WHERE id = ${runId}`;
    },

    async markFailed(runId, error) {
      await sql`UPDATE research_runs SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${runId} AND status = 'queued'`;
    },

    async getRun(id) {
      const [row] = await sql<(RunRecord & { companyName: string | null })[]>`
        SELECT ${runColumns(sql)}, c.name AS "companyName"
        FROM research_runs r LEFT JOIN companies c ON c.symbol = r.symbol
        WHERE r.id = ${id}`;
      return row ?? null;
    },

    async findLatestRun(symbol) {
      const [row] = await sql<RunRecord[]>`
        SELECT ${runColumns(sql)} FROM research_runs r
        WHERE r.symbol = ${symbol}
        ORDER BY (r.status IN ('completed','partial')) DESC, r.created_at DESC
        LIMIT 1`;
      return row ?? null;
    },

    async listModules(runId) {
      return sql<ModuleRow[]>`
        SELECT module, status, payload, error, updated_at AS "updatedAt"
        FROM research_modules WHERE run_id = ${runId}`;
    },

    async listDocuments(symbol) {
      return sql<DocumentRow[]>`
        SELECT id, doc_type AS "docType", period_label AS "periodLabel", status, pages, url
        FROM documents WHERE symbol = ${symbol}
        ORDER BY period_end DESC NULLS LAST, created_at DESC
        LIMIT 50`;
    },

    async listPromises(symbol) {
      return sql<PromiseRow[]>`
        SELECT g.id, g.metric, g.statement_type AS "statementType", g.low::float8 AS low, g.high::float8 AS high, g.unit,
               g.horizon_label AS "horizonLabel", g.horizon_end::text AS "horizonEnd", g.said_in AS "saidIn", g.speaker,
               g.quote, g.page, g.chunk_id AS "chunkId", g.document_id AS "documentId",
               initcap(replace(d.doc_type, '_', ' ')) || ' ' || d.period_label AS "documentLabel", d.url AS "documentUrl",
               k.actual::float8 AS actual, k.actual_period AS "actualPeriod", k.actual_source AS "actualSource",
               k.verdict, k.explanation
        FROM guidance_items g
        JOIN documents d ON d.id = g.document_id
        LEFT JOIN guidance_checks k ON k.guidance_id = g.id
        WHERE g.symbol = ${symbol}
        ORDER BY g.said_on DESC NULLS LAST, g.created_at DESC
        LIMIT 100`;
    },

    async listStaleQueued(createdBefore, limit) {
      return sql<RunRecord[]>`
        SELECT ${runColumns(sql)} FROM research_runs r
        WHERE r.status = 'queued' AND r.claimed_at IS NULL AND r.created_at < ${createdBefore}
          AND (r.dispatched_at IS NULL OR r.dispatched_at < ${createdBefore})
        ORDER BY r.created_at
        LIMIT ${limit}`;
    },

    async listAfter(runId, afterId, limit) {
      return sql<ResearchEventRow[]>`
        SELECT id::float8 AS id, run_id AS "runId", type, message, data, created_at AS "createdAt"
        FROM research_events
        WHERE run_id = ${runId} AND id > ${afterId}
        ORDER BY id
        LIMIT ${limit}`;
    },

    async runStatus(runId) {
      const [row] = await sql<{ status: RunStatus }[]>`SELECT status FROM research_runs WHERE id = ${runId}`;
      return row?.status ?? null;
    },
  };
}
