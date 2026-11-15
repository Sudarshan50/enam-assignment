import type { PromiseItem } from "@finn/shared";

/** "guidance_extract" → "Guidance extract". */
export function humanizeKey(key: string): string {
  const words = key.replace(/[._-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const PURPOSE_LABEL: Record<string, string> = {
  classify: "Classifying filings",
  enrich_card: "Filing card details",
  guidance_extract: "Reading guidance from calls",
  module_synthesis: "Writing research modules",
  business_snapshot: "Business snapshot",
  bull_bear: "Bull vs bear case",
  ask: "Answering questions",
  alert_rule_preview: "Previewing alert rules",
  embed: "Embeddings",
};

/** Reader-facing name for an LLM call purpose, e.g. "card.deal.regenerate" → "Filing card: deal (re-grounding)". */
export function purposeLabel(purpose: string): string {
  const regenerate = purpose.endsWith(".regenerate");
  const base = regenerate ? purpose.slice(0, -".regenerate".length) : purpose;
  const label = PURPOSE_LABEL[base] ?? (base.startsWith("card.") ? `Filing card: ${humanizeKey(base.slice(5)).toLowerCase()}` : humanizeKey(base));
  return regenerate ? `${label} (re-grounding)` : label;
}

export const STATEMENT_LABEL: Record<PromiseItem["statementType"], string> = {
  explicit_guidance: "Explicit guidance",
  target: "Target",
  aspiration: "Aspiration",
};

/** "transcript Q2 FY27", "Q2 FY27 concall" or "Q2 FY27 call" → "Q2 FY27 earnings call"; anything else is returned as is. */
export function callLabel(label: string): string {
  const period = /\b(Q[1-4])\s*(FY\s?\d{2,4})\b/i.exec(label);
  if (!period || !/\b(transcript|concall|call)\b/i.test(label)) return label;
  const note = /\(([^)]+)\)\s*$/.exec(label);
  return `${period[1]!.toUpperCase()} ${period[2]!.toUpperCase().replace(/\s/g, "")} earnings call${note ? ` (${note[1]})` : ""}`;
}
