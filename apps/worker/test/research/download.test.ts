import { describe, expect, it } from "vitest";
import { assertSafeUrl, createDocumentDownloader, downloadPdf, UnsafeUrlError } from "../../src/pipelines/documents";
import { downloadCandidates } from "../../src/pipelines/documents/download";
import { fakeHttp, fakePdf } from "./helpers";

describe("download safety", () => {
  it.each([
    ["file:///etc/passwd", /scheme not allowed/],
    ["ftp://www.bseindia.com/x.pdf", /scheme not allowed/],
    ["https://127.0.0.1/x.pdf", /IP-literal/],
    ["https://[::1]/x.pdf", /IP-literal/],
    ["https://localhost/x.pdf", /local host/],
    ["https://intranet/x.pdf", /local host/],
    ["https://box.internal/x.pdf", /local host/],
    ["not a url", /not a URL/],
  ])("rejects %s", (url, reason) => {
    expect(() => assertSafeUrl(url)).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl(url)).toThrow(reason);
  });

  it("accepts exchange archive URLs", () => {
    expect(assertSafeUrl("https://nsearchives.nseindia.com/annual_reports/x.pdf").hostname).toBe("nsearchives.nseindia.com");
  });

  it("allows exchange hosts and the exact IR hosts screener linked, but nothing else", () => {
    const http = createDocumentDownloader(["https://ir.zetapipes.example.com/ar.pdf", "https://10.0.0.1/x.pdf", "garbage"]);
    expect(http.isAllowed("https://nsearchives.nseindia.com/x.pdf")).toBe(true);
    expect(http.isAllowed("https://www.bseindia.com/x.pdf")).toBe(true);
    expect(http.isAllowed("https://ir.zetapipes.example.com/other.pdf")).toBe(true);
    expect(http.isAllowed("https://evil.example.com/x.pdf")).toBe(false);
    expect(http.isAllowed("https://10.0.0.1/x.pdf")).toBe(false);
  });
});

describe("downloadPdf", () => {
  it("returns bytes and their SHA-256", async () => {
    const bytes = fakePdf(["hello"]);
    const http = fakeHttp(new Map([["https://www.bseindia.com/a.pdf", bytes]]));
    const r = await downloadPdf(http, "https://www.bseindia.com/a.pdf");
    expect(r.bytes).toBe(bytes);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses non-PDF payloads such as an HTML error page", async () => {
    const http = fakeHttp(new Map([["https://www.bseindia.com/a.pdf", new TextEncoder().encode("<html>Access denied</html>")]]));
    await expect(downloadPdf(http, "https://www.bseindia.com/a.pdf")).rejects.toThrow(/Not a PDF/);
  });

  it("falls back to BSE's archive paths when the AnnPdfOpen redirect cannot be fetched", async () => {
    const name = "1a3bc0e3-c7ff-4887-a18a-f73fd400e8ca.pdf";
    const open = `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${name}`;
    const his = `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`;
    const http = fakeHttp(new Map([[his, fakePdf(["call"])]]));
    const r = await downloadPdf(http, open);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(http.requested).toEqual([open, `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${name}`, his]);
  });

  it("reports the original error when every candidate fails, and never invents paths for other URLs", async () => {
    const open = "https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=x.pdf";
    await expect(downloadPdf(fakeHttp(new Map()), open)).rejects.toThrow(`HTTP 404 for ${open}`);
    expect(downloadCandidates("https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=../../etc.pdf")).toHaveLength(1);
    expect(downloadCandidates("https://nsearchives.nseindia.com/corporate/a.pdf")).toEqual(["https://nsearchives.nseindia.com/corporate/a.pdf"]);
  });

  it("checks the URL before any request", async () => {
    const http = fakeHttp(new Map());
    await expect(downloadPdf(http, "https://127.0.0.1/a.pdf")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(http.requested).toEqual([]);
  });
});
