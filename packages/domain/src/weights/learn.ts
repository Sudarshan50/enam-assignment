import { USER_WEIGHT_RANGE } from "@finn/shared/taxonomy";

export type WeightInteraction = "open" | "dismiss" | "undo_dismiss" | "pin";

export const NEUTRAL_WEIGHT = 1;

const STEP: Record<WeightInteraction, number> = {
  open: 0.03,
  pin: 0.1,
  dismiss: -0.08,
  undo_dismiss: 0.08,
};

/** Nudges a category weight after an interaction; always stays inside USER_WEIGHT_RANGE. */
export function adjustWeight(current: number | null | undefined, interaction: WeightInteraction): number {
  const base = current == null || !Number.isFinite(current) ? NEUTRAL_WEIGHT : current;
  const next = base + STEP[interaction];
  const bounded = Math.min(USER_WEIGHT_RANGE.max, Math.max(USER_WEIGHT_RANGE.min, next));
  return Math.round(bounded * 100) / 100;
}
