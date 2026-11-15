import type { Sql } from "../client";

export type RunStatus = "queued" | "processing_docs" | "synthesizing" | "completed" | "partial" | "failed" | "cancelled";
export type ModuleRowStatus = "pending" | "running" | "done" | "failed" | "insufficient_sources";

export interface ResearchRunRow {
  id: string;
  symbol: string;
  status: RunStatus;
  modules: string[];
  input_hash: string | null;
  requested_by: string | null;
  claimed_at: Date | null;
  error: string | null;
  worker_id: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ModuleCacheRow {
  cache_key: string;
  symbol: string;
  module: string;
  payload: unknown;
  status: string;
}

/** A run whose worker stopped heartbeating for this long is considered abandoned and may be re-claimed. */
export const STALE_HEARTBEAT_SECONDS = 300;

export function researchRepo(sql: Sql) {
  return {
    /** Creates a queued run, or returns the symbol's already-active run (partial unique index). */
    async createOrGetActive(symbol: string, modules: string[], requestedBy: string | null): Promise<{ run: ResearchRunRow; created: boolean }> {
      const [created] = await sql<ResearchRunRow[]>`
        INSERT INTO research_runs (symbol, modules, requested_by)
        VALUES (${symbol}, ${modules}, ${requestedBy})
        ON CONFLICT (symbol) WHERE status IN ('queued','processing_docs','synthesizing') DO NOTHING
        RETURNING *`;
      if (created) return { run: created, created: true };
      const [active] = await sql<ResearchRunRow[]>`
        SELECT * FROM research_runs
        WHERE symbol = ${symbol} AND status IN ('queued','processing_docs','synthesizing')
        ORDER BY created_at DESC LIMIT 1`;
      if (!active) throw new Error(`Could not create or find an active research run for ${symbol}`);
      return { run: active, created: false };
    },

    async get(id: string): Promise<ResearchRunRow | null> {
      const [row] = await sql<ResearchRunRow[]>`SELECT * FROM research_runs WHERE id = ${id}`;
      return row ?? null;
    },

    /** Claims one specific run if it is queued or its worker has gone silent. */
    async claimById(id: string, workerId: string): Promise<ResearchRunRow | null> {
      const [row] = await sql<ResearchRunRow[]>`
        UPDATE research_runs SET status = 'processing_docs', worker_id = ${workerId}, heartbeat_at = now(),
               claimed_at = now(), updated_at = now(), error = NULL
        WHERE id = ${id}
          AND (status = 'queued'
               OR (status IN ('processing_docs','synthesizing')
                   AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS}))))
        RETURNING *`;
      return row ?? null;
    },

    /** Claims the oldest queued (or abandoned) run; SKIP LOCKED lets several workers poll safely. */
    async claimNext(workerId: string): Promise<ResearchRunRow | null> {
      const [row] = await sql<ResearchRunRow[]>`
        UPDATE research_runs SET status = 'processing_docs', worker_id = ${workerId}, heartbeat_at = now(),
               claimed_at = now(), updated_at = now(), error = NULL
        WHERE id = (
          SELECT id FROM research_runs
          WHERE status = 'queued'
             OR (status IN ('processing_docs','synthesizing')
                 AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS})))
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *`;
      return row ?? null;
    },

    /** False once another worker has re-claimed the run. */
    async heartbeat(id: string, workerId: string): Promise<boolean> {
      const res = await sql`UPDATE research_runs SET heartbeat_at = now() WHERE id = ${id} AND worker_id = ${workerId}`;
      return (res.count ?? 0) > 0;
    },

    async setStatus(id: string, status: RunStatus, patch: { error?: string | null; inputHash?: string | null } = {}): Promise<void> {
      await sql`
        UPDATE research_runs SET status = ${status}, error = ${patch.error ?? null},
               input_hash = COALESCE(${patch.inputHash ?? null}, input_hash), updated_at = now(), heartbeat_at = now()
        WHERE id = ${id}`;
    },

    /**
     * The worker-side status write: lands only while `workerId` still holds the run and it is still active, so a
     * worker whose lease expired cannot overwrite the new owner. `event` commits with the status, so an SSE reader
     * that sees a terminal status also sees its closing event.
     */
    async setStatusAsOwner(
      id: string,
      workerId: string,
      status: RunStatus,
      patch: { error?: string | null; inputHash?: string | null } = {},
      event?: { type: string; message: string; data?: Record<string, unknown> | null },
    ): Promise<boolean> {
      return sql.begin(async (raw) => {
        const tx = raw as unknown as Sql;
        const res = await tx`
          UPDATE research_runs SET status = ${status}, error = ${patch.error ?? null},
                 input_hash = COALESCE(${patch.inputHash ?? null}, input_hash), updated_at = now(), heartbeat_at = now()
          WHERE id = ${id} AND worker_id = ${workerId} AND status IN ('processing_docs','synthesizing')`;
        if ((res.count ?? 0) === 0) return false;
        if (event) await researchRepo(tx).addEvent(id, event.type, event.message, event.data ?? null);
        return true;
      });
    },

    /** Appends an event only while `workerId` holds the run; false means the lease was lost. */
    async addEventAsOwner(runId: string, workerId: string, type: string, message: string, data: Record<string, unknown> | null = null): Promise<boolean> {
      const res = await sql`
        INSERT INTO research_events (run_id, type, message, data)
        SELECT r.id, ${type}, ${message}, ${data === null ? null : sql.json(data as Parameters<typeof sql.json>[0])}::jsonb
        FROM research_runs r WHERE r.id = ${runId} AND r.worker_id = ${workerId}`;
      return (res.count ?? 0) > 0;
    },

    async addEvent(runId: string, type: string, message: string, data: Record<string, unknown> | null = null): Promise<void> {
      await sql`
        INSERT INTO research_events (run_id, type, message, data)
        VALUES (${runId}, ${type}, ${message}, ${data === null ? null : sql.json(data as Parameters<typeof sql.json>[0])})`;
    },

    async upsertModule(
      runId: string,
      module: string,
      status: ModuleRowStatus,
      patch: { payload?: unknown; cacheKey?: string | null; error?: string | null } = {},
    ): Promise<void> {
      const payload = patch.payload === undefined || patch.payload === null ? null : sql.json(patch.payload as Parameters<typeof sql.json>[0]);
      await sql`
        INSERT INTO research_modules (run_id, module, status, payload, cache_key, error, updated_at)
        VALUES (${runId}, ${module}, ${status}, ${payload}, ${patch.cacheKey ?? null}, ${patch.error ?? null}, now())
        ON CONFLICT (run_id, module) DO UPDATE SET
          status = EXCLUDED.status,
          payload = COALESCE(EXCLUDED.payload, research_modules.payload),
          cache_key = COALESCE(EXCLUDED.cache_key, research_modules.cache_key),
          error = EXCLUDED.error,
          updated_at = now()`;
    },

    /** upsertModule for the worker holding the run; false (and no write) once the lease was lost. */
    async upsertModuleAsOwner(
      runId: string,
      workerId: string,
      module: string,
      status: ModuleRowStatus,
      patch: { payload?: unknown; cacheKey?: string | null; error?: string | null } = {},
    ): Promise<boolean> {
      const payload = patch.payload === undefined || patch.payload === null ? null : sql.json(patch.payload as Parameters<typeof sql.json>[0]);
      const res = await sql`
        INSERT INTO research_modules (run_id, module, status, payload, cache_key, error, updated_at)
        SELECT r.id, ${module}, ${status}, ${payload}::jsonb, ${patch.cacheKey ?? null}, ${patch.error ?? null}, now()
        FROM research_runs r WHERE r.id = ${runId} AND r.worker_id = ${workerId}
        ON CONFLICT (run_id, module) DO UPDATE SET
          status = EXCLUDED.status,
          payload = COALESCE(EXCLUDED.payload, research_modules.payload),
          cache_key = COALESCE(EXCLUDED.cache_key, research_modules.cache_key),
          error = EXCLUDED.error,
          updated_at = now()`;
      return (res.count ?? 0) > 0;
    },

    async listModules(runId: string): Promise<{ module: string; status: ModuleRowStatus; payload: unknown; error: string | null; updated_at: Date }[]> {
      return sql`SELECT module, status, payload, error, updated_at FROM research_modules WHERE run_id = ${runId} ORDER BY module`;
    },

    async getModuleCache(cacheKey: string): Promise<ModuleCacheRow | null> {
      const [row] = await sql<ModuleCacheRow[]>`SELECT cache_key, symbol, module, payload, status FROM module_cache WHERE cache_key = ${cacheKey}`;
      return row ?? null;
    },

    async putModuleCache(entry: { cacheKey: string; symbol: string; module: string; payload: unknown; status: string }): Promise<void> {
      await sql`
        INSERT INTO module_cache (cache_key, symbol, module, payload, status)
        VALUES (${entry.cacheKey}, ${entry.symbol}, ${entry.module}, ${sql.json(entry.payload as Parameters<typeof sql.json>[0])}, ${entry.status})
        ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, status = EXCLUDED.status, created_at = now()`;
    },
  };
}

export type ResearchRepo = ReturnType<typeof researchRepo>;
