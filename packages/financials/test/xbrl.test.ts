import { describe, expect, it } from "vitest";
import { parseIntegratedXbrl, XbrlParseError } from "../src/xbrl/parse";
import { cr, filing, FIXTURE_FILES, readXml } from "./helpers";

describe("parseIntegratedXbrl", () => {
  it("reads TCS Q2 FY27 OneD revenue exactly, in rupees", () => {
    const f = filing("TCS", "30-SEP-2026");
    expect(f.byContext.OneD.RevenueFromOperations).toBe(731_880_000_000);
    expect(f.byContext.FourD.RevenueFromOperations).toBe(1_454_630_000_000);
    expect(f).toMatchObject({
      statementFamily: "industrial",
      basis: "consolidated",
      audited: true,
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      ytdStart: "2026-04-01",
      currency: "INR",
      taxonomy: "IntegratedFinance_IndAS/2026-01-31",
      symbol: "TCS",
    });
    const fact = f.facts.find((x) => x.concept === "RevenueFromOperations" && x.context === "OneD");
    expect(fact).toEqual({ concept: "RevenueFromOperations", context: "OneD", value: 731_880_000_000, unit: "INR", decimals: "-7" });
  });

  it("keeps only the four core contexts, ignoring segment and line-item contexts", () => {
    const f = filing("TCS", "30-SEP-2026");
    expect(new Set(f.facts.map((x) => x.context))).toEqual(new Set(["OneD", "FourD", "OneI", "PY_I"]));
    // Segment revenue lives in dimensioned contexts as well; only the undimensioned total is kept.
    expect(f.facts.filter((x) => x.concept === "SegmentRevenue" && x.context === "OneD")).toHaveLength(1);
  });

  it("Q4 filings carry OneD for Jan-Mar and FourD for the full year", () => {
    const f = filing("TCS", "31-MAR-2026");
    expect([f.periodStart, f.periodEnd, f.ytdStart]).toEqual(["2026-01-01", "2026-03-31", "2025-04-01"]);
    expect(f.byContext.OneD.RevenueFromOperations).toBe(cr(70698));
    expect(f.byContext.FourD.RevenueFromOperations).toBe(cr(267021));
  });

  it("OneD is never FourD, nor a sum of the two", () => {
    for (const file of FIXTURE_FILES) {
      const f = parseIntegratedXbrl(readXml(file));
      const q = f.byContext.OneD;
      const ytd = f.byContext.FourD;
      const key = f.statementFamily === "banking" ? "InterestEarned" : "RevenueFromOperations";
      if (f.ytdStart === null) {
        expect(Object.keys(ytd)).toHaveLength(0);
        continue;
      }
      expect(q[key]).toBeLessThan(ytd[key]!);
      expect(q[key]).not.toBe(ytd[key]! + q[key]!);
    }
  });

  it("Q1 filings have no FourD (the YTD is the quarter)", () => {
    const f = filing("HDFCBANK", "30-JUN-2026");
    expect(f.ytdStart).toBeNull();
    expect(f.periodStart).toBe("2026-04-01");
  });

  it("detects family and audit status from the filing's own concepts", () => {
    expect(filing("HDFCBANK", "30-SEP-2026")).toMatchObject({ statementFamily: "banking", audited: false, companyName: "HDFC Bank Limited" });
    expect(filing("HDFCBANK", "31-MAR-2026").audited).toBe(true);
    expect(filing("BAJFINANCE", "30-SEP-2026")).toMatchObject({ statementFamily: "nbfc", audited: false, taxonomy: "IntegratedFinance_NBFC/2026-01-31" });
    expect(filing("BAJFINANCE", "30-SEP-2025").taxonomy).toBe("IntegratedFinance_NBFC/2025-01-31");
  });

  it("falls back to concept presence when the namespace is unknown", () => {
    const xml = readXml("HDFCBANK_30-SEP-2026_consolidated.xml").replace(/IntegratedFinance_Banking/g, "SomethingElse");
    expect(parseIntegratedXbrl(xml).statementFamily).toBe("banking");
  });

  it("rejects documents without a quarter context or basis", () => {
    expect(() => parseIntegratedXbrl("<html/>")).toThrow(XbrlParseError);
    const noBasis = readXml("TCS_30-SEP-2026_consolidated.xml").replace(/<in-capmkt:NatureOfReportStandaloneConsolidated[^>]*>[^<]*<\/in-capmkt:NatureOfReportStandaloneConsolidated>/g, "");
    expect(() => parseIntegratedXbrl(noBasis)).toThrow(/standalone\/consolidated/);
    expect(parseIntegratedXbrl(noBasis, { fallbackBasis: "standalone" }).basis).toBe("standalone");
  });
});
