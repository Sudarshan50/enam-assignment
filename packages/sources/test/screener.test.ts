import { describe, expect, it } from "vitest";
import { createThrottle } from "../src/http/throttle";
import { createScreenerClient, fetchScreenerCompany, hasHistoryData, parseScreenerCompany, screenerCompanyUrl } from "../src/screener/company";
import { monthYearToIso } from "../src/screener/documents";
import { parseLooseNumber } from "../src/util/values";
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

const page = (body: string) => `<html><body>${body}</body></html>`;

const documentsSection = `
<section id="documents">
  <div class="annual-reports"><ul>
    <li><a href="/ar/2026.pdf">Financial Year 2026 <div>from bse</div></a></li>
    <li><a href="https://ir.acme.com/ar-2025.pdf">Annual Report 2025 from nse</a></li>
    <li><a href="/ar/undated.pdf">Annual Report</a></li>
    <li><a>Financial Year 2024</a></li>
  </ul></div>
  <div class="concalls"><ul>
    <li>
      <div class="nowrap">Oct 2026</div>
      <a href="/t.pdf">Transcript</a>
      <a href="/n.pdf">Notes</a>
      <a href="https://ir.acme.com/q2.pptx"> PPT </a>
      <a href="https://cdn.acme.com/q2.mp3">REC</a>
      <a href="javascript:void(0)">Transcript</a>
      <a href="http://[broken">PPT</a>
      <div class="concall-link">PPT</div>
    </li>
    <li><div class="nowrap">Sept 2026</div><a href="/t.pdf">Transcript</a></li>
    <li><div>July 2026</div><a href="/july.pdf">Transcript</a><a href="/july.pdf">Transcript</a></li>
    <li><div class="nowrap">Q1 FY27</div><a href="/q1.pdf">Transcript</a></li>
  </ul></div>
  <div class="credit-ratings"><ul>
    <li><a href="/cr/1.html">Rating update<div>20 Dec from crisil</div></a></li>
    <li><a href="/cr/2.html">Rating update<div>10 Nov</div></a></li>
    <li><a href="/cr/3.html"><div>5 Mar 2024 from icra</div></a></li>
    <li><a href="/cr/4.html">Rating update<div>32 Jan 2024</div></a></li>
    <li><a href="/cr/5.html">Rating update<div>12 Foo 2024</div></a></li>
    <li><a href="/cr/6.html">Rating update<div>sometime</div></a></li>
  </ul></div>
</section>`;

describe("screener pages with missing or unusual sections", () => {
  const at = new Date("2026-11-15T06:00:00Z");

  it("returns empty documents and history for a page with neither", () => {
    const empty = parseScreenerCompany(page("<h1>Acme</h1>"), "ACME", "standalone", at);
    expect(empty).toEqual({ symbol: "ACME", basis: "standalone", documents: [], history: [], fetchedAt: at });
    expect(hasHistoryData(empty)).toBe(false);
  });

  it("does not count balance-sheet-only or all-null tables as history", () => {
    const table = (id: string, cell: string) =>
      `<section id="${id}"><table><thead><tr><th></th><th>Mar 2026</th></tr></thead><tbody><tr><td>Total</td><td>${cell}</td></tr></tbody></table></section>`;
    expect(hasHistoryData(parseScreenerCompany(page(table("balance-sheet", "100")), "X", "consolidated"))).toBe(false);
    expect(hasHistoryData(parseScreenerCompany(page(table("quarters", "")), "X", "consolidated"))).toBe(false);
    expect(hasHistoryData(parseScreenerCompany(page(table("profit-loss", "-5")), "X", "consolidated"))).toBe(true);
  });

  it("classifies concall chips, including recordings, and skips unknown or unusable links", () => {
    const docs = parseScreenerCompany(page(documentsSection), "ACME", "consolidated", at).documents;
    const concalls = docs.filter((d) => d.kind.startsWith("concall_"));
    expect(concalls).toEqual([
      { kind: "concall_transcript", title: "Concall transcript Oct 2026", url: "https://www.screener.in/t.pdf", period: "2026-10-01" },
      { kind: "concall_ppt", title: "Concall presentation Oct 2026", url: "https://ir.acme.com/q2.pptx", period: "2026-10-01" },
      { kind: "concall_recording", title: "Concall recording Oct 2026", url: "https://cdn.acme.com/q2.mp3", period: "2026-10-01" },
      { kind: "concall_transcript", title: "Concall transcript July 2026", url: "https://www.screener.in/july.pdf", period: "2026-07-01" },
    ]);
  });

  it("dedupes by kind and URL, so the same PDF for two months is kept once", () => {
    const docs = parseScreenerCompany(page(documentsSection), "ACME", "consolidated", at).documents;
    expect(docs.filter((d) => d.url === "https://www.screener.in/t.pdf")).toHaveLength(1);
  });

  it("reads annual reports with a year, strips the 'from <exchange>' suffix and resolves relative links", () => {
    const docs = parseScreenerCompany(page(documentsSection), "ACME", "consolidated", at).documents;
    expect(docs.filter((d) => d.kind === "annual_report")).toEqual([
      { kind: "annual_report", title: "Financial Year 2026", url: "https://www.screener.in/ar/2026.pdf", period: "2026" },
      { kind: "annual_report", title: "Annual Report 2025", url: "https://ir.acme.com/ar-2025.pdf", period: "2025" },
    ]);
  });

  it("dates credit ratings, rolling a future day-month back a year and rejecting impossible dates", () => {
    const docs = parseScreenerCompany(page(documentsSection), "ACME", "consolidated", at).documents;
    expect(docs.filter((d) => d.kind === "credit_rating")).toEqual([
      { kind: "credit_rating", title: "Rating update (crisil)", url: "https://www.screener.in/cr/1.html", period: "2025-12-20" },
      { kind: "credit_rating", title: "Rating update", url: "https://www.screener.in/cr/2.html", period: "2026-11-10" },
      { kind: "credit_rating", title: "Credit rating (icra)", url: "https://www.screener.in/cr/3.html", period: "2024-03-05" },
    ]);
  });

  it("uses the IST date of fetchedAt to decide the year", () => {
    const html = page(`<section id="documents"><div class="credit-ratings"><ul><li><a href="/cr.html">R<div>1 Jan</div></a></li></ul></div></section>`);
    // 31 Dec 2026 19:00 UTC is already 1 Jan 2027 in India.
    const docs = parseScreenerCompany(html, "X", "consolidated", new Date("2026-12-31T19:00:00Z")).documents;
    expect(docs[0]?.period).toBe("2027-01-01");
  });

  it("parses screener number formats", () => {
    const cells = ["1,234", "12%", "", "-", "−96", "+8%", "1,23,456.78", "\u00a03\u00a0", "n/a"];
    const html = page(
      `<section id="quarters"><div data-result-table><table>
        <thead><tr><th></th>${cells.map((_, i) => `<th>C${i}</th>`).join("")}</tr></thead>
        <tbody>
          <tr><td class="text"><button>Sales&nbsp;+</button></td>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>
          <tr><td>Short row</td><td>1</td></tr>
          <tr><td>Raw PDF</td><td><a href="/x.pdf">PDF</a></td></tr>
          <tr><td>  </td><td>5</td></tr>
          <tr><td>OPM % <span class="has-tooltip">?</span></td><td>26%</td></tr>
        </tbody></table></div></section>`,
    );
    const [q] = parseScreenerCompany(html, "X", "consolidated").history;
    expect(q!.columns).toEqual(cells.map((_, i) => `C${i}`));
    expect(q!.rows.map((r) => r.label)).toEqual(["Sales", "Short row", "OPM %"]);
    expect(q!.rows[0]!.values).toEqual([1234, 12, null, null, -96, 8, 123456.78, 3, null]);
    expect(q!.rows[1]!.values).toEqual([1, null, null, null, null, null, null, null, null]);
  });

  it("parseLooseNumber handles null, signs and garbage", () => {
    expect(parseLooseNumber(null)).toBeNull();
    expect(parseLooseNumber(undefined)).toBeNull();
    expect(parseLooseNumber("+")).toBeNull();
    expect(parseLooseNumber("1e3")).toBe(1000);
    expect(parseLooseNumber("12.5x")).toBeNull();
    expect(parseLooseNumber("Infinity")).toBeNull();
  });

  it("builds company URLs with an upper-cased, encoded slug", () => {
    expect(screenerCompanyUrl(" m&m ", "consolidated")).toBe("https://www.screener.in/company/M%26M/consolidated/");
    expect(screenerCompanyUrl("tcs", "standalone")).toBe("https://www.screener.in/company/TCS/");
  });
});

describe("createScreenerClient", () => {
  const instantThrottle = createThrottle({ minIntervalMs: 0 });

  it("returns the (empty) standalone page when neither basis has data", async () => {
    const empty = page("<h1>New listing</h1>");
    const http = fakeHttp({ [screenerCompanyUrl("NEWCO", "consolidated")]: empty, [screenerCompanyUrl("NEWCO", "standalone")]: empty });
    const out = await fetchScreenerCompany(http, "NEWCO", { throttle: instantThrottle, now: () => fetchedAt });
    expect(out).toMatchObject({ symbol: "NEWCO", basis: "standalone", documents: [], history: [], fetchedAt });
    expect(http.calls).toHaveLength(2);
  });

  it("propagates a fetch failure instead of falling back", async () => {
    await expect(createScreenerClient(fakeHttp({}), { throttle: instantThrottle }).fetchCompany("TCS")).rejects.toMatchObject({ status: 404 });
  });

  it("waits on the throttle before every request", async () => {
    let waits = 0;
    const throttle = { wait: async () => void waits++ };
    const http = fakeHttp({ [screenerCompanyUrl("X", "consolidated")]: page(""), [screenerCompanyUrl("X", "standalone")]: page("") });
    await createScreenerClient(http, { throttle }).fetchCompany("X");
    expect(waits).toBe(2);
  });

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
