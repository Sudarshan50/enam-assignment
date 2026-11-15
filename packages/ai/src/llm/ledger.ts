import type { Sql } from "@finn/db";
import { llmRepo, type LlmCallRecord } from "@finn/db/repositories/llm";

export type { LlmCallRecord };

/** Cost ledger: one row per attempt (including cache hits), and the call count used by the daily budget. */
export interface LlmLedger {
  record(entry: LlmCallRecord): Promise<void>;
  countBillableSince(since: Date, provider: string): Promise<number>;
}

export function createSqlLedger(sql: Sql): LlmLedger {
  const repo = llmRepo(sql);
  return {
    async record(entry) {
      try {
        await repo.recordCall(entry);
      } catch {
        // The ledger is observability; a failed insert must never fail the call it describes.
      }
    },
    countBillableSince: (since, provider) => repo.countBillableCallsSince(since, provider),
  };
}

export function createMemoryLedger(): LlmLedger & { rows: (LlmCallRecord & { at: Date })[] } {
  const rows: (LlmCallRecord & { at: Date })[] = [];
  return {
    rows,
    async record(entry) {
      rows.push({ ...entry, at: new Date() });
    },
    async countBillableSince(since, provider) {
      return rows.filter((r) => r.at >= since && r.provider === provider && !r.cacheHit && r.status !== "rejected").length;
    },
  };
}
