import type { LlmBudget } from "../middleware/budget";
import type { EngineResponse } from "../contracts";
import { round } from "../lib/numbers";
import { type Clock, DAY, startOfIstDay, systemClock, toIso } from "../lib/time";
import type { SourceHealthService } from "./sourceHealthService";

export interface LlmUsage {
  calls: number;
  billableCalls: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
  schemaChecked: number;
  schemaValid: number;
}

export interface EngineRepository {
  llmUsageSince(since: Date): Promise<LlmUsage>;
  /** LLM calls that hit the provider (not cache hits) since `since`; what the daily budget counts. */
  billableLlmCallsSince(since: Date): Promise<number>;
  llmByPurposeSince(since: Date): Promise<{ purpose: string; calls: number; tokens: number; cacheHits: number }[]>;
  neuronsSince(since: Date): Promise<number>;
  chunksTotal(): Promise<number>;
  documentCounts(): Promise<{ ready: number; failed: number; scanned: number }>;
  announcementCounts(today: Date, week: Date): Promise<{ processedToday: number; processed7d: number; ready: number; pending: number; failed: number }>;
}

export interface EngineService {
  stats(): Promise<EngineResponse>;
}

export function createLlmBudget(deps: { repo: EngineRepository; dailyBudget: number; now?: Clock }): LlmBudget {
  const now = deps.now ?? systemClock;
  return {
    async remaining() {
      const used = await deps.repo.billableLlmCallsSince(startOfIstDay(now()));
      return Math.max(0, deps.dailyBudget - used);
    },
  };
}

export function createEngineService(deps: {
  repo: EngineRepository;
  sourceHealth: SourceHealthService;
  budget: LlmBudget;
  now?: Clock;
}): EngineService {
  const now = deps.now ?? systemClock;
  return {
    async stats() {
      const at = now();
      const today = startOfIstDay(at);
      const week = new Date(at.getTime() - 7 * DAY);
      const [usageToday, usage7d, byPurpose, neurons, chunks, documents, announcements, sourceHealth, budgetRemaining] = await Promise.all([
        deps.repo.llmUsageSince(today),
        deps.repo.llmUsageSince(week),
        deps.repo.llmByPurposeSince(week),
        deps.repo.neuronsSince(today),
        deps.repo.chunksTotal(),
        deps.repo.documentCounts(),
        deps.repo.announcementCounts(today, week),
        deps.sourceHealth.list(),
        deps.budget.remaining(),
      ]);
      const lastIngestAt =
        sourceHealth
          .map((s) => s.lastSuccessAt)
          .filter((v): v is string => v !== null)
          .sort()
          .at(-1) ?? null;
      return {
        llm: {
          callsToday: usageToday.calls,
          cacheHitRate: usageToday.calls ? round(usageToday.cacheHits / usageToday.calls, 3) : 0,
          promptTokensToday: usageToday.promptTokens,
          completionTokensToday: usageToday.completionTokens,
          jsonAdherenceRate: usage7d.schemaChecked ? round(usage7d.schemaValid / usage7d.schemaChecked, 3) : 1,
          budgetRemaining,
        },
        embeddings: { neuronsToday: round(neurons, 1), chunksTotal: chunks },
        documents,
        byPurpose,
        llm7d: {
          calls: usage7d.calls,
          promptTokens: usage7d.promptTokens,
          completionTokens: usage7d.completionTokens,
          cacheHits: usage7d.cacheHits,
        },
        announcements,
        sourceHealth,
        lastIngestAt,
        asOf: toIso(at) ?? at.toISOString(),
      };
    },
  };
}
