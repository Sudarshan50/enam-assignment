import { z } from "zod";
import { StatementFamilySchema } from "../taxonomy";

export const HoldingSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  statementFamily: StatementFamilySchema.nullable(),
  close: z.number().nullable(),
  changePct: z.number().nullable(),
  volume: z.number().nullable(),
  volumeVsAvg: z.number().nullable(),
  sessionDate: z.string().nullable(),
  sparkline: z.array(z.number()),
  unreadCount: z.number().int(),
  researchReady: z.boolean(),
});
export type Holding = z.infer<typeof HoldingSchema>;

export const EngineStatsSchema = z.object({
  llm: z.object({
    callsToday: z.number(),
    cacheHitRate: z.number(),
    promptTokensToday: z.number(),
    completionTokensToday: z.number(),
    jsonAdherenceRate: z.number(),
    budgetRemaining: z.number(),
  }),
  embeddings: z.object({ neuronsToday: z.number(), chunksTotal: z.number() }),
  documents: z.object({ ready: z.number(), failed: z.number(), scanned: z.number() }),
  byPurpose: z.array(z.object({ purpose: z.string(), calls: z.number(), tokens: z.number(), cacheHits: z.number() })),
});
export type EngineStats = z.infer<typeof EngineStatsSchema>;
