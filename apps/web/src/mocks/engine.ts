import type { EngineResponse } from "../lib/api/schemas";
import { buildSourceHealth, type MockScenario } from "./digest";

export function buildEngine(now: Date, scenario: MockScenario): EngineResponse {
  return {
    llm: {
      callsToday: 312,
      cacheHitRate: 0.64,
      promptTokensToday: 1_482_300,
      completionTokensToday: 96_410,
      jsonAdherenceRate: 0.994,
      budgetRemaining: 1688,
    },
    embeddings: { neuronsToday: 61.4, chunksTotal: 48_920 },
    documents: { ready: 214, failed: 3, scanned: 2 },
    byPurpose: [
      { purpose: "classify", calls: 148, tokens: 402_100, cacheHits: 109 },
      { purpose: "enrich_card", calls: 37, tokens: 188_900, cacheHits: 12 },
      { purpose: "guidance_extract", calls: 64, tokens: 611_400, cacheHits: 41 },
      { purpose: "module_synthesis", calls: 29, tokens: 254_800, cacheHits: 18 },
      { purpose: "ask", calls: 22, tokens: 96_300, cacheHits: 4 },
      { purpose: "alert_rule_preview", calls: 12, tokens: 25_210, cacheHits: 3 },
    ],
    sourceHealth: buildSourceHealth(now, scenario),
    asOf: now.toISOString(),
  };
}
