import { GUIDANCE_METRICS } from "@finn/shared/contracts/research";
import { z } from "zod";
import { UNTRUSTED_DATA_RULES } from "./sources";

export const PROMPT_VERSION = "guidance_extract.v3";
/** Stored on guidance_items; bump with the prompt so stale extractions are redone. */
export const EXTRACTOR_VERSION = 3;
/** A typical call yields under 15 items; the cap keeps a runaway reply inside the token limit. */
export const MAX_ITEMS = 30;
export const TASK = "guidance_extract";

export const GuidanceItemSchema = z.object({
  metric: z.enum(GUIDANCE_METRICS),
  statementType: z.enum(["explicit_guidance", "target", "aspiration"]),
  bound: z.enum(["point", "range", "at_least", "at_most"]),
  low: z.number().nullable(),
  high: z.number().nullable(),
  unit: z.enum(["pct", "inr_crore", "x"]),
  horizon: z.string(),
  scope: z.enum(["consolidated", "segment"]),
  segment: z.string().nullable(),
  speaker: z.string().nullable(),
  withdrawn: z.boolean(),
  sourceId: z.string(),
  quote: z.string(),
});
/** Sent to the model as the JSON schema it must follow. */
export const GuidanceExtractionSchema = z.object({ items: z.array(GuidanceItemSchema) });
export type GuidanceExtraction = z.infer<typeof GuidanceExtractionSchema>;
/** What a reply must satisfy to be accepted; items are then validated one by one, so one bad item costs only itself. */
export const GuidanceReplySchema = z.object({ items: z.array(z.unknown()) });

export const SYSTEM = [
  "You extract forward-looking quantitative guidance from an Indian company's earnings-call transcript.",
  UNTRUSTED_DATA_RULES,
  `Only these metrics exist (closed list): ${GUIDANCE_METRICS.join(", ")}.`,
  [
    "Metric rules:",
    "- revenue_growth, pat_growth, volume_growth: year-on-year growth in percent (unit pct). Absolute revenue targets are NOT revenue_growth; skip them unless the growth rate is stated.",
    "- ebitda_margin: EBITDA or operating margin in percent (unit pct).",
    "- capex: planned capital expenditure in ₹ crore (unit inr_crore). Convert lakh/billion/million to crore.",
    "- order_book: order book or order inflow target in ₹ crore (unit inr_crore).",
    "- net_debt: net debt level in ₹ crore (unit inr_crore); \"net debt free\" means at_most 0. Net debt/EBITDA uses unit x.",
  ].join("\n"),
  [
    "Statement rules:",
    "- Include only statements made by company management about a FUTURE period relative to the call date. Skip results already reported, analyst questions and analyst estimates.",
    "- Skip hypothetical or illustrative arithmetic (\"hypothetically, if volume grows 10% then value grows 15%\", \"for example\"); only numbers management commits to or targets count.",
    "- statementType: explicit_guidance = a committed number or range (\"we guide\", \"we expect 15-18%\", \"we will spend ₹500 crore\"); target = a stated goal or ambition with a number (\"we aim to reach 20% margin\"); aspiration = vague or long-dated hopes that still carry a number.",
    "- bound: point (single number: low = high = value), range (low < high), at_least (\"at least\", \"more than\", \"double-digit\" -> low = 10, high = null), at_most (\"up to\", \"below\" -> low = null, high = value).",
    "- horizon: the fiscal period the number applies to, written as FY27, H2 FY27 or Q3 FY27 (Indian fiscal year ends 31 March; FY27 = Apr 2026 - Mar 2027). Resolve \"this year\", \"next year\", \"second half\" against the call date given. Multi-year statements (\"over the next 3 years\", \"by FY29\") use the final fiscal year. Skip statements with no resolvable horizon.",
    "- scope: consolidated unless the statement is for one segment/business (then scope=segment and name it in segment).",
    "- withdrawn: true only when management explicitly withdraws, suspends or abandons earlier guidance in this call (still give the metric and horizon of the guidance withdrawn).",
    "- speaker: name or role of the management speaker when shown, else null.",
    "- sourceId: id of the source containing the statement. quote: the exact sentence(s) copied character-for-character from that source (no paraphrase).",
    `- List each statement once: when management repeats the same number for the same metric and horizon, give its clearest instance. Return at most ${MAX_ITEMS} items, the most specific first.`,
  ].join("\n"),
  "Return an empty items array if there is no qualifying guidance. Never invent numbers.",
].join("\n\n");

export function buildUser(company: string, symbol: string, callLabel: string, callDate: string, sourcesBlock: string): string {
  return `Company: ${company} (NSE: ${symbol})\nCall: ${callLabel}, held in ${callDate.slice(0, 7)}\n\n${sourcesBlock}\n\nExtract forward-looking guidance.`;
}
