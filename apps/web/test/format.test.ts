import { describe, expect, it } from "vitest";
import {
  formatBps,
  formatCount,
  formatInr,
  formatPct,
  formatPrice,
  formatSignedPct,
  humanizeReason,
  istDateShort,
  istDateTime,
  istTime,
  timeAgo,
} from "@/lib/format";

const MINUS = "\u2212";

describe("Indian numbering", () => {
  it("formats rupees in crore and lakh", () => {
    expect(formatInr(731_880_000_000)).toBe("₹73,188 Cr");
    expect(formatInr(12_34_56_78_901)).toBe("₹1,235 Cr");
    expect(formatInr(5_50_00_000)).toBe("₹5.5 Cr");
    expect(formatInr(4_20_000)).toBe("₹4.2 L");
    expect(formatInr(99_999)).toBe("₹99,999");
    expect(formatInr(null)).toBe("—");
  });

  it("groups prices and counts by lakh/crore, not thousands", () => {
    expect(formatPrice(123_456.789)).toBe("₹1,23,456.79");
    expect(formatPrice(1903.3)).toBe("₹1,903.30");
    expect(formatPrice(Number.NaN)).toBe("—");
    expect(formatCount(12_50_000)).toBe("12,50,000");
    expect(formatCount(12_50_000, true)).toBe("12.5 L");
    expect(formatCount(2_50_00_000, true)).toBe("2.5 Cr");
    expect(formatCount(99_999, true)).toBe("99,999");
  });
});

describe("signed percentages", () => {
  it("uses a true minus sign and an explicit plus", () => {
    expect(formatSignedPct(-1.38)).toBe(`${MINUS}1.4%`);
    expect(formatSignedPct(11.2)).toBe("+11.2%");
    expect(formatSignedPct(-26.36309, 2)).toBe(`${MINUS}26.36%`);
    expect(formatSignedPct(-1.38)).not.toContain("-");
  });

  it("does not sign values that round to zero", () => {
    expect(formatSignedPct(0)).toBe("0.0%");
    expect(formatSignedPct(-0.04)).toBe("0.0%");
    expect(formatSignedPct(0.04)).toBe("0.0%");
    expect(formatBps(-0.4)).toBe("0 bps");
  });

  it("formats basis points with Indian grouping", () => {
    expect(formatBps(-7)).toBe(`${MINUS}7 bps`);
    expect(formatBps(1234.4)).toBe("+1,234 bps");
    expect(formatBps(undefined)).toBe("—");
  });

  it("keeps the shared ASCII formatPct for compact labels", () => {
    expect(formatPct(2.5)).toBe("+2.5%");
    expect(formatPct(null)).toBe("—");
  });

  it("humanises reason codes with acronyms and true minus", () => {
    expect(humanizeReason("pat_yoy_-14.9%")).toBe(`PAT YoY ${MINUS}14.9%`);
    expect(humanizeReason("revenue_qoq_+1.3%")).toBe("Revenue QoQ +1.3%");
    expect(humanizeReason("volume_2.5x")).toBe("Volume 2.5×");
    expect(humanizeReason("Already readable text")).toBe("Already readable text");
  });

  it("drops classifier provenance codes the live API emits and humanises the rest", () => {
    for (const code of ["category:results", "subject:generic", "text:fund_raise", "impact:1.05", "impact:abc", "category:"]) {
      expect(humanizeReason(code)).toBeNull();
    }
    expect(humanizeReason("impact:1.25")).toBe("Large for the company");
    expect(humanizeReason("impact:0.8")).toBe("Minor for the company");
    expect(humanizeReason("size:small_vs_mcap")).toBe("Small vs MCAP");
    expect(humanizeReason("seniority:kmp")).toBe("KMP");
    expect(humanizeReason("action:reaffirm")).toBe("Reaffirm");
    expect(humanizeReason("llm_unavailable")).toBe("Rule-classified");
    expect(humanizeReason("qoq_revenue_up")).toBe("QoQ revenue up");
  });
});

describe("time in IST", () => {
  const now = new Date("2026-11-15T08:38:00.000Z"); // 14:08 IST

  it("renders clock time and dates in Asia/Kolkata regardless of host timezone", () => {
    expect(istTime("2026-11-15T08:38:00.000Z")).toBe("14:08");
    expect(istDateShort("2026-11-14T19:00:00.000Z")).toBe("15 Nov"); // 00:30 IST next day
    expect(istDateTime("2026-11-15T08:38:00.000Z")).toBe("15 Nov, 14:08 IST");
  });

  it("buckets relative times", () => {
    const ago = (ms: number) => timeAgo(new Date(now.getTime() - ms).toISOString(), now);
    expect(ago(30_000)).toBe("just now");
    expect(ago(12 * 60_000)).toBe("12m ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
    expect(ago(30 * 3_600_000)).toBe("yesterday");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
  });

  it("clamps future timestamps to just now", () => {
    expect(timeAgo("2026-11-15T09:00:00.000Z", now)).toBe("just now");
  });

  it("falls back to an IST calendar date after a week", () => {
    // 2026-11-01T20:00Z is 2 Nov 01:30 in India; a UTC formatter would say 1 Nov.
    expect(timeAgo("2026-11-01T20:00:00.000Z", now)).toBe("2 Nov");
  });
});
