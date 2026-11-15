import { describe, expect, it } from "vitest";
import {
  announcementsUrl,
  fetchAnnouncements,
  InvalidAnnouncementError,
  normaliseAnnouncement,
  parseSizeKb,
} from "../src/nse/announcements";
import { fakeHttp, readFixture } from "./helpers";

const rows = JSON.parse(readFixture("announcements_2026-11-13.json")) as Record<string, unknown>[];

describe("normaliseAnnouncement", () => {
  it("maps NSE fields and parses an_dt as India time", () => {
    const raw = rows.find((r) => r.seq_id === "106859921")!;
    const ann = normaliseAnnouncement(raw);
    expect(ann).toMatchObject({
      seqId: "106859921",
      symbol: "PAGEIND",
      companyName: "Page Industries Limited",
      isin: "INE761H01022",
      industry: "Textile Products",
      subject: "General Updates",
      attachmentUrl: "https://nsearchives.nseindia.in/corporate/PAGEIND_13112026211531_CLARIFICATIONQ2FY27RESULTS.pdf",
      attachmentSizeKb: 233.67,
      hasXbrl: true,
    });
    expect(ann.text).toContain("Clarification on Media Reports");
    expect(ann.exchangeSummary).toContain("FEMA");
    // 21:16:28 IST is 15:46:28 UTC.
    expect(ann.publishedAt.toISOString()).toBe("2026-11-13T15:46:28.000Z");
    expect(ann.raw).toBe(raw);
  });

  it("normalises every fixture row; '-' attachments and missing summaries become null", () => {
    const all = rows.map(normaliseAnnouncement);
    expect(all).toHaveLength(rows.length);
    const dashRow = rows.findIndex((r) => r.attchmntFile === "-");
    if (dashRow >= 0) expect(all[dashRow]!.attachmentUrl).toBeNull();
    const noSummary = rows.findIndex((r) => r.voiceSummary === null);
    if (noSummary >= 0) expect(all[noSummary]!.exchangeSummary).toBeNull();
    expect(all.every((a) => a.publishedAt instanceof Date && !Number.isNaN(a.publishedAt.getTime()))).toBe(true);
  });

  it("falls back to sort_date when an_dt is missing", () => {
    const ann = normaliseAnnouncement({ seq_id: "1", symbol: "X", sort_date: "2026-11-13 09:00:00" });
    expect(ann.publishedAt.toISOString()).toBe("2026-11-13T03:30:00.000Z");
  });

  it("rejects rows without identity or date", () => {
    expect(() => normaliseAnnouncement({ symbol: "X", an_dt: "13-Nov-2026 10:00:00" })).toThrow(InvalidAnnouncementError);
    expect(() => normaliseAnnouncement({ seq_id: "1", symbol: "X", an_dt: "garbage" })).toThrow(InvalidAnnouncementError);
  });

  it("parses attachment sizes", () => {
    expect(parseSizeKb("1.32 MB")).toBeCloseTo(1351.68, 2);
    expect(parseSizeKb("0 Bytes")).toBe(0);
    expect(parseSizeKb(null)).toBeNull();
  });
});

describe("fetchAnnouncements", () => {
  const from = new Date("2026-11-12T20:00:00Z"); // 13 Nov 01:30 IST
  const to = new Date("2026-11-13T12:00:00Z");

  it("builds the NSE URL with IST dates", () => {
    expect(announcementsUrl({ from, to })).toBe(
      "https://www.nseindia.in/api/corporate-announcements?index=equities&from_date=13-11-2026&to_date=13-11-2026",
    );
    expect(announcementsUrl({ from, to, symbol: "M&M" })).toContain("&symbol=M%26M");
  });

  it("dedupes by seqId and reports invalid rows", async () => {
    const first = rows[0]!;
    const payload = [first, { ...first }, { symbol: "BAD" }, ...rows.slice(1, 5)];
    const http = fakeHttp({ [announcementsUrl({ from, to })]: payload });
    const invalid: unknown[] = [];
    const out = await fetchAnnouncements(http, { from, to, onInvalidRow: (e) => invalid.push(e) });
    expect(out).toHaveLength(5);
    expect(new Set(out.map((a) => a.seqId)).size).toBe(5);
    expect(invalid).toHaveLength(1);
  });

  it("treats a non-array payload as a failure, never as an empty day", async () => {
    const http = fakeHttp({ [announcementsUrl({ from, to })]: { error: "blocked" } });
    await expect(fetchAnnouncements(http, { from, to })).rejects.toThrow(/Unexpected announcements payload/);
  });
});
