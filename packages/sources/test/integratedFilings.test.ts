import { describe, expect, it } from "vitest";
import {
  familyFromXbrlUrl,
  fetchXbrl,
  integratedFilingsUrl,
  latestPeriodEnd,
  listIntegratedFilings,
  parseIntegratedFilingList,
  selectFilingsForCard,
} from "../src/nse/integratedFilings";
import { shiftQuarterEnd } from "../src/nse/quarterEnds";
import type { IntegratedFilingRef } from "../src/types";
import { fakeHttp, readFixture } from "./helpers";

const load = (symbol: string) => JSON.parse(readFixture(`integrated_${symbol}.json`)) as { data: Record<string, unknown>[] };

describe("parseIntegratedFilingList", () => {
  it("parses TCS rows with IST dates and exact audited matching", () => {
    const refs = parseIntegratedFilingList(load("TCS"));
    expect(refs).toHaveLength(14);
    const q2 = refs.find((r) => r.seqId === "200121")!;
    expect(q2).toMatchObject({
      symbol: "TCS",
      companyName: "Tata Consultancy Services Limited",
      periodEnd: "2026-09-30",
      basis: "consolidated",
      audited: true,
      revision: "original",
      statementFamily: "industrial",
      xbrlUrl: "https://nsearchives.nseindia.in/corporate/xbrl/INTEGRATED_FILING_INDAS_1734607_08102026100810_WEB.xml",
    });
    expect(q2.ixbrlUrl).toMatch(/iXBRL_WEB\.html$/);
    expect(q2.broadcastAt.toISOString()).toBe("2026-10-08T16:37:33.000Z");
  });

  it("detects the statement family from the XBRL filename", () => {
    expect(new Set(parseIntegratedFilingList(load("HDFCBANK")).map((r) => r.statementFamily))).toEqual(new Set(["banking"]));
    expect(new Set(parseIntegratedFilingList(load("BAJFINANCE")).map((r) => r.statementFamily))).toEqual(new Set(["nbfc"]));
    expect(familyFromXbrlUrl("https://x/INTEGRATED_FILING_NBFC_INDAS_1_WEB.xml")).toBe("nbfc");
    expect(familyFromXbrlUrl("https://x/INTEGRATED_FILING_INSURANCE_1_WEB.xml")).toBeNull();
  });

  it("does not read 'Un-Audited' as audited", () => {
    const hdfc = parseIntegratedFilingList(load("HDFCBANK"));
    expect(hdfc.find((r) => r.seqId === "202132")!.audited).toBe(false);
    expect(hdfc.find((r) => r.seqId === "151456")!.audited).toBe(true);
  });

  it("drops non-financials rows and rejects non-array payloads", () => {
    const { data } = load("TCS");
    const extra = { ...data[0], seq_Id: "999", type: "Integrated Filing- Governance" };
    expect(parseIntegratedFilingList({ data: [...data, extra] })).toHaveLength(14);
    expect(() => parseIntegratedFilingList({ message: "nope" })).toThrow();
  });
});

describe("selectFilingsForCard", () => {
  const tcs = parseIntegratedFilingList(load("TCS"));

  it("picks consolidated current, previous and year-ago quarters", () => {
    const sel = selectFilingsForCard(tcs, "2026-09-30");
    expect(sel.basis).toBe("consolidated");
    expect(sel.current?.seqId).toBe("200121");
    expect(sel.previousQuarter?.seqId).toBe("173420");
    expect(sel.yearAgoQuarter?.seqId).toBe("119003");
    expect(latestPeriodEnd(tcs)).toBe("2026-09-30");
  });

  it("returns null slots outside the integrated-filing window", () => {
    const sel = selectFilingsForCard(tcs, "2025-03-31");
    expect(sel.current?.seqId).toBe("84691");
    expect(sel.previousQuarter).toBeNull();
    expect(sel.yearAgoQuarter).toBeNull();
  });

  it("prefers a revised filing over the original for the same period", () => {
    const original = tcs.find((r) => r.seqId === "200121")!;
    const revised: IntegratedFilingRef = { ...original, seqId: "200500", revision: "revised", broadcastAt: new Date("2026-10-01T00:00:00Z") };
    expect(selectFilingsForCard([...tcs, revised], "2026-09-30").current?.seqId).toBe("200500");
  });

  it("falls back to standalone only when consolidated is absent, without mixing bases", () => {
    const standaloneOnly = tcs.filter((r) => r.basis === "standalone");
    const sel = selectFilingsForCard(standaloneOnly, "2026-09-30");
    expect(sel.basis).toBe("standalone");
    expect([sel.current, sel.previousQuarter, sel.yearAgoQuarter].every((r) => r?.basis === "standalone")).toBe(true);
  });
});

const XBRL_DIR = "https://nsearchives.nseindia.in/corporate/xbrl";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq_Id: "1",
    symbol: "ACME",
    cmName: "Acme Limited",
    type: "Integrated Filing- Financials",
    type_Sub: "Original",
    qe_Date: "30-SEP-2026",
    consolidated: "Consolidated",
    audited: "Un-Audited",
    broadcast_Date: "08-Oct-2026 22:07:33",
    creation_Date: "08-Oct-2026 22:08:10",
    xbrl: `${XBRL_DIR}/INTEGRATED_FILING_INDAS_1_08102026100810_WEB.xml`,
    ixbrl: "https://nsearchives.nseindia.in/corporate/ixbrl/x_iXBRL_WEB.html",
    ...overrides,
  };
}

function ref(overrides: Partial<IntegratedFilingRef>): IntegratedFilingRef {
  return {
    seqId: "1",
    symbol: "ACME",
    companyName: "Acme Limited",
    periodEnd: "2026-09-30",
    basis: "consolidated",
    audited: false,
    revision: "original",
    xbrlUrl: "https://x/INTEGRATED_FILING_INDAS_1_WEB.xml",
    ixbrlUrl: null,
    broadcastAt: new Date("2026-10-08T00:00:00Z"),
    statementFamily: "industrial",
    ...overrides,
  };
}

describe("familyFromXbrlUrl", () => {
  it.each([
    ["INTEGRATED_FILING_INDAS_1734607_08102026100810_WEB.xml", "industrial"],
    ["INTEGRATED_FILING_BANKING_1740913_17102026054812_WEB.xml", "banking"],
    ["INTEGRATED_FILING_NBFC_INDAS_1742040_19102026075918_WEB.xml", "nbfc"],
    ["integrated_filing_nbfc_indas_1_web.xml", "nbfc"],
    ["integrated_filing_indas_1_web.xml", "industrial"],
    ["INTEGRATED_FILING_BANKING_1_WEB.xml?download=1", "banking"],
    ["INTEGRATED_FILING_INSURANCE_1_WEB.xml", null],
    ["FINANCIAL_RESULTS_1_WEB.xml", null],
    ["", null],
  ])("%s -> %s", (file, family) => {
    expect(familyFromXbrlUrl(`${XBRL_DIR}/${file}`)).toBe(family);
  });

  it("looks only at the filename, not the directory", () => {
    expect(familyFromXbrlUrl("https://x/INTEGRATED_FILING_BANKING_/INTEGRATED_FILING_INDAS_1_WEB.xml")).toBe("industrial");
    expect(familyFromXbrlUrl("https://x/INTEGRATED_FILING_BANKING_/other.xml")).toBeNull();
  });

  it("agrees with every fixture row", () => {
    const expected = { TCS: "industrial", HDFCBANK: "banking", BAJFINANCE: "nbfc" } as const;
    for (const [symbol, family] of Object.entries(expected)) {
      for (const r of load(symbol).data) expect(familyFromXbrlUrl(r.xbrl as string)).toBe(family);
    }
  });
});

describe("parseIntegratedFilingList with synthetic rows", () => {
  it("maps every field of a well-formed row", () => {
    const [r] = parseIntegratedFilingList([row({ audited: "Audited", type_Sub: "Revised" })]);
    expect(r).toEqual({
      seqId: "1",
      symbol: "ACME",
      companyName: "Acme Limited",
      periodEnd: "2026-09-30",
      basis: "consolidated",
      audited: true,
      revision: "revised",
      xbrlUrl: `${XBRL_DIR}/INTEGRATED_FILING_INDAS_1_08102026100810_WEB.xml`,
      ixbrlUrl: "https://nsearchives.nseindia.in/corporate/ixbrl/x_iXBRL_WEB.html",
      broadcastAt: new Date("2026-10-08T16:37:33.000Z"),
      statementFamily: "industrial",
    });
  });

  it.each([
    ["seq_Id", { seq_Id: null }],
    ["symbol", { symbol: "" }],
    ["xbrl", { xbrl: undefined }],
    ["qe_Date", { qe_Date: "2026-09-30" }],
    ["both dates", { broadcast_Date: null, creation_Date: "-" }],
    ["basis", { consolidated: "Non-Consolidated" }],
    ["family", { xbrl: `${XBRL_DIR}/INTEGRATED_FILING_INSURANCE_1_WEB.xml` }],
    ["financials type", { type: "Integrated Filing- Governance" }],
    ["any type", { type: undefined }],
  ])("drops a row with an unusable %s", (_label, overrides) => {
    expect(parseIntegratedFilingList([row(overrides)])).toEqual([]);
  });

  it("falls back to creation_Date, smName and the symbol", () => {
    const [a] = parseIntegratedFilingList([row({ broadcast_Date: null, cmName: null, smName: "Acme Ltd" })]);
    expect(a!.broadcastAt.toISOString()).toBe("2026-10-08T16:38:10.000Z");
    expect(a!.companyName).toBe("Acme Ltd");
    expect(parseIntegratedFilingList([row({ cmName: null })])[0]!.companyName).toBe("ACME");
  });

  it("reads basis case-insensitively and numeric seq ids as strings", () => {
    const [r] = parseIntegratedFilingList({ data: [row({ consolidated: "STANDALONE", seq_Id: 1234 })] });
    expect(r).toMatchObject({ basis: "standalone", seqId: "1234" });
  });

  it("nulls iXBRL links that NSE leaves as '/null' or relative", () => {
    const ix = (ixbrl: unknown) => parseIntegratedFilingList([row({ ixbrl })])[0]!.ixbrlUrl;
    expect(ix("https://nsearchives.nseindia.in/corporate/null")).toBeNull();
    expect(ix("/corporate/x.html")).toBeNull();
    expect(ix(null)).toBeNull();
  });

  it("keeps the first row per seq_Id", () => {
    const out = parseIntegratedFilingList([row({ cmName: "First" }), row({ cmName: "Second" }), row({ seq_Id: "2" })]);
    expect(out.map((r) => [r.seqId, r.companyName])).toEqual([
      ["1", "First"],
      ["2", "Acme Limited"],
    ]);
  });

  it("rejects payloads that are not an array or { data: [] }", () => {
    for (const bad of [null, "[]", 1, { data: {} }, { rows: [] }]) {
      expect(() => parseIntegratedFilingList(bad)).toThrow(/Unexpected integrated-filing payload/);
    }
    expect(parseIntegratedFilingList({ data: [] })).toEqual([]);
  });
});

describe("selectFilingsForCard rules", () => {
  it("prefers a revised filing even when an original was broadcast later", () => {
    const refs = [
      ref({ seqId: "orig-late", broadcastAt: new Date("2026-11-01T00:00:00Z") }),
      ref({ seqId: "revised", revision: "revised", broadcastAt: new Date("2026-10-20T00:00:00Z") }),
      ref({ seqId: "orig-early", broadcastAt: new Date("2026-10-08T00:00:00Z") }),
    ];
    expect(selectFilingsForCard(refs, "2026-09-30").current?.seqId).toBe("revised");
  });

  it("takes the latest broadcast among filings of the same revision", () => {
    const refs = [
      ref({ seqId: "rev-1", revision: "revised", broadcastAt: new Date("2026-10-20T00:00:00Z") }),
      ref({ seqId: "rev-2", revision: "revised", broadcastAt: new Date("2026-10-25T00:00:00Z") }),
      ref({ seqId: "orig-a", periodEnd: "2026-06-30", broadcastAt: new Date("2026-07-10T00:00:00Z") }),
      ref({ seqId: "orig-b", periodEnd: "2026-06-30", broadcastAt: new Date("2026-07-12T00:00:00Z") }),
    ];
    const sel = selectFilingsForCard(refs, "2026-09-30");
    expect(sel.current?.seqId).toBe("rev-2");
    expect(sel.previousQuarter?.seqId).toBe("orig-b");
  });

  it("prefers consolidated when both bases exist for the current quarter", () => {
    const refs = [ref({ seqId: "s", basis: "standalone" }), ref({ seqId: "c" })];
    expect(selectFilingsForCard(refs, "2026-09-30")).toMatchObject({ basis: "consolidated", current: { seqId: "c" } });
  });

  it("falls back to standalone and then refuses consolidated comparisons", () => {
    const refs = [
      ref({ seqId: "s-cur", basis: "standalone" }),
      ref({ seqId: "c-prev", periodEnd: "2026-06-30" }),
      ref({ seqId: "c-yago", periodEnd: "2025-09-30" }),
    ];
    expect(selectFilingsForCard(refs, "2026-09-30")).toEqual({
      basis: "standalone",
      current: refs[0],
      previousQuarter: null,
      yearAgoQuarter: null,
    });
  });

  it("honours a forced basis even when the other basis is available", () => {
    const refs = [ref({ seqId: "c" }), ref({ seqId: "s", basis: "standalone" })];
    expect(selectFilingsForCard(refs, "2026-09-30", "standalone").current?.seqId).toBe("s");
    expect(selectFilingsForCard([ref({ seqId: "c" })], "2026-09-30", "standalone").current).toBeNull();
  });

  it("defaults to consolidated with every slot empty when nothing matches", () => {
    expect(selectFilingsForCard([], "2026-09-30")).toEqual({ basis: "consolidated", current: null, previousQuarter: null, yearAgoQuarter: null });
  });

  it("compares a Q1 (June) filing with March and the prior June", () => {
    const tcs = parseIntegratedFilingList(load("TCS"));
    const sel = selectFilingsForCard(tcs, "2026-06-30");
    expect([sel.current?.periodEnd, sel.previousQuarter?.periodEnd, sel.yearAgoQuarter?.periodEnd]).toEqual(["2026-06-30", "2026-03-31", "2025-06-30"]);
    expect([sel.current?.seqId, sel.previousQuarter?.seqId, sel.yearAgoQuarter?.seqId]).toEqual(["173420", "150312", "102387"]);
  });

  it("crosses the calendar year for a March quarter and leaves a gap as null", () => {
    const banks = parseIntegratedFilingList(load("HDFCBANK"));
    const sel = selectFilingsForCard(banks, "2026-03-31");
    expect([sel.current?.seqId, sel.previousQuarter?.seqId, sel.yearAgoQuarter?.seqId]).toEqual(["151456", "135633", "85666"]);
    const withoutDec = banks.filter((r) => r.periodEnd !== "2025-12-31");
    expect(selectFilingsForCard(withoutDec, "2026-03-31")).toMatchObject({ current: { seqId: "151456" }, previousQuarter: null, yearAgoQuarter: { seqId: "85666" } });
  });

  it("latestPeriodEnd is null for an empty list", () => {
    expect(latestPeriodEnd([])).toBeNull();
    expect(latestPeriodEnd([ref({ periodEnd: "2025-12-31" }), ref({ periodEnd: "2026-03-31" }), ref({ periodEnd: "2025-03-31" })])).toBe("2026-03-31");
  });
});

describe("shiftQuarterEnd (sources)", () => {
  it("steps across year boundaries and lands on month ends", () => {
    expect(shiftQuarterEnd("2026-03-31", -1)).toBe("2025-12-31");
    expect(shiftQuarterEnd("2025-12-31", 1)).toBe("2026-03-31");
    expect(shiftQuarterEnd("2026-06-30", -4)).toBe("2025-06-30");
    expect(shiftQuarterEnd("2026-09-30", -9)).toBe("2024-06-30");
    expect(shiftQuarterEnd("2026-09-30", 0)).toBe("2026-09-30");
  });
});

describe("listIntegratedFilings / fetchXbrl", () => {
  it("calls the integrated-filing endpoint with %20-encoded type", async () => {
    const url = integratedFilingsUrl("TCS");
    expect(url).toBe(
      "https://www.nseindia.in/api/integrated-filing-results?index=equities&symbol=TCS&period_ended=all&type=Integrated%20Filing-%20Financials",
    );
    const http = fakeHttp({ [url]: load("TCS"), "https://x/f.xml": "<xbrl/>" });
    expect(await listIntegratedFilings(http, "TCS")).toHaveLength(14);
    expect(await fetchXbrl(http, "https://x/f.xml")).toBe("<xbrl/>");
  });
});
