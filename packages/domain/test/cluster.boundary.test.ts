import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@finn/shared/taxonomy";
import { clusterKey, inferPeriodEnd, latestQuarterEndBefore, pickClusterHead, type ClusterMember } from "../src/cluster/clusterKey";

const ist = (s: string) => new Date(`${s}+05:30`);

describe("clusterKey IST day boundary", () => {
  const late = ist("2026-11-13T23:59:00");
  const early = ist("2026-11-14T00:01:00");

  it("23:59 and 00:01 IST are different days for non-results categories", () => {
    for (const category of CATEGORIES.filter((c) => c !== "results")) {
      expect(clusterKey({ symbol: "ZTDALPHA", category, publishedAt: late })).toBe(`ZTDALPHA:${category}:2026-11-13`);
      expect(clusterKey({ symbol: "ZTDALPHA", category, publishedAt: early })).toBe(`ZTDALPHA:${category}:2026-11-14`);
    }
  });

  it("the boundary is IST midnight, not UTC midnight", () => {
    // 18:29 UTC = 23:59 IST; 18:31 UTC = 00:01 IST next day.
    expect(clusterKey({ symbol: "ZTDALPHA", category: "dividend", publishedAt: new Date("2026-11-13T18:29:00Z") })).toBe("ZTDALPHA:dividend:2026-11-13");
    expect(clusterKey({ symbol: "ZTDALPHA", category: "dividend", publishedAt: new Date("2026-11-13T18:31:00Z") })).toBe("ZTDALPHA:dividend:2026-11-14");
    // 23:00 UTC is 04:30 IST the next day.
    expect(clusterKey({ symbol: "ZTDALPHA", category: "dividend", publishedAt: new Date("2026-11-13T23:00:00Z") })).toBe("ZTDALPHA:dividend:2026-11-14");
  });

  it("results ignore the day boundary when the period is known", () => {
    const a = clusterKey({ symbol: "ZTDALPHA", category: "results", publishedAt: late, periodEnd: "2026-09-30" });
    const b = clusterKey({ symbol: "ZTDALPHA", category: "results", publishedAt: early, periodEnd: "2026-09-30" });
    expect(a).toBe(b);
    expect(a).toBe("ZTDALPHA:results:2026-09-30");
  });

  it("results without a period fall into the latest quarter end before the IST publish date", () => {
    expect(clusterKey({ symbol: "ZTDALPHA", category: "results", publishedAt: ist("2026-09-30T23:59:00") })).toBe("ZTDALPHA:results:2026-06-30");
    expect(clusterKey({ symbol: "ZTDALPHA", category: "results", publishedAt: ist("2026-10-01T00:01:00") })).toBe("ZTDALPHA:results:2026-09-30");
    // Same two instants, different periods: results filed on quarter-end day belong to the prior quarter.
    expect(clusterKey({ symbol: "ZTDALPHA", category: "results", publishedAt: new Date("2026-09-30T18:31:00Z") })).toBe("ZTDALPHA:results:2026-09-30");
  });

  it("an explicit null period behaves like a missing one", () => {
    expect(clusterKey({ symbol: "ztdalpha", category: "results", publishedAt: early, periodEnd: null })).toBe("ZTDALPHA:results:2026-09-30");
  });

  it("symbols are upper-cased so case variants share a cluster", () => {
    expect(clusterKey({ symbol: "ztdAlpha", category: "capex", publishedAt: late })).toBe(clusterKey({ symbol: "ZTDALPHA", category: "capex", publishedAt: late }));
  });
});

describe("latestQuarterEndBefore", () => {
  it.each([
    ["2026-01-01T00:01:00", "2025-12-31"],
    ["2026-03-31T23:59:00", "2025-12-31"],
    ["2026-04-01T00:00:00", "2026-03-31"],
    ["2026-06-30T12:00:00", "2026-03-31"],
    ["2026-07-01T00:00:00", "2026-06-30"],
    ["2026-12-31T23:59:00", "2026-09-30"],
  ])("%s IST -> %s", (at, expected) => {
    expect(latestQuarterEndBefore(ist(at))).toBe(expected);
  });
});

describe("inferPeriodEnd", () => {
  const pub = ist("2026-11-13T18:00:00");

  it("picks the latest quarter end mentioned, across formats", () => {
    expect(inferPeriodEnd("Results for 30th June 2026 and 30th September, 2026", pub)).toBe("2026-09-30");
    expect(inferPeriodEnd("for the half year ended Sept. 30, 2026", pub)).toBe("2026-09-30");
    expect(inferPeriodEnd("quarter ended 31/03/2026", pub)).toBe("2026-03-31");
    expect(inferPeriodEnd("as at 31st Dec 2025", pub)).toBe("2025-12-31");
  });

  it("ignores dates on or after the publish date and non-quarter-end dates", () => {
    expect(inferPeriodEnd("quarter ended 30-09-2026", ist("2026-09-30T20:00:00"))).toBe("2026-06-30");
    expect(inferPeriodEnd("meeting on 15 October 2026", pub)).toBe("2026-09-30");
    expect(inferPeriodEnd("", pub)).toBe("2026-09-30");
  });

  it("ignores unknown month names", () => {
    expect(inferPeriodEnd("30 Foo 2026", pub)).toBe("2026-09-30");
  });
});

describe("pickClusterHead", () => {
  const t = (iso: string) => new Date(iso);
  const m = (seqId: string, score: number | null, at: string): ClusterMember => ({ seqId, score, publishedAt: t(at) });

  it("highest score wins regardless of order", () => {
    const items = [m("a", 40, "2026-11-13T10:00:00Z"), m("b", 90, "2026-11-13T12:00:00Z"), m("c", 60, "2026-11-13T09:00:00Z")];
    expect(pickClusterHead(items)?.seqId).toBe("b");
    expect(pickClusterHead([...items].reverse())?.seqId).toBe("b");
  });

  it("score ties go to the earliest filing, then the lowest seq id", () => {
    expect(pickClusterHead([m("x2", 70, "2026-11-13T11:00:00Z"), m("x1", 70, "2026-11-13T10:00:00Z")])?.seqId).toBe("x1");
    expect(pickClusterHead([m("200", 70, "2026-11-13T10:00:00Z"), m("100", 70, "2026-11-13T10:00:00Z")])?.seqId).toBe("100");
  });

  it("null scores lose to any scored member and tie among themselves by time", () => {
    expect(pickClusterHead([m("n1", null, "2026-11-13T09:00:00Z"), m("s", 0, "2026-11-13T12:00:00Z")])?.seqId).toBe("s");
    expect(pickClusterHead([m("n2", null, "2026-11-13T12:00:00Z"), m("n1", null, "2026-11-13T09:00:00Z")])?.seqId).toBe("n1");
  });

  it("is permutation-invariant (deterministic head for every ordering)", () => {
    const items = [
      m("106860004", 70, "2026-11-13T10:00:00Z"),
      m("106860005", 70, "2026-11-13T10:00:00Z"),
      m("106860001", 65, "2026-11-13T08:00:00Z"),
      m("106860009", null, "2026-11-13T07:00:00Z"),
    ];
    const permutations = (xs: ClusterMember[]): ClusterMember[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of permutations(items)) expect(pickClusterHead(p)?.seqId).toBe("106860004");
  });

  it("returns the single member and null for an empty cluster", () => {
    expect(pickClusterHead([m("only", null, "2026-11-13T10:00:00Z")])?.seqId).toBe("only");
    expect(pickClusterHead([])).toBeNull();
  });
});
