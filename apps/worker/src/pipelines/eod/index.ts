import { companiesRepo } from "@finn/db/repositories/companies";
import { pricesRepo, type PriceUpsert } from "@finn/db/repositories/prices";
import { sourceHealthRepo } from "@finn/db/repositories/sourceHealth";
import { fetchBhavcopy } from "@finn/sources/nse/bhavcopy";
import type { BhavRow } from "@finn/sources/types";
import { fetchYahooDaily } from "@finn/sources/yahoo/chart";
import { argFlag, argInt, argIsoDate } from "../../args";
import type { Command, WorkerContext } from "../../context";
import { addDays, isWeekend, istNoon, todayIst } from "../../time";
import { runPriceAlerts, type AlertRunSummary } from "../alerts";

export const BHAVCOPY_SOURCE = "nse_bhavcopy";
export const YAHOO_SOURCE = "yahoo_chart";
const SERIES_PREFERENCE = ["EQ", "BE", "BZ", "SM"];

export interface EodSummary {
  sessionDate: string;
  status: "stored" | "skipped_existing" | "not_published";
  source: "bhavcopy" | "yahoo" | null;
  rowsStored: number;
  universe: number;
  alerts: AlertRunSummary | null;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One row per tracked symbol, preferring the EQ series when a stock trades in several. */
export function toPriceRows(rows: readonly BhavRow[], universe: ReadonlySet<string>, source: PriceUpsert["source"]): PriceUpsert[] {
  const best = new Map<string, BhavRow>();
  const rank = (s: string) => {
    const i = SERIES_PREFERENCE.indexOf(s);
    return i < 0 ? SERIES_PREFERENCE.length : i;
  };
  for (const r of rows) {
    const symbol = r.symbol.toUpperCase();
    if (!universe.has(symbol)) continue;
    const prev = best.get(symbol);
    if (!prev || rank(r.series) < rank(prev.series)) best.set(symbol, r);
  }
  return [...best.values()].map((r) => ({
    symbol: r.symbol.toUpperCase(),
    sessionDate: r.sessionDate,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    prevClose: r.prevClose,
    volume: r.volume,
    source,
  }));
}

async function universeFor(ctx: WorkerContext, all: boolean): Promise<Set<string>> {
  const companies = companiesRepo(ctx.sql);
  const rows = all ? await companies.listAll() : await companies.listTracked();
  return new Set(rows.map((c) => c.symbol));
}

async function yahooFallback(ctx: WorkerContext, sessionDate: string, universe: ReadonlySet<string>): Promise<PriceUpsert[]> {
  const out: PriceUpsert[] = [];
  for (const symbol of universe) {
    try {
      const rows = await fetchYahooDaily(ctx.http, symbol, "5d");
      const row = rows.find((r) => r.sessionDate === sessionDate);
      if (row) out.push(...toPriceRows([{ ...row, isin: "", turnover: 0, trades: 0 }], universe, "yahoo"));
    } catch (err) {
      ctx.log.warn({ symbol, error: errorMessage(err) }, "Yahoo fallback failed for symbol");
    }
  }
  return out;
}

/**
 * Stores one session of end-of-day prices and evaluates price/volume alerts. Idempotent: prices upsert
 * on (symbol, session_date) and alerts on (rule, symbol, kind, session).
 */
export async function runEod(
  ctx: WorkerContext,
  opts: { date?: string; all?: boolean; ifMissing?: boolean; alerts?: boolean } = {},
): Promise<EodSummary> {
  const sessionDate = opts.date ?? todayIst();
  const prices = pricesRepo(ctx.sql);
  const health = sourceHealthRepo(ctx.sql);
  const universe = await universeFor(ctx, Boolean(opts.all));
  const summary: EodSummary = { sessionDate, status: "stored", source: null, rowsStored: 0, universe: universe.size, alerts: null };

  if (opts.ifMissing && (await prices.countForSession(sessionDate, "bhavcopy")) > 0) {
    summary.status = "skipped_existing";
    return summary;
  }

  let rows: PriceUpsert[] | null = null;
  try {
    const bhav = await fetchBhavcopy(ctx.http, istNoon(sessionDate));
    if (bhav === null) {
      await health.recordSuccess(BHAVCOPY_SOURCE, 0);
      summary.status = "not_published";
      return summary;
    }
    rows = toPriceRows(bhav, universe, "bhavcopy");
    summary.source = "bhavcopy";
    await health.recordSuccess(BHAVCOPY_SOURCE, rows.length);
  } catch (err) {
    const error = errorMessage(err);
    await health.recordFailure(BHAVCOPY_SOURCE, error);
    ctx.log.warn({ sessionDate, error }, "Bhavcopy failed; falling back to Yahoo for tracked symbols");
    const tracked = opts.all ? await universeFor(ctx, false) : universe;
    rows = await yahooFallback(ctx, sessionDate, tracked);
    if (rows.length === 0) {
      await health.recordFailure(YAHOO_SOURCE, `No Yahoo rows for ${sessionDate}`);
      throw new Error(`No prices for ${sessionDate}: bhavcopy failed (${error}) and Yahoo returned nothing`);
    }
    summary.source = "yahoo";
    await health.recordSuccess(YAHOO_SOURCE, rows.length);
  }

  summary.rowsStored = await prices.upsertMany(rows);
  await prices.recomputeAvg20({ from: addDays(sessionDate, -40) });
  if (opts.alerts !== false) summary.alerts = await runPriceAlerts(ctx, { sessionDate });
  return summary;
}

/** Walks back over weekdays until `days` sessions are stored; holidays (no file) are skipped. */
export async function backfillPrices(ctx: WorkerContext, opts: { days: number; all?: boolean }): Promise<{ sessions: number; rows: number; failures: number }> {
  const prices = pricesRepo(ctx.sql);
  const universe = await universeFor(ctx, Boolean(opts.all));
  let date = todayIst();
  let sessions = 0;
  let rows = 0;
  let failures = 0;
  const maxCalendarDays = opts.days * 2 + 14;
  for (let tried = 0; sessions < opts.days && tried < maxCalendarDays; tried++, date = addDays(date, -1)) {
    if (isWeekend(date)) continue;
    if ((await prices.countForSession(date, "bhavcopy")) >= universe.size && universe.size > 0) {
      sessions++;
      continue;
    }
    try {
      const bhav = await fetchBhavcopy(ctx.http, istNoon(date));
      if (!bhav) continue;
      rows += await prices.upsertMany(toPriceRows(bhav, universe, "bhavcopy"));
      sessions++;
      ctx.log.info({ date, sessions }, "Bhavcopy stored");
    } catch (err) {
      failures++;
      ctx.log.warn({ date, error: errorMessage(err) }, "Bhavcopy backfill failed for date");
    }
  }
  await prices.recomputeAvg20();
  if (sessions === 0 && failures > 0) throw new Error(`backfill-prices stored nothing (${failures} failures)`);
  return { sessions, rows, failures };
}

export const eodCommand: Command = {
  name: "eod",
  description: "Store end-of-day prices from the NSE bhavcopy (Yahoo fallback) and evaluate alerts (--date YYYY-MM-DD, --if-missing, --all)",
  async run(ctx, args) {
    const summary = await runEod(ctx, { date: argIsoDate(args, "date"), all: argFlag(args, "all"), ifMissing: argFlag(args, "if-missing") });
    ctx.log.info(summary, "EOD finished");
  },
};

export const backfillPricesCommand: Command = {
  name: "backfill-prices",
  description: "Backfill N trading sessions of bhavcopy prices (--days 30, --all for every company)",
  async run(ctx, args) {
    const summary = await backfillPrices(ctx, { days: argInt(args, "days", 30), all: argFlag(args, "all") });
    ctx.log.info(summary, "Price backfill finished");
  },
};
