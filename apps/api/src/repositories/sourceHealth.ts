import type { Sql } from "@finn/db";
import type { SourceHealthRepository, SourceHealthRow } from "../services/sourceHealthService";

export function createSourceHealthRepository(sql: Sql): SourceHealthRepository {
  return {
    async list() {
      return sql<SourceHealthRow[]>`
        SELECT source, last_success_at AS "lastSuccessAt", last_attempt_at AS "lastAttemptAt",
               consecutive_failures AS "consecutiveFailures", last_error AS "lastError"
        FROM source_health ORDER BY source`;
    },
  };
}
