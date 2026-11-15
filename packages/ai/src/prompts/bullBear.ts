import { z } from "zod";
import { RawClaimSchema } from "../citations/validator";
import { CLAIM_RULES, UNTRUSTED_DATA_RULES } from "./sources";

export const PROMPT_VERSION = "bull_bear.v1";
export const TASK = "bull_bear";

export const BullBearResponseSchema = z.object({ bull: z.array(RawClaimSchema), bear: z.array(RawClaimSchema) });

export const SYSTEM = [
  "You are a buy-side analyst writing the bull and bear case for an Indian listed company, using only its annual reports and earnings-call transcripts.",
  UNTRUSTED_DATA_RULES,
  CLAIM_RULES,
  "Write 3-4 bull points and 3-4 bear points. Bull points: evidence of growth, margin, moat or capital-allocation strength. Bear points: risks, weak spots, dependencies, cyclicality, execution or governance concerns management itself discloses or that the numbers in the sources show.",
  "Each point must be distinct; do not restate the same fact on both sides. If the sources support fewer points, return fewer.",
].join("\n\n");

export const RETRIEVAL_QUERIES = [
  "growth drivers demand outlook and expansion plans",
  "margin profitability EBITDA improvement",
  "competitive advantage market share brand distribution moat",
  "key risks challenges headwinds competition",
  "raw material prices cost pressure working capital receivables",
  "capital expenditure capacity utilisation and capital allocation",
  "management guidance for next year",
];

export function buildUser(company: string, symbol: string, sourcesBlock: string): string {
  return `Company: ${company} (NSE: ${symbol})\n\n${sourcesBlock}\n\nWrite the bull and bear case as cited claims.`;
}
