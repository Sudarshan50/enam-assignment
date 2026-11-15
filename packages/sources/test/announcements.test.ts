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

  it.each([
    ["null", null],
    ["a JSON string", JSON.stringify("Access Denied")],
    ["a number", 0],
    ["an object whose data is not an array", { data: "none" }],
  ])("rejects %s as the payload", async (_label, payload) => {
    const http = fakeHttp({ [announcementsUrl({ from, to })]: payload });
    await expect(fetchAnnouncements(http, { from, to })).rejects.toThrow(/Unexpected announcements payload/);
  });

  it("returns [] for a genuinely empty day and accepts the { data: [] } envelope", async () => {
    const url = announcementsUrl({ from, to });
    expect(await fetchAnnouncements(fakeHttp({ [url]: [] }), { from, to })).toEqual([]);
    const out = await fetchAnnouncements(fakeHttp({ [url]: { data: rows.slice(0, 3) } }), { from, to });
    expect(out.map((a) => a.seqId)).toEqual(rows.slice(0, 3).map((r) => r.seq_id));
  });

  it("propagates HTTP failures instead of returning an empty list", async () => {
    await expect(fetchAnnouncements(fakeHttp({}), { from, to })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the first row per seqId, treating numeric and string ids as the same", async () => {
    const base = { symbol: "TCS", an_dt: "13-Nov-2026 10:00:00" };
    const payload = [
      { ...base, seq_id: 42, desc: "first" },
      { ...base, seq_id: "42", desc: "second" },
      { ...base, seq_id: " 43 ", desc: "third" },
    ];
    const out = await fetchAnnouncements(fakeHttp({ [announcementsUrl({ from, to })]: payload }), { from, to });
    expect(out.map((a) => [a.seqId, a.subject])).toEqual([
      ["42", "first"],
      ["43", "third"],
    ]);
  });

  it("drops malformed rows silently when no onInvalidRow is given, and reports each one when it is", async () => {
    const good = { seq_id: "1", symbol: "TCS", an_dt: "13-Nov-2026 10:00:00" };
    const payload = [
      good,
      { symbol: "TCS", an_dt: "13-Nov-2026 10:00:00" },
      { seq_id: "2", an_dt: "13-Nov-2026 10:00:00" },
      { seq_id: "3", symbol: "  ", an_dt: "13-Nov-2026 10:00:00" },
      { seq_id: "4", symbol: "TCS" },
      { seq_id: "5", symbol: "TCS", an_dt: "13/11/2026", sort_date: "13-11-2026" },
      null,
      "not a row",
    ];
    const url = announcementsUrl({ from, to });
    expect(await fetchAnnouncements(fakeHttp({ [url]: payload }), { from, to })).toHaveLength(1);
    const invalid: InvalidAnnouncementError[] = [];
    await fetchAnnouncements(fakeHttp({ [url]: payload }), { from, to, onInvalidRow: (e) => invalid.push(e) });
    expect(invalid.map((e) => e.message)).toEqual([
      "Announcement row without seq_id or symbol",
      "Announcement row without seq_id or symbol",
      "Announcement row without seq_id or symbol",
      "Unparseable an_dt for seq_id 4",
      "Unparseable an_dt for seq_id 5",
    ]);
    expect(invalid[3]!.raw).toEqual(payload[4]);
  });
});

describe("announcement dates are India time (UTC+05:30, no DST)", () => {
  const at = (an_dt: string) => normaliseAnnouncement({ seq_id: "1", symbol: "X", an_dt }).publishedAt.toISOString();

  it("puts IST midnight on the previous UTC day", () => {
    expect(at("14-Nov-2026 00:00:00")).toBe("2026-11-13T18:30:00.000Z");
    expect(at("01-Jan-2027 00:00:00")).toBe("2026-12-31T18:30:00.000Z");
    expect(at("13-Nov-2026 05:29:59")).toBe("2026-11-12T23:59:59.000Z");
    expect(at("13-Nov-2026 05:30:00")).toBe("2026-11-13T00:00:00.000Z");
  });

  it("uses the same offset in winter and summer", () => {
    expect(at("15-Jan-2026 12:00:00")).toBe("2026-01-15T06:30:00.000Z");
    expect(at("15-Jul-2026 12:00:00")).toBe("2026-07-15T06:30:00.000Z");
    expect(at("29-Mar-2026 02:30:00")).toBe("2026-03-28T21:00:00.000Z");
  });

  it("accepts single-digit days, upper-case months and missing seconds", () => {
    expect(at("3-NOV-2026 09:05")).toBe("2026-11-03T03:35:00.000Z");
    expect(at("03-Nov-2026")).toBe("2026-11-02T18:30:00.000Z");
  });

  it("falls back to sort_date (with or without seconds, space or T) when an_dt is unusable", () => {
    const viaSort = (sort_date: string, an_dt?: string) =>
      normaliseAnnouncement({ seq_id: "1", symbol: "X", sort_date, an_dt }).publishedAt.toISOString();
    expect(viaSort("2026-11-14 00:00:00")).toBe("2026-11-13T18:30:00.000Z");
    expect(viaSort("2026-11-13T21:16")).toBe("2026-11-13T15:46:00.000Z");
    expect(viaSort("2026-11-13 21:16:28", "garbage")).toBe("2026-11-13T15:46:28.000Z");
  });

  it("queries NSE by IST calendar day around midnight", () => {
    const justBefore = new Date("2026-11-13T18:29:59Z");
    const midnight = new Date("2026-11-13T18:30:00Z");
    expect(announcementsUrl({ from: justBefore, to: midnight })).toContain("from_date=13-11-2026&to_date=14-11-2026");
  });
});

describe("normaliseAnnouncement field mapping", () => {
  const base = { seq_id: "9", symbol: "INFY", an_dt: "13-Nov-2026 10:00:00" };

  it("defaults optional fields and falls back to the symbol for the name", () => {
    expect(normaliseAnnouncement(base)).toMatchObject({
      companyName: "INFY",
      isin: null,
      industry: null,
      subject: "",
      text: "",
      exchangeSummary: null,
      attachmentUrl: null,
      attachmentSizeKb: null,
      hasXbrl: false,
    });
  });

  it("accepts hasXbrl as boolean or the string 'true' only", () => {
    expect(normaliseAnnouncement({ ...base, hasXbrl: "true" }).hasXbrl).toBe(true);
    expect(normaliseAnnouncement({ ...base, hasXbrl: "false" }).hasXbrl).toBe(false);
    expect(normaliseAnnouncement({ ...base, hasXbrl: 1 }).hasXbrl).toBe(false);
  });

  it("keeps only absolute http(s) attachment URLs", () => {
    const url = (attchmntFile: unknown) => normaliseAnnouncement({ ...base, attchmntFile }).attachmentUrl;
    expect(url("HTTPS://nsearchives.nseindia.com/corporate/x.pdf")).toBe("HTTPS://nsearchives.nseindia.com/corporate/x.pdf");
    expect(url("/corporate/x.pdf")).toBeNull();
    expect(url("javascript:alert(1)")).toBeNull();
    expect(url("-")).toBeNull();
    expect(url(42)).toBeNull();
  });

  it("reads the size from attFileSize, else fileSize", () => {
    expect(normaliseAnnouncement({ ...base, fileSize: "2 MB" }).attachmentSizeKb).toBe(2048);
    expect(normaliseAnnouncement({ ...base, attFileSize: "10 KB", fileSize: "2 MB" }).attachmentSizeKb).toBe(10);
  });

  it("parses sizes in every unit and rejects unknown ones", () => {
    expect(parseSizeKb("512 bytes")).toBe(0.5);
    expect(parseSizeKb("1024 B")).toBe(1);
    expect(parseSizeKb("233.67 KB")).toBe(233.67);
    expect(parseSizeKb(" 1 gb ")).toBe(1024 * 1024);
    expect(parseSizeKb("12 parsecs")).toBeNull();
    expect(parseSizeKb("1.2.3 MB")).toBeNull();
    expect(parseSizeKb("MB")).toBeNull();
    expect(parseSizeKb("")).toBeNull();
  });
});
