import { IST_OFFSET_MS, nseQueryDate, parseNseDate } from "@finn/shared/format";
import type { HttpClient } from "../http/client";
import type { RawAnnouncement } from "../types";
import { nseRows, str } from "../util/values";
import { NSE_API_BASE, NSE_API_HEADERS } from "./endpoints";

export class InvalidAnnouncementError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = "InvalidAnnouncementError";
  }
}

export function normaliseAnnouncement(raw: Record<string, unknown>): RawAnnouncement {
  const seqId = str(raw.seq_id);
  const symbol = str(raw.symbol);
  if (!seqId || !symbol) throw new InvalidAnnouncementError("Announcement row without seq_id or symbol", raw);
  const publishedAt = parsePublishedAt(raw);
  if (!publishedAt) throw new InvalidAnnouncementError(`Unparseable an_dt for seq_id ${seqId}`, raw);

  return {
    seqId,
    symbol,
    companyName: str(raw.sm_name) ?? symbol,
    isin: str(raw.sm_isin),
    industry: str(raw.smIndustry),
    subject: str(raw.desc) ?? "",
    text: str(raw.attchmntText) ?? "",
    exchangeSummary: str(raw.voiceSummary),
    attachmentUrl: attachmentUrl(raw.attchmntFile),
    attachmentSizeKb: parseSizeKb(str(raw.attFileSize) ?? str(raw.fileSize)),
    hasXbrl: raw.hasXbrl === true || raw.hasXbrl === "true",
    publishedAt,
    raw,
  };
}

export interface FetchAnnouncementsOptions {
  from: Date;
  to: Date;
  symbol?: string;
  /** Called for rows that cannot be normalised; they are excluded from the result. */
  onInvalidRow?: (error: InvalidAnnouncementError) => void;
}

export function announcementsUrl(options: Pick<FetchAnnouncementsOptions, "from" | "to" | "symbol">): string {
  const params = new URLSearchParams({
    index: "equities",
    from_date: nseQueryDate(options.from),
    to_date: nseQueryDate(options.to),
  });
  if (options.symbol) params.set("symbol", options.symbol);
  return `${NSE_API_BASE}/corporate-announcements?${params.toString()}`;
}

/** Throws when the payload is not a JSON array, so an outage is never mistaken for "no news". */
export async function fetchAnnouncements(http: HttpClient, options: FetchAnnouncementsOptions): Promise<RawAnnouncement[]> {
  const url = announcementsUrl(options);
  const rows = nseRows(await http.getJson<unknown>(url, NSE_API_HEADERS));
  if (!rows) throw new Error(`Unexpected announcements payload from ${url}`);

  const bySeq = new Map<string, RawAnnouncement>();
  for (const row of rows) {
    try {
      const ann = normaliseAnnouncement(row);
      if (!bySeq.has(ann.seqId)) bySeq.set(ann.seqId, ann);
    } catch (err) {
      if (err instanceof InvalidAnnouncementError) options.onInvalidRow?.(err);
      else throw err;
    }
  }
  return [...bySeq.values()];
}

function parsePublishedAt(raw: Record<string, unknown>): Date | null {
  const anDt = str(raw.an_dt);
  const fromAnDt = anDt ? parseNseDate(anDt) : null;
  if (fromAnDt) return fromAnDt;
  // sort_date is "YYYY-MM-DD HH:mm:ss" in India time.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str(raw.sort_date) ?? "");
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss) - IST_OFFSET_MS);
}

function attachmentUrl(value: unknown): string | null {
  const url = str(value);
  if (!url || url === "-" || !/^https?:\/\//i.test(url)) return null;
  return url;
}

const SIZE_UNITS_KB: Record<string, number> = { bytes: 1 / 1024, b: 1 / 1024, kb: 1, mb: 1024, gb: 1024 * 1024 };

export function parseSizeKb(value: string | null): number | null {
  if (!value) return null;
  const m = /^([\d.]+)\s*([a-z]+)$/i.exec(value.trim());
  if (!m) return null;
  const factor = SIZE_UNITS_KB[m[2]!.toLowerCase()];
  const n = Number(m[1]);
  if (factor === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * factor * 100) / 100;
}
