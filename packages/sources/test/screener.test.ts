import { describe, expect, it } from "vitest";
import { createThrottle } from "../src/http/throttle";
import { createScreenerClient, hasHistoryData, parseScreenerCompany, screenerCompanyUrl } from "../src/screener/company";
import { monthYearToIso } from "../src/screener/documents";
import { fakeHttp, readFixture } from "./helpers";

const html = readFixture("screener_TCS.html");
const fetchedAt = new Date("2026-11-15T06:00:00Z");
const company = parseScreenerCompany(html, "TCS", "consolidated", fetchedAt);
const byKind = (kind: string) => company.documents.filter((d) => d.kind === kind);

describe("screener documents", () => {
  it("finds annual reports with their fiscal year", () => {
    const reports = byKind("annual_report");
    expect(reports.length).toBeGreaterThanOrEqual(10);
    expect(reports[0]).toEqual({
      kind: "annual_report",
      title: "Annual Report 2026",
      url: "https://www.bseindia.com/xml-data/corpfiling/AttachHis/ad42e748-d73c-4c79-8c52-bcf1b1399bc1.pdf",
      period: "2026",
    });
  });

  it("finds concall transcripts, presentations and recordings keyed by call month", () => {
    const transcripts = byKind("concall_transcript");
    expect(transcripts.length).toBeGreaterThanOrEqual(4);
    expect(transcripts[0]).toEqual({
      kind: "concall_transcript",
      title: "Concall transcript Oct 2026",
      url: "https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=7dc14216-f892-46f1-bf82-5c7b387a83b9.pdf",
      period: "2026-10-01",
    });
    expect(byKind("concall_ppt")[0]?.url).toContain("Q2%202026-27%20Fact%20Sheet.pdf");
    expect(byKind("concall_recording")[0]?.url).toMatch(/\.mp3$/);
    // "PPT" chips without a link are not documents.
    expect(byKind("concall_ppt").every((d) => d.url.startsWith("https://"))).toBe(true);
  });

  it("finds credit ratings and infers the year when screener omits it", () => {
    const ratings = byKind("credit_rating");
    expect(ratings[0]).toMatchObject({ title: "Rating update (icra)", period: "2026-08-20" });
    expect(ratings[1]).toMatchObject({ period: "2025-08-25" });
  });

  it("never returns duplicate links", () => {
    const keys = company.documents.map((d) => `${d.kind}|${d.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("converts month labels", () => {
    expect(monthYearToIso("Oct 2026")).toBe("2026-10-01");
    expect(monthYearToIso("Sept 2026")).toBe("2026-09-01");
    expect(monthYearToIso("2026")).toBeNull();
  });
});

describe("screener history tables", () => {
  const table = (s: string) => company.history.find((t) => t.statement === s)!;

  it("parses all five statements", () => {
    expect(company.history.map((t) => t.statement)).toEqual(["quarters", "profit_loss", "balance_sheet", "cash_flow", "ratios"]);
  });

  it("parses quarterly figures, percentages and trims row labels", () => {
    const q = table("quarters");
    expect(q.columns[0]).toBe("Sep 2023");
    expect(q.columns.at(-1)).toBe("Sep 2026");
    const sales = q.rows.find((r) => r.label === "Sales")!;
    expect(sales.values[0]).toBe(59692);
    expect(sales.values).toHaveLength(q.columns.length);
    expect(q.rows.find((r) => r.label === "OPM %")!.values[0]).toBe(26);
    expect(q.rows.find((r) => r.label === "Other Income")!.values[1]).toBe(-96);
    expect(q.rows.some((r) => r.label === "Raw PDF")).toBe(false);
    expect(q.rows.some((r) => r.label.endsWith("+"))).toBe(false);
  });

  it("keeps empty cells as null and strips tooltips from labels", () => {
    const ratios = table("ratios");
    expect(ratios.rows.find((r) => r.label === "Inventory Days")!.values.every((v) => v === null)).toBe(true);
    expect(table("cash_flow").rows.some((r) => r.label === "CFO/EBITDA")).toBe(true);
    expect(table("profit_loss").columns.at(-1)).toBe("TTM");
  });

  it("reports data presence", () => {
    expect(hasHistoryData(company)).toBe(true);
  });
});

describe("createScreenerClient", () => {
  const instantThrottle = createThrottle({ minIntervalMs: 0 });

  it("uses the consolidated page when it has data", async () => {
    const http = fakeHttp({ [screenerCompanyUrl("TCS", "consolidated")]: html });
    const client = createScreenerClient(http, { throttle: instantThrottle, now: () => fetchedAt });
    const out = await client.fetchCompany("TCS");
    expect(out.basis).toBe("consolidated");
    expect(http.calls).toEqual(["https://www.screener.in/company/TCS/consolidated/"]);
  });

  it("falls back to the standalone page when consolidated has no rows", async () => {
    const empty = html.replace(/<tbody>[\s\S]*?<\/tbody>/g, "<tbody></tbody>");
    const http = fakeHttp({
      [screenerCompanyUrl("TCS", "consolidated")]: empty,
      [screenerCompanyUrl("TCS", "standalone")]: html,
    });
    const out = await createScreenerClient(http, { throttle: instantThrottle }).fetchCompany("TCS");
    expect(out.basis).toBe("standalone");
    expect(http.calls).toEqual(["https://www.screener.in/company/TCS/consolidated/", "https://www.screener.in/company/TCS/"]);
  });

  it("spaces requests through the throttle", async () => {
    const waits: number[] = [];
    let clock = 0;
    const throttle = createThrottle({
      minIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await throttle.wait();
    clock += 200;
    await throttle.wait();
    expect(waits).toEqual([800]);
  });
});
