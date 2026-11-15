import type { Sql } from "../client";

export interface SourceHealthRow {
  source: string;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  recordsLastRun: number | null;
}

export function sourceHealthRepo(sql: Sql) {
  return {
    async recordSuccess(source: string, records: number): Promise<void> {
      await sql`
        INSERT INTO source_health (source, last_success_at, last_attempt_at, consecutive_failures, last_error, records_last_run)
        VALUES (${source}, now(), now(), 0, NULL, ${records})
        ON CONFLICT (source) DO UPDATE SET
          last_success_at = now(), last_attempt_at = now(), consecutive_failures = 0,
          last_error = NULL, records_last_run = EXCLUDED.records_last_run`;
    },

    /** Returns the new consecutive-failure count. */
    async recordFailure(source: string, error: string): Promise<number> {
      const [row] = await sql<{ consecutive_failures: number }[]>`
        INSERT INTO source_health (source, last_attempt_at, consecutive_failures, last_error)
        VALUES (${source}, now(), 1, ${error.slice(0, 1000)})
        ON CONFLICT (source) DO UPDATE SET
          last_attempt_at = now(),
          consecutive_failures = source_health.consecutive_failures + 1,
          last_error = EXCLUDED.last_error
        RETURNING consecutive_failures`;
      return row?.consecutive_failures ?? 1;
    },

    async get(source: string): Promise<SourceHealthRow | null> {
      const [row] = await sql<SourceHealthRow[]>`
        SELECT source, last_success_at AS "lastSuccessAt", last_attempt_at AS "lastAttemptAt",
               consecutive_failures AS "consecutiveFailures", last_error AS "lastError", records_last_run AS "recordsLastRun"
        FROM source_health WHERE source = ${source}`;
      return row ?? null;
    },

    async list(): Promise<SourceHealthRow[]> {
      return sql<SourceHealthRow[]>`
        SELECT source, last_success_at AS "lastSuccessAt", last_attempt_at AS "lastAttemptAt",
               consecutive_failures AS "consecutiveFailures", last_error AS "lastError", records_last_run AS "recordsLastRun"
        FROM source_health ORDER BY source`;
    },
  };
}

export type SourceHealthRepo = ReturnType<typeof sourceHealthRepo>;
