import { describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_BASE_WEIGHT } from "@finn/shared/taxonomy";
import { scoreAnnouncement, tierFor } from "../src/score/score";
import { adjustWeight } from "../src/weights/learn";

describe("scoreAnnouncement", () => {
  it("uses the base weight when weight and impact are neutral or missing", () => {
    expect(scoreAnnouncement({ category: "results" })).toEqual({ score: 80, tier: "act" });
    expect(scoreAnnouncement({ category: "dividend", userWeight: 1, impact: null })).toEqual({ score: 40, tier: "know" });
    expect(scoreAnnouncement({ category: "unclassified" })).toEqual({ score: 15, tier: "noise" });
  });

  it("clamps user weight to 0.4..1.6 and impact to 0.7..1.3", () => {
    expect(scoreAnnouncement({ category: "dividend", userWeight: 10, impact: 10 }).score).toBe(Math.min(100, 40 * 1.6 * 1.3));
    expect(scoreAnnouncement({ category: "dividend", userWeight: 0, impact: 0 }).score).toBe(Math.round(40 * 0.4 * 0.7 * 10) / 10);
  });

  it("stays within 0..100 for every category and extreme inputs", () => {
    for (const category of CATEGORIES) {
      for (const userWeight of [-5, 0.4, 1, 1.6, 99]) {
        for (const impact of [-5, 0.7, 1, 1.3, 99, Number.NaN]) {
          const { score } = scoreAnnouncement({ category, userWeight, impact });
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        }
      }
    }
    expect(scoreAnnouncement({ category: "results", userWeight: 1.6, impact: 1.3 }).score).toBe(100);
  });

  it("maps tiers at the thresholds", () => {
    expect(tierFor(70)).toBe("act");
    expect(tierFor(69.9)).toBe("know");
    expect(tierFor(35)).toBe("know");
    expect(tierFor(34.9)).toBe("noise");
  });

  it("pinned act forces tier act and score >= 70", () => {
    const r = scoreAnnouncement({ category: "unclassified", userWeight: 0.4, impact: 0.7, pinned: "act" });
    expect(r.tier).toBe("act");
    expect(r.score).toBe(70);
    expect(scoreAnnouncement({ category: "results", pinned: "act" }).score).toBe(CATEGORY_BASE_WEIGHT.results);
  });
});

describe("adjustWeight", () => {
  it("moves in the expected direction and stays in range", () => {
    expect(adjustWeight(1, "open")).toBeGreaterThan(1);
    expect(adjustWeight(1, "pin")).toBeGreaterThan(adjustWeight(1, "open"));
    expect(adjustWeight(1, "dismiss")).toBeLessThan(1);
    expect(adjustWeight(adjustWeight(1, "dismiss"), "undo_dismiss")).toBe(1);
    expect(adjustWeight(null, "open")).toBeGreaterThan(1);
    let w = 1;
    for (let i = 0; i < 100; i++) w = adjustWeight(w, "dismiss");
    expect(w).toBe(0.4);
    for (let i = 0; i < 100; i++) w = adjustWeight(w, "pin");
    expect(w).toBe(1.6);
  });
});
