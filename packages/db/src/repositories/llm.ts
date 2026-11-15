import type { Sql } from "../client";

export interface LlmCallRecord {
  provider: string;
  model: string;
  /** Task name, e.g. "bull_bear" or "embed". Stored in the `purpose` column. */
  task: string;
  promptVersion?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  neurons?: number | null;
  cacheHit: boolean;
  schemaValid?: boolean | null;
  latencyMs?: number | null;
  status: "ok" | "cache_hit" | "invalid" | "error" | "rejected";
  error?: string | null;
  attempt?: number | null;
  refKind?: string | null;
  refId?: string | null;
}

export function llmRepo(sql: Sql) {
  return {
    async cacheGet(cacheKey: string): Promise<unknown | undefined> {
      const [row] = await sql<{ response: unknown }[]>`
        UPDATE llm_cache SET hit_count = hit_count + 1, last_hit_at = now()
        WHERE cache_key = ${cacheKey} AND created_at > now() - interval '30 days'
        RETURNING response`;
      return row?.response;
    },

    async cachePut(cacheKey: string, model: string, task: string, response: unknown): Promise<void> {
      await sql`
        INSERT INTO llm_cache (cache_key, model, purpose, response)
        VALUES (${cacheKey}, ${model}, ${task}, ${sql.json(response as Parameters<typeof sql.json>[0])})
        ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, created_at = now()`;
    },

    async recordCall(r: LlmCallRecord): Promise<void> {
      await sql`
        INSERT INTO llm_calls (provider, model, purpose, prompt_version, prompt_tokens, completion_tokens, neurons, cache_hit,
          schema_valid, latency_ms, status, error, attempt, ref_kind, ref_id)
        VALUES (${r.provider}, ${r.model}, ${r.task}, ${r.promptVersion ?? null}, ${r.promptTokens ?? null}, ${r.completionTokens ?? null},
          ${r.neurons ?? null}, ${r.cacheHit}, ${r.schemaValid ?? null}, ${r.latencyMs ?? null}, ${r.status},
          ${r.error ? r.error.slice(0, 500) : null}, ${r.attempt ?? null}, ${r.refKind ?? null}, ${r.refId ?? null})`;
    },

    /** Billable LLM attempts (cache hits and embeddings excluded) since the given instant. */
    async countBillableCallsSince(since: Date, provider: string): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM llm_calls
        WHERE created_at >= ${since} AND provider = ${provider} AND cache_hit = false AND status <> 'rejected'`;
      return row?.n ?? 0;
    },

    async usageSince(since: Date): Promise<{ provider: string; task: string; calls: number; cache_hits: number; prompt_tokens: number; completion_tokens: number; neurons: number }[]> {
      return sql`
        SELECT provider, purpose AS task, count(*)::int AS calls, count(*) FILTER (WHERE cache_hit)::int AS cache_hits,
               COALESCE(sum(prompt_tokens), 0)::int AS prompt_tokens, COALESCE(sum(completion_tokens), 0)::int AS completion_tokens,
               COALESCE(sum(neurons), 0)::float8 AS neurons
        FROM llm_calls WHERE created_at >= ${since}
        GROUP BY provider, purpose ORDER BY provider, purpose`;
    },
  };
}

export type LlmRepo = ReturnType<typeof llmRepo>;
