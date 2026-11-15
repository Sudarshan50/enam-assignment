import { describe, expect, it } from "vitest";
import { strategyFor } from "../src/metrics/registry";
import type { HeadlineMetricKey } from "../src/types";
import { CORE_CONTEXTS, readXbrlDocument } from "../src/xbrl/document";
import { detectTaxonomy } from "../src/xbrl/family";
import { parseIntegratedXbrl, XbrlParseError } from "../src/xbrl/parse";
import { BANKING_Q, cr, filing, FIXTURE_FILES, INDUSTRIAL_Q, NBFC_Q, readXml, syntheticXbrl } from "./helpers";

/** First numeric (unitRef-bearing, non-nil) element per context|concept, read with a regex independent of the parser. */
function rawNumericFacts(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of xml.matchAll(/<[\w-]+:(\w+)\s([^>]*?)>([^<]*)<\//g)) {
    const [, concept, attrs, text] = m as unknown as [string, string, string, string];
    const ctx = /contextRef="([^"]+)"/.exec(attrs)?.[1];
    if (!ctx || !/unitRef="/.test(attrs) || /nil="true"/.test(attrs) || text.trim() === "") continue;
    const key = `${ctx}|${concept}`;
    if (!out.has(key)) out.set(key, Number(text.trim()));
  }
  return out;
}

const MONTHS: Record<string, string> = { MAR: "03", JUN: "06", SEP: "09", DEC: "12" };

describe.each(FIXTURE_FILES)("XBRL invariants: %s", (file) => {
  const xml = readXml(file);
  const f = parseIntegratedXbrl(xml);
  const [, day, mon, year] = /_(\d{2})-([A-Z]{3})-(\d{4})_/.exec(file)! as unknown as [string, string, string, string];

  it("covers exactly the quarter named in the filename, with FourD from 1 April", () => {
    const endMonth = Number(MONTHS[mon]);
    expect(f.periodEnd).toBe(`${year}-${MONTHS[mon]}-${day}`);
    expect(f.periodStart).toBe(`${year}-${String(endMonth - 2).padStart(2, "0")}-01`);
    const fyStartYear = endMonth <= 3 ? Number(year) - 1 : Number(year);
    expect(f.ytdStart).toBe(mon === "JUN" ? null : `${fyStartYear}-04-01`);
    if (mon === "MAR") expect([f.periodStart, f.periodEnd]).toEqual([`${year}-01-01`, `${year}-03-31`]);
  });

  it("byContext is exactly the facts, keyed by the four core contexts", () => {
    expect(Object.keys(f.byContext).sort()).toEqual([...CORE_CONTEXTS].sort());
    for (const fact of f.facts) expect(f.byContext[fact.context][fact.concept]).toBe(fact.value);
    for (const ctx of CORE_CONTEXTS) {
      expect(Object.keys(f.byContext[ctx])).toHaveLength(f.facts.filter((x) => x.context === ctx).length);
    }
    expect(new Set(f.facts.map((x) => `${x.context}|${x.concept}`)).size).toBe(f.facts.length);
  });

  it("every value is the filing's own figure for that context: never summed, scaled or borrowed", () => {
    const raw = rawNumericFacts(xml);
    for (const fact of f.facts) expect(fact.value).toBe(raw.get(`${fact.context}|${fact.concept}`));
    const ytd = f.byContext.FourD;
    for (const [concept, q] of Object.entries(f.byContext.OneD)) {
      const y = ytd[concept];
      if (y !== undefined && y !== 0) expect(q).not.toBe(q + y);
    }
  });

  it("monetary facts are absolute rupees at their stated rounding", () => {
    const topLine = f.statementFamily === "banking" ? "InterestEarned" : "RevenueFromOperations";
    expect(f.byContext.OneD[topLine]).toBeGreaterThan(cr(1000));
    for (const fact of f.facts.filter((x) => x.unit === "INR")) {
      expect(Number.isInteger(fact.value)).toBe(true);
      const d = Number(fact.decimals);
      if (Number.isInteger(d) && d < 0) expect(Math.abs(fact.value) % 10 ** -d).toBe(0);
    }
    for (const fact of f.facts.filter((x) => x.unit === "INRPerShare")) expect(Math.abs(fact.value)).toBeLessThan(10_000);
  });

  it("family matches the NSE filename family and is detected from the namespace", () => {
    const expected = file.startsWith("HDFCBANK") ? "banking" : file.startsWith("BAJFINANCE") ? "nbfc" : "industrial";
    expect(f.statementFamily).toBe(expected);
    expect(f.taxonomy).toMatch(/^IntegratedFinance_(IndAS|Banking|NBFC)\/\d{4}-\d{2}-\d{2}$/);
    expect(f.basis).toBe("consolidated");
    expect(f.currency).toBe("INR");
  });
});

describe("H1 FourD equals the sum of the Q1 and Q2 OneD filings", () => {
  const h1 = (symbol: string) => {
    const q1 = filing(symbol, "30-JUN-2026");
    const q2 = filing(symbol, "30-SEP-2026");
    const strategy = strategyFor(q2.statementFamily);
    const byKey = (f: typeof q1, ctx: "OneD" | "FourD") => new Map(strategy.headline(f, ctx).map((m) => [m.key, m.value]));
    return { q1: byKey(q1, "OneD"), q2: byKey(q2, "OneD"), ytd: byKey(q2, "FourD") };
  };

  it.each<[string, HeadlineMetricKey[]]>([
    ["TCS", ["revenue", "ebitda", "pbt", "pat", "pat_owners"]],
    ["HDFCBANK", ["nii", "ppop", "provisions", "pat", "total_income"]],
    ["BAJFINANCE", ["revenue", "nii", "ppop", "provisions", "pbt", "pat", "pat_owners"]],
  ])("%s", (symbol, keys) => {
    const { q1, q2, ytd } = h1(symbol);
    for (const key of keys) expect(ytd.get(key)).toBe(q2.get(key)! + q1.get(key)!);
  });

  it("HDFCBANK H1 PBT carries a Q1 exceptional item the Q1 filing did not report", () => {
    const { q1, q2, ytd } = h1("HDFCBANK");
    expect(ytd.get("pbt")! - (q1.get("pbt")! + q2.get("pbt")!)).toBe(-cr(1137.98));
    expect(filing("HDFCBANK", "30-JUN-2026").byContext.OneD.ExceptionalItems).toBe(0);
    expect(filing("HDFCBANK", "30-SEP-2026").byContext.FourD.ExceptionalItems).toBe(-cr(1975.04));
  });
});

const INDUSTRIAL_XML = syntheticXbrl({ taxonomy: "IndAS", periodStart: "2026-07-01", periodEnd: "2026-09-30", ytdStart: "2026-04-01", oneD: INDUSTRIAL_Q, fourD: INDUSTRIAL_Q });

describe("synthetic minimal filings", () => {
  it.each([
    ["IndAS", INDUSTRIAL_Q, "industrial"],
    ["Banking", BANKING_Q, "banking"],
    ["NBFC", NBFC_Q, "nbfc"],
  ] as const)("parses a minimal %s filing and its identities reconcile", (taxonomy, oneD, family) => {
    const f = parseIntegratedXbrl(syntheticXbrl({ taxonomy, periodStart: "2026-04-01", periodEnd: "2026-06-30", oneD, audited: "Audited" }));
    expect(f).toMatchObject({
      statementFamily: family,
      taxonomy: `IntegratedFinance_${taxonomy}/2026-01-31`,
      basis: "consolidated",
      audited: true,
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      ytdStart: null,
      currency: "INR",
      symbol: "ACME",
      companyName: "Acme Limited",
    });
    expect(Object.keys(f.byContext.FourD)).toHaveLength(0);
    expect(f.byContext.OneD).toEqual(Object.fromEntries(Object.entries(oneD).map(([k, v]) => [k, cr(v)])));
    expect(strategyFor(family).checks(f).filter((c) => !c.passed)).toEqual([]);
  });

  it("reads FourD when present", () => {
    const f = parseIntegratedXbrl(INDUSTRIAL_XML);
    expect(f.ytdStart).toBe("2026-04-01");
    expect(f.byContext.FourD.RevenueFromOperations).toBe(cr(1000));
  });

  it("uses NameOfBank, a stated currency and the standalone basis", () => {
    const xml = syntheticXbrl({
      taxonomy: "Banking",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      oneD: BANKING_Q,
      basis: "Standalone",
      meta: { NameOfBank: "Acme Bank", DescriptionOfPresentationCurrency: "USD" },
    }).replace(/<in-capmkt:NameOfTheCompany[^>]*>[^<]*<\/in-capmkt:NameOfTheCompany>/, "");
    expect(parseIntegratedXbrl(xml)).toMatchObject({ basis: "standalone", companyName: "Acme Bank", currency: "USD" });
  });

  it("reads audit status by exact match only", () => {
    const audited = (a: string) => parseIntegratedXbrl(syntheticXbrl({ taxonomy: "IndAS", periodStart: "2026-04-01", periodEnd: "2026-06-30", oneD: INDUSTRIAL_Q, audited: a })).audited;
    expect(audited("Audited")).toBe(true);
    expect(audited("  Audited  ")).toBe(true);
    expect(audited("Un-Audited")).toBe(false);
    expect(audited("Unaudited")).toBe(false);
    expect(audited("Audited/Unaudited")).toBe(false);
  });
});

describe("readXbrlDocument details", () => {
  const ctx = (id: string, inner = "") =>
    `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="s">1</xbrli:identifier>${inner}</xbrli:entity><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>`;
  const doc = (body: string) => `<xbrli:xbrl xmlns:xbrli="x" xmlns:c="y" xmlns:xsi="z">${body}</xbrli:xbrl>`;

  it("skips nil, empty, non-numeric and unknown-context facts, and keeps the first duplicate", () => {
    const d = readXbrlDocument(
      doc(
        ctx("OneD") +
          `<c:A contextRef="OneD" unitRef="INR" decimals="-5">100</c:A>` +
          `<c:A contextRef="OneD" unitRef="INR" decimals="-5">999</c:A>` +
          `<c:B contextRef="OneD" unitRef="INR" xsi:nil="true"/>` +
          `<c:C contextRef="OneD" unitRef="INR"></c:C>` +
          `<c:D contextRef="OneD" unitRef="INR">n/a</c:D>` +
          `<c:E contextRef="Ghost" unitRef="INR">5</c:E>` +
          `<c:F unitRef="INR">6</c:F>` +
          `<c:G contextRef="OneD">first</c:G><c:G contextRef="OneD">second</c:G>`,
      ),
    );
    expect(d.numeric).toEqual([{ concept: "A", context: "OneD", value: 100, unit: "INR", decimals: "-5" }]);
    expect(d.text).toEqual({ OneD: { G: "first" } });
  });

  it("ignores dimensioned and scenario contexts even when they reuse a core id", () => {
    const segment = `<xbrli:segment><xbrldi:explicitMember dimension="d">m</xbrldi:explicitMember></xbrli:segment>`;
    expect(readXbrlDocument(doc(ctx("OneD", segment))).contexts).toEqual({});
    const scenario = ctx("FourD").replace("</xbrli:period>", "</xbrli:period><xbrli:scenario>s</xbrli:scenario>");
    expect(readXbrlDocument(doc(scenario)).contexts).toEqual({});
    expect(readXbrlDocument(doc(ctx("OneExpenses1D"))).contexts).toEqual({});
  });
});

describe("malformed input", () => {
  it.each([
    ["empty string", ""],
    ["whitespace", "   \n"],
    ["XML declaration only", `<?xml version="1.0"?>`],
    ["plain text", "Service Unavailable"],
    ["an HTML error page", "<html><body>Access Denied</body></html>"],
    ["a truncated tag", "<xbrli:xbrl"],
    ["an xbrl root without contexts", "<xbrl></xbrl>"],
  ])("rejects %s with XbrlParseError", (_label, xml) => {
    expect(() => parseIntegratedXbrl(xml)).toThrow(XbrlParseError);
  });

  it("rejects a truncated download of a real filing", () => {
    const xml = readXml("TCS_30-SEP-2026_consolidated.xml");
    expect(() => parseIntegratedXbrl(xml.slice(0, 600))).toThrow(XbrlParseError);
  });

  it("rejects a filing whose OneD context lacks dates or is dimensioned", () => {
    const instantOnly = INDUSTRIAL_XML.replace(
      /<xbrli:context id="OneD">([\s\S]*?)<xbrli:period>[\s\S]*?<\/xbrli:period>/,
      `<xbrli:context id="OneD">$1<xbrli:period><xbrli:instant>2026-09-30</xbrli:instant></xbrli:period>`,
    );
    expect(() => parseIntegratedXbrl(instantOnly)).toThrow("Filing has no OneD (quarter) context");
    const dimensioned = INDUSTRIAL_XML.replace(
      /(<xbrli:context id="OneD"><xbrli:entity>[\s\S]*?<\/xbrli:identifier>)/,
      `$1<xbrli:segment><xbrldi:explicitMember dimension="d">m</xbrldi:explicitMember></xbrli:segment>`,
    );
    expect(() => parseIntegratedXbrl(dimensioned)).toThrow(/no OneD/);
  });

  it("requires a basis from the filing or the caller", () => {
    const xml = syntheticXbrl({ taxonomy: "IndAS", periodStart: "2026-04-01", periodEnd: "2026-06-30", oneD: INDUSTRIAL_Q, basis: null });
    expect(() => parseIntegratedXbrl(xml)).toThrow(XbrlParseError);
    expect(parseIntegratedXbrl(xml, { fallbackBasis: "consolidated" }).basis).toBe("consolidated");
    const odd = syntheticXbrl({ taxonomy: "IndAS", periodStart: "2026-04-01", periodEnd: "2026-06-30", oneD: INDUSTRIAL_Q, meta: { NatureOfReportStandaloneConsolidated: "Both" } });
    expect(() => parseIntegratedXbrl(odd)).toThrow(/standalone\/consolidated/);
  });
});

describe("family detection fallback", () => {
  const synth = (taxonomy: string, oneD: Record<string, number>) =>
    parseIntegratedXbrl(syntheticXbrl({ taxonomy, periodStart: "2026-04-01", periodEnd: "2026-06-30", oneD }));

  it("keeps an unrecognised SEBI template name but infers the family from concepts", () => {
    expect(synth("Insurance", NBFC_Q)).toMatchObject({ statementFamily: "nbfc", taxonomy: "IntegratedFinance_Insurance/2026-01-31" });
    expect(synth("Insurance", BANKING_Q)).toMatchObject({ statementFamily: "banking" });
    expect(synth("Insurance", INDUSTRIAL_Q)).toMatchObject({ statementFamily: "industrial" });
  });

  it("reports an unknown taxonomy when there is no SEBI namespace", () => {
    expect(synth("Not-A-Template", NBFC_Q)).toMatchObject({ statementFamily: "nbfc", taxonomy: "unknown" });
  });

  it("needs both NBFC markers; PPOP or InterestExpended alone mean banking", () => {
    expect(detectTaxonomy("", { ImpairmentOnFinancialInstruments: 1 }).family).toBe("industrial");
    expect(detectTaxonomy("", { InterestEarned: 1 }).family).toBe("industrial");
    expect(detectTaxonomy("", { ImpairmentOnFinancialInstruments: 1, InterestEarned: 1 }).family).toBe("nbfc");
    expect(detectTaxonomy("", { InterestExpended: 1 }).family).toBe("banking");
    expect(detectTaxonomy("", { OperatingProfitBeforeProvisionAndContingencies: 1 }).family).toBe("banking");
    expect(detectTaxonomy("", {})).toEqual({ family: "industrial", taxonomy: "unknown" });
  });

  it("trusts the namespace over concepts when it is recognised", () => {
    const xml = syntheticXbrl({ taxonomy: "IndAS", periodStart: "2026-04-01", periodEnd: "2026-06-30", oneD: BANKING_Q });
    expect(parseIntegratedXbrl(xml).statementFamily).toBe("industrial");
  });
});

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
