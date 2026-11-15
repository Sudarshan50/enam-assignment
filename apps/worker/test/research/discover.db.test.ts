import { documentsRepo } from "@finn/db/repositories/documents";
import { historyRepo } from "@finn/db/repositories/history";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverDocuments, MAX_ANNUAL_REPORTS, MAX_TRANSCRIPTS, selectDocuments } from "../../src/pipelines/documents";
import { cleanupSymbols, connect, fakeContext, insertCompany, link, screenerCompany, testSymbol } from "./helpers";

const screener = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@finn/sources/screener/company", () => ({ fetchScreenerCompany: screener.fetch }));

const SYM = testSymbol("ZTADISC");
const { sql, reachable } = await connect();

const transcriptLinks = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10 - i * 3, 5));
    return link("concall_transcript", d.toISOString().slice(0, 10), `https://www.bseindia.com/zta/t${i}.pdf`);
  });

describe("selectDocuments", () => {
  it("keeps the latest 2 annual reports and the latest 8 transcripts (one per quarter)", () => {
    const links = [
      link("annual_report", "Financial Year 2024", "https://www.bseindia.com/zta/ar24.pdf"),
      link("annual_report", "Financial Year 2026", "https://www.bseindia.com/zta/ar26.pdf"),
      link("annual_report", "Financial Year 2025", "https://www.bseindia.com/zta/ar25.pdf"),
      link("annual_report", "no year here", "https://www.bseindia.com/zta/arx.pdf"),
      ...transcriptLinks(10),
      link("concall_transcript", "2026-11-20", "https://www.bseindia.com/zta/t0-dup.pdf"),
      link("concall_transcript", "2026-11", "https://www.bseindia.com/zta/month-only.pdf"),
      link("concall_transcript", "Nov 2026", "https://www.bseindia.com/zta/bad-date.pdf"),
      link("concall_recording", "2026-11-05", "https://www.bseindia.com/zta/rec.mp3"),
      link("concall_ppt", "2026-11-05", "https://www.bseindia.com/zta/ppt.pdf"),
      link("credit_rating", "2026-10-01", "https://www.bseindia.com/zta/cr.pdf"),
    ];
    const out = selectDocuments(SYM, links);
    const ars = out.filter((d) => d.docType === "annual_report");
    const trs = out.filter((d) => d.docType === "transcript");
    expect(ars).toHaveLength(MAX_ANNUAL_REPORTS);
    expect(ars.map((d) => [d.periodLabel, d.periodEnd])).toEqual([
      ["FY26", "2026-03-31"],
      ["FY25", "2025-03-31"],
    ]);
    expect(trs).toHaveLength(MAX_TRANSCRIPTS);
    expect(trs[0]).toMatchObject({ url: "https://www.bseindia.com/zta/t0-dup.pdf", periodLabel: "Q2 FY27", periodEnd: "2026-11-20" });
    expect(new Set(trs.map((t) => t.periodLabel)).size).toBe(trs.length);
    expect(out.some((d) => /rec\.mp3|ppt\.pdf|cr\.pdf|bad-date/.test(d.url))).toBe(false);
    for (let i = 1; i < trs.length; i++) expect(trs[i - 1]!.periodEnd! > trs[i]!.periodEnd!).toBe(true);
  });

  it("normalises month-only call dates to the first of the month", () => {
    const [t] = selectDocuments(SYM, [link("concall_transcript", "2026-08", "https://www.bseindia.com/zta/m.pdf")]);
    expect(t).toMatchObject({ periodEnd: "2026-08-01", periodLabel: "Q1 FY27" });
  });
});

describe.skipIf(!reachable)("discoverDocuments against the local database", () => {
  beforeAll(async () => {
    await cleanupSymbols(sql, [SYM]);
    await insertCompany(sql, SYM);
  });
  beforeEach(() => {
    screener.fetch.mockReset();
  });
  afterAll(async () => {
    await cleanupSymbols(sql, [SYM]);
    await sql.end({ timeout: 5 });
  });

  it("upserts selected documents and non-empty history tables", async () => {
    screener.fetch.mockResolvedValue(
      screenerCompany(
        SYM,
        [link("annual_report", "2026", "https://www.bseindia.com/zta/ar26.pdf"), ...transcriptLinks(2), link("concall_recording", "2026-11-05", "https://x.example.com/r.mp3")],
        [
          { statement: "profit_loss", columns: ["Mar 2025", "Mar 2026"], rows: [{ label: "Sales", values: [1, 2] }] },
          { statement: "ratios", columns: ["Mar 2026"], rows: [] },
        ],
      ),
    );
    const ctx = fakeContext(sql);
    const r = await discoverDocuments(ctx, SYM);
    expect(r).toMatchObject({ historyTables: 1, basis: "consolidated", error: null });
    expect(r.documents.map((d) => [d.doc_type, d.status])).toEqual([
      ["annual_report", "discovered"],
      ["transcript", "discovered"],
      ["transcript", "discovered"],
    ]);
    expect(screener.fetch).toHaveBeenCalledWith(ctx.http, SYM);
    const tables = await historyRepo(sql).listForSymbol(SYM);
    expect(tables.map((t) => t.statement)).toEqual(["profit_loss"]);
  });

  it("is idempotent: re-discovery keeps the same rows and their status", async () => {
    screener.fetch.mockResolvedValue(screenerCompany(SYM, [link("annual_report", "2026", "https://www.bseindia.com/zta/ar26.pdf")]));
    const first = await discoverDocuments(fakeContext(sql), SYM);
    await documentsRepo(sql).setStatus(first.documents[0]!.id, "ready");
    const second = await discoverDocuments(fakeContext(sql), SYM);
    expect(second.documents[0]!.id).toBe(first.documents[0]!.id);
    expect(second.documents[0]!.status).toBe("ready");
    expect((await documentsRepo(sql).listBySymbol(SYM)).filter((d) => d.url.endsWith("ar26.pdf"))).toHaveLength(1);
  });

  it("falls back to already-known annual reports and transcripts when screener is unreachable", async () => {
    screener.fetch.mockImplementation(async () => {
      throw new Error("HTTP 503 for screener");
    });
    const ctx = fakeContext(sql);
    const r = await discoverDocuments(ctx, SYM);
    expect(r.error).toBe("HTTP 503 for screener");
    expect(r.documents.length).toBe(3);
    expect(r.historyTables).toBe(0);
    expect(ctx.lines.some((l) => l.level === "warn")).toBe(true);
  });
});
