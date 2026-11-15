import { describe, expect, it } from "vitest";
import { fiscalQuarterLabel, fiscalYtdLabel, isQuarterEnd, previousQuarterEnd, shiftQuarterEnd, yearAgoQuarterEnd } from "../src/results/periods";

describe("quarter math", () => {
  it("steps back across year boundaries", () => {
    expect(previousQuarterEnd("2026-09-30")).toBe("2026-06-30");
    expect(previousQuarterEnd("2026-03-31")).toBe("2025-12-31");
    expect(previousQuarterEnd("2026-06-30")).toBe("2026-03-31");
    expect(yearAgoQuarterEnd("2026-09-30")).toBe("2025-09-30");
    expect(shiftQuarterEnd("2025-12-31", 1)).toBe("2026-03-31");
  });

  it("labels fiscal periods", () => {
    expect(fiscalQuarterLabel("2026-09-30")).toBe("Q2 FY27");
    expect(fiscalQuarterLabel("2026-03-31")).toBe("Q4 FY26");
    expect(fiscalYtdLabel("2026-04-01", "2026-09-30")).toBe("H1 FY27");
    expect(fiscalYtdLabel("2025-04-01", "2025-12-31")).toBe("9M FY26");
    expect(fiscalYtdLabel("2025-04-01", "2026-03-31")).toBe("FY26");
    expect(isQuarterEnd("2026-09-30")).toBe(true);
    expect(isQuarterEnd("2026-09-29")).toBe(false);
  });

  it("year-ago and multi-year shifts cross calendar and fiscal year boundaries", () => {
    expect(yearAgoQuarterEnd("2026-03-31")).toBe("2025-03-31");
    expect(yearAgoQuarterEnd("2026-12-31")).toBe("2025-12-31");
    expect(previousQuarterEnd("2027-03-31")).toBe("2026-12-31");
    expect(shiftQuarterEnd("2026-06-30", -2)).toBe("2025-12-31");
    expect(shiftQuarterEnd("2026-06-30", -5)).toBe("2025-03-31");
    expect(shiftQuarterEnd("2026-09-30", 4)).toBe("2027-09-30");
    expect(shiftQuarterEnd("2026-12-31", 1)).toBe("2027-03-31");
    expect(shiftQuarterEnd("2000-03-31", -1)).toBe("1999-12-31");
  });

  it("walking back four quarters from any quarter end lands on the same date a year earlier", () => {
    let q = "2027-12-31";
    for (let i = 0; i < 16; i++) {
      const prev = previousQuarterEnd(q);
      expect(isQuarterEnd(prev)).toBe(true);
      expect(shiftQuarterEnd(prev, 1)).toBe(q);
      expect(shiftQuarterEnd(q, -4)).toBe(`${Number(q.slice(0, 4)) - 1}${q.slice(4)}`);
      q = prev;
    }
  });

  it("labels each quarter of a fiscal year", () => {
    expect(["2026-06-30", "2026-09-30", "2026-12-31", "2027-03-31"].map(fiscalQuarterLabel)).toEqual(["Q1 FY27", "Q2 FY27", "Q3 FY27", "Q4 FY27"]);
    expect(fiscalQuarterLabel("2025-12-31")).toBe("Q3 FY26");
    expect(fiscalQuarterLabel("2026-03-31")).toBe("Q4 FY26");
    expect(fiscalQuarterLabel("2099-12-31")).toBe("Q3 FY00");
  });

  it("labels YTD windows: Q1 reads as the quarter, then H1, 9M and the full year", () => {
    expect(fiscalYtdLabel("2026-04-01", "2026-06-30")).toBe("Q1 FY27");
    expect(fiscalYtdLabel("2026-04-01", "2026-09-30")).toBe("H1 FY27");
    expect(fiscalYtdLabel("2026-04-01", "2026-12-31")).toBe("9M FY27");
    expect(fiscalYtdLabel("2026-04-01", "2027-03-31")).toBe("FY27");
    expect(fiscalYtdLabel("2025-01-01", "2026-03-31")).toBe("FY26");
  });

  it("only accepts canonical quarter-end dates", () => {
    expect(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"].every(isQuarterEnd)).toBe(true);
    for (const d of ["2026-06-31", "2026-03-30", "2026-6-30", "2026-12-31T00:00:00Z", "30-SEP-2026", ""]) expect(isQuarterEnd(d)).toBe(false);
  });
});
