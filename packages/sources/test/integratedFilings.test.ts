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
