import { strFromU8, unzipSync } from "fflate";
import { istDateString } from "@finn/shared/format";
import { HttpError, type HttpClient } from "../http/client";
import type { BhavRow } from "../types";
import { parseCsvRecords } from "../util/csv";
import { parseLooseNumber } from "../util/values";
import { NSE_ARCHIVES_BASE } from "./endpoints";

/** Main-board (EQ, BE, BZ) and SME (SM) equity series; bonds, ETFs and the rest are dropped. */
export const EQUITY_SERIES: readonly string[] = ["EQ", "BE", "BZ", "SM"];

export function bhavcopyUrl(date: Date): string {
  const ymd = istDateString(date).replace(/-/g, "");
  return `${NSE_ARCHIVES_BASE}/content/cm/BhavCopy_NSE_CM_0_0_0_${ymd}_F_0000.csv.zip`;
}

export function unzipBhavcopy(buf: Uint8Array): string {
  const files = unzipSync(buf);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".csv"));
  const file = name ? files[name] : undefined;
  if (!file) throw new Error("Bhavcopy archive contains no CSV");
  return strFromU8(file);
}

export function parseBhavcopyCsv(csv: string, series: readonly string[] = EQUITY_SERIES): BhavRow[] {
  const keep = new Set(series);
  const rows: BhavRow[] = [];
  for (const r of parseCsvRecords(csv)) {
    const s = r.SctySrs ?? "";
    if (!keep.has(s) || !r.TckrSymb || !r.TradDt) continue;
    const open = parseLooseNumber(r.OpnPric);
    const high = parseLooseNumber(r.HghPric);
    const low = parseLooseNumber(r.LwPric);
    const close = parseLooseNumber(r.ClsPric);
    if (open === null || high === null || low === null || close === null) continue;
    rows.push({
      symbol: r.TckrSymb,
      series: s,
      isin: r.ISIN ?? "",
      sessionDate: r.TradDt,
      open,
      high,
      low,
      close,
      prevClose: parseLooseNumber(r.PrvsClsgPric) ?? close,
      volume: parseLooseNumber(r.TtlTradgVol) ?? 0,
      turnover: parseLooseNumber(r.TtlTrfVal) ?? 0,
      trades: parseLooseNumber(r.TtlNbOfTxsExctd) ?? 0,
    });
  }
  return rows;
}

/** Returns null when NSE has no file for that date (holiday, weekend, or not yet published). */
export async function fetchBhavcopy(http: HttpClient, date: Date): Promise<BhavRow[] | null> {
  let buf: Uint8Array;
  try {
    buf = await http.getBuffer(bhavcopyUrl(date));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
  const rows = parseBhavcopyCsv(unzipBhavcopy(buf));
  if (rows.length === 0) throw new Error(`Bhavcopy for ${istDateString(date)} parsed to zero equity rows`);
  return rows;
}
