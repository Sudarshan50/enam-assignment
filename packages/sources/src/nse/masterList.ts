import { istDateString, parseNseDate } from "@finn/shared/format";
import type { HttpClient } from "../http/client";
import type { MasterListEntry } from "../types";
import { parseCsvRecords } from "../util/csv";
import { parseLooseNumber } from "../util/values";
import { NSE_ARCHIVES_BASE } from "./endpoints";

export const MASTER_LIST_URL = `${NSE_ARCHIVES_BASE}/content/equities/EQUITY_L.csv`;

/** EQUITY_L.csv headers carry leading spaces (" SERIES"); parseCsvRecords trims them. */
export function parseMasterList(csv: string): MasterListEntry[] {
  const entries: MasterListEntry[] = [];
  for (const r of parseCsvRecords(csv)) {
    const symbol = r.SYMBOL;
    const isin = r["ISIN NUMBER"];
    if (!symbol || !isin) continue;
    const listed = parseNseDate(r["DATE OF LISTING"] ?? "");
    entries.push({
      symbol,
      name: r["NAME OF COMPANY"] || symbol,
      series: r.SERIES ?? "",
      isin,
      listedOn: listed ? istDateString(listed) : null,
      faceValue: parseLooseNumber(r["FACE VALUE"]),
    });
  }
  return entries;
}

export async function fetchMasterList(http: HttpClient): Promise<MasterListEntry[]> {
  const entries = parseMasterList(await http.getText(MASTER_LIST_URL));
  if (entries.length === 0) throw new Error("NSE master list parsed to zero rows");
  return entries;
}
