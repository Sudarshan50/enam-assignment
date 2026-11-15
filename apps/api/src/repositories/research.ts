import type { Sql } from "@finn/db";
import type { RunStatus } from "@finn/shared";
import type { ResearchEventRow, ResearchEventsSource } from "../services/researchEventStream";
import type { DocumentRow, ModuleRow, ResearchRepository, RunRecord } from "../services/researchService";
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
          AND NOT EXISTS (SELECT 1 FROM module_retries mr WHERE mr.run_id = r.id AND mr.status = 'dead')
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

    async insertQueued({ symbol, modules, requestedBy, since, dailyLimit }) {
      return sql.begin(async (raw) => {
        const tx = raw as unknown as Sql;
        // Held to commit, so a concurrent request counts only after this insert is visible (READ COMMITTED).
        await tx`SELECT pg_advisory_xact_lock(hashtext('finn:research_runs:daily_limit'))`;
        const [used] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM research_runs WHERE created_at >= ${since}`;
        if ((used?.n ?? 0) >= dailyLimit) return "limit_reached" as const;
        const [row] = await tx<RunRecord[]>`
          INSERT INTO research_runs AS r (symbol, modules, requested_by)
          VALUES (${symbol}, ${modules}::text[], ${requestedBy})
          ON CONFLICT (symbol) WHERE status IN ('queued','processing_docs','synthesizing') DO NOTHING
          RETURNING ${runColumns(tx)}`;
        return row ?? ("active_exists" as const);
      });
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
        SELECT m.module, m.status, m.payload, m.error, m.updated_at AS "updatedAt",
               r.status AS "retryStatus", r.attempts AS "retryAttempts", r.next_attempt_at AS "retryNextAt"
        FROM research_modules m
        LEFT JOIN module_retries r ON r.run_id = m.run_id AND r.module = m.module AND r.status <> 'resolved'
        WHERE m.run_id = ${runId}`;
    },

    async listDocuments(symbol) {
      return sql<DocumentRow[]>`
        SELECT id, doc_type AS "docType", period_label AS "periodLabel", status, pages, url
        FROM documents WHERE symbol = ${symbol}
        ORDER BY period_end DESC NULLS LAST, created_at DESC
        LIMIT 50`;
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
