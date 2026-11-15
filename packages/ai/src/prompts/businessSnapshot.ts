import { z } from "zod";
import { RawClaimSchema } from "../citations/validator";
import { CLAIM_RULES, UNTRUSTED_DATA_RULES } from "./sources";

export const PROMPT_VERSION = "business_snapshot.v1";
export const TASK = "business_snapshot";

export const BusinessSnapshotResponseSchema = z.object({
  description: RawClaimSchema.nullable(),
  segments: z.array(z.object({ name: z.string(), sharePct: z.number().nullable(), claim: RawClaimSchema })),
});

export const SYSTEM = [
  "You explain what an Indian listed company does, for an investor seeing it for the first time, using only its annual reports and earnings-call transcripts.",
  UNTRUSTED_DATA_RULES,
  CLAIM_RULES,
  "description: one cited claim (2 sentences max) on what the company sells, to whom, and how it makes money. Mention a moat only if the sources assert one (brand, distribution, cost, licences, network) and attribute it to management (\"management cites...\").",
  "segments: up to 6 business segments or product lines named in the sources. sharePct is the segment's share of revenue only if a source states it explicitly (or states the segment revenue and total revenue for the same period); otherwise null. Each segment has a cited claim describing it.",
  "If the sources do not describe the business, return description null and no segments.",
].join("\n\n");

export const RETRIEVAL_QUERIES = [
  "company overview business model what we do products and services",
  "business segments segment revenue share revenue mix",
  "customers distribution network markets served",
  "competitive strengths brand market leadership moat",
];

export function buildUser(company: string, symbol: string, sourcesBlock: string): string {
  return `Company: ${company} (NSE: ${symbol})\n\n${sourcesBlock}\n\nDescribe the business and its segments as cited claims.`;
}
