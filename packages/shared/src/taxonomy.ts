import { z } from "zod";

/** The 17 announcement categories from the ENAM reference document. */
export const CATEGORIES = [
  "results",
  "m_and_a",
  "fund_raise",
  "management_change",
  "litigation",
  "insider_trading",
  "earnings_call",
  "investor_meetings",
  "credit_rating",
  "dividend",
  "bonus_split",
  "capex",
  "press_release",
  "postal_ballot",
  "agm_egm",
  "pledging",
  "unclassified",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  results: "Results",
  m_and_a: "M&A",
  fund_raise: "Fund raise",
  management_change: "Management change",
  litigation: "Litigation",
  insider_trading: "Insider trading",
  earnings_call: "Earnings call",
  investor_meetings: "Investor meetings",
  credit_rating: "Credit rating",
  dividend: "Dividend",
  bonus_split: "Bonus / split",
  capex: "Capex",
  press_release: "Press release",
  postal_ballot: "Postal ballot",
  agm_egm: "AGM / EGM",
  pledging: "Pledging",
  unclassified: "Routine",
};

/** Base materiality weight per category, calibrated so impact = 1 lands in the intended tier. */
export const CATEGORY_BASE_WEIGHT: Record<Category, number> = {
  results: 80,
  m_and_a: 78,
  management_change: 72,
  fund_raise: 68,
  litigation: 65,
  pledging: 64,
  insider_trading: 55,
  capex: 50,
  bonus_split: 45,
  dividend: 40,
  press_release: 35,
  earnings_call: 30,
  postal_ballot: 25,
  agm_egm: 25,
  investor_meetings: 20,
  unclassified: 15,
  credit_rating: 60,
};

/** Categories whose filings are opened (XBRL or PDF) for structured facts, regardless of tier. */
export const ENRICHED_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "results",
  "management_change",
  "m_and_a",
  "credit_rating",
  "litigation",
  "fund_raise",
  "pledging",
  "insider_trading",
  "dividend",
  "bonus_split",
  "capex",
]);

export const TIERS = ["act", "know", "noise"] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

export const TIER_THRESHOLDS = { act: 70, know: 35 } as const;

export const STATEMENT_FAMILIES = ["industrial", "banking", "nbfc"] as const;
export const StatementFamilySchema = z.enum(STATEMENT_FAMILIES);
export type StatementFamily = z.infer<typeof StatementFamilySchema>;

export const USER_WEIGHT_RANGE = { min: 0.4, max: 1.6 } as const;
export const IMPACT_RANGE = { min: 0.7, max: 1.3 } as const;
