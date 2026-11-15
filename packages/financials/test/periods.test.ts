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
});
