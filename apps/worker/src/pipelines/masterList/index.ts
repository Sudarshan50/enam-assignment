import { companiesRepo, type MasterListUpsert } from "@finn/db/repositories/companies";
import { sourceHealthRepo } from "@finn/db/repositories/sourceHealth";
import type { StatementFamily } from "@finn/shared/taxonomy";
import { fetchMasterList } from "@finn/sources/nse/masterList";
import type { MasterListEntry } from "@finn/sources/types";
import type { Command, WorkerContext } from "../../context";

export const MASTER_LIST_SOURCE = "nse_master_list";

/** Equity series that trade on NSE's main board (EQ) or in trade-for-trade segments (BE/BZ). */
const EQUITY_SERIES = new Set(["EQ", "BE", "BZ"]);

/** Only a first guess for brand-new rows; the XBRL filename overrides it once results are parsed. */
export function guessFamily(name: string): StatementFamily {
  return /\bbank\b/i.test(name) && !/\binvestment bank|merchant bank/i.test(name) ? "banking" : "industrial";
}

export function toMasterListUpserts(entries: readonly MasterListEntry[]): MasterListUpsert[] {
  const bySymbol = new Map<string, MasterListUpsert>();
  for (const e of entries) {
    const series = e.series.trim().toUpperCase();
    if (!EQUITY_SERIES.has(series)) continue;
    const symbol = e.symbol.trim().toUpperCase();
    if (!symbol || bySymbol.has(symbol)) continue;
    bySymbol.set(symbol, { symbol, name: e.name.trim(), isin: e.isin || null, series, statementFamily: guessFamily(e.name) });
  }
  return [...bySymbol.values()];
}

/** Loads the NSE equity master list so Ask can resolve any ticker. Idempotent upsert on symbol. */
export async function runMasterList(ctx: WorkerContext): Promise<{ fetched: number; eligible: number; written: number; total: number }> {
  const health = sourceHealthRepo(ctx.sql);
  try {
    const entries = await fetchMasterList(ctx.http);
    const rows = toMasterListUpserts(entries);
    const companies = companiesRepo(ctx.sql);
    const written = await companies.upsertMasterList(rows);
    await health.recordSuccess(MASTER_LIST_SOURCE, rows.length);
    return { fetched: entries.length, eligible: rows.length, written, total: await companies.count() };
  } catch (err) {
    await health.recordFailure(MASTER_LIST_SOURCE, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export const masterListCommand: Command = {
  name: "master-list",
  description: "Upsert the NSE equity master list (EQUITY_L.csv) into companies",
  async run(ctx) {
    ctx.log.info(await runMasterList(ctx), "Master list loaded");
  },
};
