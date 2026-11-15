import { z } from "zod";
import { CategorySchema, TierSchema } from "../taxonomy";
import { CardSchema } from "./cards";

export const SourceHealthSchema = z.object({
  source: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastError: z.string().nullable(),
  stale: z.boolean(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const LinkedFilingSchema = z.object({
  seqId: z.string(),
  headline: z.string(),
  pdfUrl: z.string().nullable(),
  publishedAt: z.string(),
});

export const DigestItemSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  companyName: z.string(),
  category: CategorySchema,
  tier: TierSchema,
  score: z.number(),
  reasonCodes: z.array(z.string()),
  headline: z.string(),
  oneLiner: z.string().nullable(),
  publishedAt: z.string(),
  pdfUrl: z.string().nullable(),
  card: CardSchema.nullable(),
  linked: z.array(LinkedFilingSchema),
});
export type DigestItem = z.infer<typeof DigestItemSchema>;

export const DigestQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  window: z.enum(["24h", "3d", "7d"]).optional(),
});
export type DigestQuery = z.infer<typeof DigestQuerySchema>;

export const DigestResponseSchema = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  asOf: z.string().nullable(),
  caughtUp: z.boolean(),
  counts: z.object({ act: z.number(), know: z.number(), noise: z.number() }),
  act: z.array(DigestItemSchema),
  know: z.array(DigestItemSchema),
  noise: z.array(DigestItemSchema),
  sourceHealth: z.array(SourceHealthSchema),
});
export type DigestResponse = z.infer<typeof DigestResponseSchema>;
