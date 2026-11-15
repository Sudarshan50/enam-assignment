import {
  CATEGORY_BASE_WEIGHT,
  IMPACT_RANGE,
  TIER_THRESHOLDS,
  USER_WEIGHT_RANGE,
  type Category,
  type Tier,
} from "@finn/shared/taxonomy";

export interface ScoreInput {
  category: Category;
  /** User preference multiplier; missing means neutral (1.0). */
  userWeight?: number | null;
  /** Filing-specific materiality from the LLM; missing means neutral (1.0). */
  impact?: number | null;
  pinned?: "act" | null;
}

export interface ScoreResult {
  score: number;
  tier: Tier;
}

export const PINNED_MIN_SCORE = TIER_THRESHOLDS.act;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function factor(value: number | null | undefined, range: { min: number; max: number }): number {
  return value == null || !Number.isFinite(value) ? 1 : clamp(value, range.min, range.max);
}

export function tierFor(score: number): Tier {
  if (score >= TIER_THRESHOLDS.act) return "act";
  if (score >= TIER_THRESHOLDS.know) return "know";
  return "noise";
}

export function scoreAnnouncement(input: ScoreInput): ScoreResult {
  const raw = CATEGORY_BASE_WEIGHT[input.category] * factor(input.userWeight, USER_WEIGHT_RANGE) * factor(input.impact, IMPACT_RANGE);
  let score = Math.round(clamp(raw, 0, 100) * 10) / 10;
  if (input.pinned === "act") {
    score = Math.max(score, PINNED_MIN_SCORE);
    return { score, tier: "act" };
  }
  return { score, tier: tierFor(score) };
}
