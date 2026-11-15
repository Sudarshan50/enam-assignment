import { describe, expect, it } from "vitest";
import { clusterKey, inferPeriodEnd, latestQuarterEndBefore, pickClusterHead } from "../src/cluster/clusterKey";

const ist = (s: string) => new Date(`${s}+05:30`);

describe("clusterKey", () => {
  it("clusters results by fiscal period, not by day", () => {
    const outcome = clusterKey({ symbol: "tcs", category: "results", publishedAt: ist("2026-10-09T16:10:00"), periodEnd: "2026-09-30" });
    const xbrl = clusterKey({ symbol: "TCS", category: "results", publishedAt: ist("2026-10-10T09:00:00"), periodEnd: "2026-09-30" });
    expect(outcome).toBe("TCS:results:2026-09-30");
    expect(xbrl).toBe(outcome);
  });

  it("defaults the results period to the latest quarter end before publication", () => {
    expect(clusterKey({ symbol: "TCS", category: "results", publishedAt: ist("2026-11-13T21:00:00") })).toBe("TCS:results:2026-09-30");
  });

  it("clusters other categories by IST day (late-evening UTC lands on the next IST day)", () => {
    const a = clusterKey({ symbol: "TRENT", category: "management_change", publishedAt: new Date("2026-11-13T19:00:00Z") });
    expect(a).toBe("TRENT:management_change:2026-11-14");
    const b = clusterKey({ symbol: "TRENT", category: "management_change", publishedAt: ist("2026-11-14T09:00:00") });
    expect(b).toBe(a);
    expect(clusterKey({ symbol: "TRENT", category: "dividend", publishedAt: ist("2026-11-14T09:00:00") })).not.toBe(a);
  });
});

describe("pickClusterHead", () => {
  it("prefers highest score, then earliest, then lowest seq id", () => {
    const t = (h: number) => new Date(Date.UTC(2026, 10, 13, h));
    expect(pickClusterHead([])).toBeNull();
    expect(
      pickClusterHead([
        { seqId: "3", score: 40, publishedAt: t(1) },
        { seqId: "2", score: 80, publishedAt: t(3) },
        { seqId: "1", score: 80, publishedAt: t(2) },
      ])?.seqId,
    ).toBe("1");
    expect(
      pickClusterHead([
        { seqId: "b", score: 50, publishedAt: t(1) },
        { seqId: "a", score: 50, publishedAt: t(1) },
      ])?.seqId,
    ).toBe("a");
    expect(pickClusterHead([{ seqId: "x", score: null, publishedAt: t(1) }, { seqId: "y", score: 10, publishedAt: t(2) }])?.seqId).toBe("y");
  });
});

describe("period inference", () => {
  it("finds the quarter end in common NSE phrasings", () => {
    const pub = ist("2026-11-13T18:00:00");
    expect(inferPeriodEnd("results for the quarter and half year ended 30th September, 2026", pub)).toBe("2026-09-30");
    expect(inferPeriodEnd("for the period ended September 30, 2026", pub)).toBe("2026-09-30");
    expect(inferPeriodEnd("quarter ended 30.09.2026 compared with 31.03.2026", pub)).toBe("2026-09-30");
    expect(inferPeriodEnd("Board meeting held on 13-11-2026", pub)).toBe("2026-09-30");
  });

  it("ignores future and non-quarter-end dates", () => {
    expect(inferPeriodEnd("record date 31-12-2026", ist("2026-11-13T18:00:00"))).toBe("2026-09-30");
    expect(latestQuarterEndBefore(ist("2026-04-01T10:00:00"))).toBe("2026-03-31");
    expect(latestQuarterEndBefore(ist("2026-03-31T10:00:00"))).toBe("2025-12-31");
    expect(latestQuarterEndBefore(ist("2026-01-05T10:00:00"))).toBe("2025-12-31");
  });
});
