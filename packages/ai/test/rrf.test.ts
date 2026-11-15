import { describe, expect, it } from "vitest";
import { rrfFuse } from "../src/retrieval/rrf";

describe("rrfFuse", () => {
  it("scores by 1/(k + rank) summed across lists", () => {
    const fused = rrfFuse([["a", "b", "c"], ["b", "d"]], 60);
    const b = fused.find((f) => f.id === "b")!;
    expect(b.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(b.ranks).toEqual([2, 1]);
    expect(fused[0]!.id).toBe("b");
  });

  it("rewards agreement between lists over a single top rank", () => {
    const fused = rrfFuse([["x", "both"], ["y", "both"]]);
    expect(fused[0]!.id).toBe("both");
  });

  it("keeps items present in only one list with a null rank elsewhere", () => {
    const fused = rrfFuse([["a"], []]);
    expect(fused).toEqual([{ id: "a", score: 1 / 61, ranks: [1, null] }]);
  });

  it("ignores duplicate ids within one list", () => {
    const fused = rrfFuse([["a", "a", "b"]]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[1]!.score).toBeCloseTo(1 / 63, 10);
  });

  it("breaks ties by first appearance", () => {
    const fused = rrfFuse([["p", "q"], ["q", "p"]]);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 12);
    expect(fused.map((f) => f.id)).toEqual(["p", "q"]);
  });

  it("returns an empty list for empty input", () => {
    expect(rrfFuse([])).toEqual([]);
  });
});
