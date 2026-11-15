import { describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_BASE_WEIGHT, IMPACT_RANGE, TIER_THRESHOLDS, USER_WEIGHT_RANGE } from "@finn/shared/taxonomy";
import { clamp, PINNED_MIN_SCORE, scoreAnnouncement, tierFor } from "../src/score/score";
import { adjustWeight, NEUTRAL_WEIGHT, type WeightInteraction } from "../src/weights/learn";

const WEIGHTS = [Number.NEGATIVE_INFINITY, -1, 0, 0.39, 0.4, 0.7, 1, 1.3, 1.6, 1.61, 5, Number.POSITIVE_INFINITY, Number.NaN, null, undefined];
const IMPACTS = [Number.NEGATIVE_INFINITY, -1, 0, 0.69, 0.7, 1, 1.3, 1.31, 5, Number.POSITIVE_INFINITY, Number.NaN, null, undefined];

/** Small deterministic PRNG so the "random" sweep is reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const effective = (v: number | null | undefined, range: { min: number; max: number }) => (v == null || !Number.isFinite(v) ? 1 : clamp(v, range.min, range.max));

describe("scoreAnnouncement properties over every category × weight × impact", () => {
  const grid = CATEGORIES.flatMap((category) => WEIGHTS.flatMap((userWeight) => IMPACTS.map((impact) => ({ category, userWeight, impact }))));

  it("score is always a finite number in 0..100 with one decimal", () => {
    for (const input of grid) {
      const { score } = scoreAnnouncement(input);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      expect(Math.round(score * 10) / 10).toBe(score);
    }
  });

  it("matches base × clamped weight × clamped impact (missing or non-finite = neutral)", () => {
    for (const input of grid) {
      const raw = CATEGORY_BASE_WEIGHT[input.category] * effective(input.userWeight, USER_WEIGHT_RANGE) * effective(input.impact, IMPACT_RANGE);
      expect(scoreAnnouncement(input).score).toBe(Math.round(Math.min(100, raw) * 10) / 10);
    }
  });

  it("tier is always the tier of the score when not pinned", () => {
    for (const input of grid) {
      const r = scoreAnnouncement(input);
      expect(r.tier).toBe(tierFor(r.score));
    }
  });

  it("pinned act always yields tier act and score >= 70, never lowering a higher score", () => {
    for (const input of grid) {
      const plain = scoreAnnouncement(input);
      const pinned = scoreAnnouncement({ ...input, pinned: "act" });
      expect(pinned.tier).toBe("act");
      expect(pinned.score).toBeGreaterThanOrEqual(PINNED_MIN_SCORE);
      expect(pinned.score).toBe(Math.max(plain.score, PINNED_MIN_SCORE));
    }
  });

  it("is monotonic non-decreasing in user weight and impact", () => {
    const rnd = lcg(42);
    for (let i = 0; i < 2000; i++) {
      const category = CATEGORIES[Math.floor(rnd() * CATEGORIES.length)]!;
      const w1 = rnd() * 2;
      const w2 = w1 + rnd();
      const i1 = 0.5 + rnd();
      const i2 = i1 + rnd() * 0.5;
      expect(scoreAnnouncement({ category, userWeight: w2, impact: i1 }).score).toBeGreaterThanOrEqual(scoreAnnouncement({ category, userWeight: w1, impact: i1 }).score);
      expect(scoreAnnouncement({ category, userWeight: w1, impact: i2 }).score).toBeGreaterThanOrEqual(scoreAnnouncement({ category, userWeight: w1, impact: i1 }).score);
    }
  });

  it("extremes: max inputs clamp to 100 only where the base allows it", () => {
    for (const category of CATEGORIES) {
      const max = scoreAnnouncement({ category, userWeight: 99, impact: 99 }).score;
      const min = scoreAnnouncement({ category, userWeight: -99, impact: -99 }).score;
      expect(max).toBe(Math.min(100, Math.round(CATEGORY_BASE_WEIGHT[category] * 1.6 * 1.3 * 10) / 10));
      expect(min).toBe(Math.round(CATEGORY_BASE_WEIGHT[category] * 0.4 * 0.7 * 10) / 10);
      expect(min).toBeGreaterThan(0);
    }
    // results 80 × 1.6 × 1.3 = 166.4 -> clamped.
    expect(scoreAnnouncement({ category: "results", userWeight: 1.6, impact: 1.3 }).score).toBe(100);
  });

  it("neutral inputs land each category in its intended tier", () => {
    const expectedTier = (base: number) => (base >= 70 ? "act" : base >= 35 ? "know" : "noise");
    for (const category of CATEGORIES) expect(scoreAnnouncement({ category }).tier).toBe(expectedTier(CATEGORY_BASE_WEIGHT[category]));
  });
});

describe("tier boundaries", () => {
  it.each([
    [0, "noise"],
    [34.99, "noise"],
    [35, "know"],
    [69.99, "know"],
    [70, "act"],
    [100, "act"],
  ] as const)("tierFor(%s) = %s", (score, tier) => {
    expect(tierFor(score)).toBe(tier);
  });

  it("thresholds come from the shared taxonomy", () => {
    expect(TIER_THRESHOLDS).toEqual({ act: 70, know: 35 });
    expect(PINNED_MIN_SCORE).toBe(70);
  });

  it("scores that round up across a boundary take the rounded tier", () => {
    // press_release 35 × 0.999 = 34.965 -> 35.0 -> know.
    expect(scoreAnnouncement({ category: "press_release", userWeight: 0.999 })).toEqual({ score: 35, tier: "know" });
    // press_release 35 × 0.998 = 34.93 -> 34.9 -> noise.
    expect(scoreAnnouncement({ category: "press_release", userWeight: 0.998 })).toEqual({ score: 34.9, tier: "noise" });
    // management_change 72 × 0.972 = 69.984 -> 70.0 -> act.
    expect(scoreAnnouncement({ category: "management_change", userWeight: 0.972 })).toEqual({ score: 70, tier: "act" });
    expect(scoreAnnouncement({ category: "management_change", userWeight: 0.97 })).toEqual({ score: 69.8, tier: "know" });
  });
});

describe("clamp", () => {
  it("bounds values inclusively", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 0)).toBe(0);
  });
});

describe("adjustWeight", () => {
  const interactions: WeightInteraction[] = ["open", "dismiss", "undo_dismiss", "pin"];

  it("treats missing and non-finite weights as neutral", () => {
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(adjustWeight(bad, "open")).toBe(adjustWeight(NEUTRAL_WEIGHT, "open"));
  });

  it("applies the documented steps rounded to 2 dp", () => {
    expect(adjustWeight(1, "open")).toBe(1.03);
    expect(adjustWeight(1, "pin")).toBe(1.1);
    expect(adjustWeight(1, "dismiss")).toBe(0.92);
    expect(adjustWeight(1, "undo_dismiss")).toBe(1.08);
    expect(adjustWeight(0.333333, "open")).toBe(0.4);
  });

  it("never leaves the user weight range from any start, after any random sequence", () => {
    const rnd = lcg(7);
    let w: number = 1;
    for (let i = 0; i < 5000; i++) {
      w = adjustWeight(i % 997 === 0 ? (rnd() - 0.5) * 100 : w, interactions[Math.floor(rnd() * interactions.length)]!);
      expect(w).toBeGreaterThanOrEqual(USER_WEIGHT_RANGE.min);
      expect(w).toBeLessThanOrEqual(USER_WEIGHT_RANGE.max);
    }
  });

  it("undo cancels a dismiss away from the bounds", () => {
    for (const start of [0.6, 0.8, 1, 1.2, 1.5]) expect(adjustWeight(adjustWeight(start, "dismiss"), "undo_dismiss")).toBe(start);
  });
});
