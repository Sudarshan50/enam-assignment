import type { Sql } from "../client";

export type PriceSource = "bhavcopy" | "yahoo";

export interface PriceUpsert {
  symbol: string;
  sessionDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  prevClose: number | null;
  volume: number | null;
  source: PriceSource;
}

export interface PriceRow {
  symbol: string;
  sessionDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  prevClose: number | null;
  volume: number | null;
  avg20Volume: number | null;
  source: PriceSource;
}

/** Sessions of history required before an average volume (and so a volume alert) exists. */
export const AVG_VOLUME_SESSIONS = 20;

const BATCH = 1000;

export function pricesRepo(sql: Sql) {
  const columns = () => sql`
    symbol, session_date::text AS "sessionDate", open::float8 AS open, high::float8 AS high, low::float8 AS low,
    close::float8 AS close, prev_close::float8 AS "prevClose", volume::float8 AS volume,
    avg20_volume::float8 AS "avg20Volume", source`;

  return {
    /** Idempotent on (symbol, session_date). A bhavcopy row always replaces a Yahoo fallback row, never the reverse. */
    async upsertMany(rows: readonly PriceUpsert[]): Promise<number> {
      let written = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map((r) => ({
          symbol: r.symbol,
          session_date: r.sessionDate,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          prev_close: r.prevClose,
          volume: r.volume == null ? null : Math.round(r.volume),
          source: r.source,
        }));
        const res = await sql`
          INSERT INTO prices_eod ${sql(batch, "symbol", "session_date", "open", "high", "low", "close", "prev_close", "volume", "source")}
          ON CONFLICT (symbol, session_date) DO UPDATE SET
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
            prev_close = COALESCE(EXCLUDED.prev_close, prices_eod.prev_close), volume = EXCLUDED.volume, source = EXCLUDED.source
          WHERE prices_eod.source <> 'bhavcopy' OR EXCLUDED.source = 'bhavcopy'`;
        written += res.count ?? 0;
      }
      return written;
    },

    /**
     * avg20_volume = mean volume of the previous 20 sessions (excluding the session itself);
     * NULL until 20 sessions of history exist.
     */
    async recomputeAvg20(opts: { from?: string } = {}): Promise<number> {
      const res = await sql`
        WITH w AS (
          SELECT symbol, session_date,
                 CASE WHEN count(volume) OVER prev20 = ${AVG_VOLUME_SESSIONS} THEN avg(volume) OVER prev20 END AS avg20
          FROM prices_eod
          WINDOW prev20 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN ${AVG_VOLUME_SESSIONS} PRECEDING AND 1 PRECEDING)
        )
        UPDATE prices_eod p SET avg20_volume = w.avg20
        FROM w
        WHERE p.symbol = w.symbol AND p.session_date = w.session_date
          ${opts.from ? sql`AND p.session_date >= ${opts.from}` : sql``}
          AND p.avg20_volume IS DISTINCT FROM w.avg20`;
      return res.count ?? 0;
    },

    async latestSessionDate(): Promise<string | null> {
      const [row] = await sql<{ d: string | null }[]>`SELECT max(session_date)::text AS d FROM prices_eod`;
      return row?.d ?? null;
    },

    async countForSession(sessionDate: string, source?: PriceSource): Promise<number> {
      const [row] = source
        ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM prices_eod WHERE session_date = ${sessionDate} AND source = ${source}`
        : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM prices_eod WHERE session_date = ${sessionDate}`;
      return row?.n ?? 0;
    },

    async forSession(sessionDate: string): Promise<PriceRow[]> {
      return sql<PriceRow[]>`SELECT ${columns()} FROM prices_eod WHERE session_date = ${sessionDate} ORDER BY symbol`;
    },

    async latestPerSymbol(symbols?: readonly string[]): Promise<PriceRow[]> {
      return sql<PriceRow[]>`
        SELECT DISTINCT ON (symbol) ${columns()} FROM prices_eod
        ${symbols ? sql`WHERE symbol = ANY(${[...symbols]})` : sql``}
        ORDER BY symbol, session_date DESC`;
    },

    async history(symbol: string, sessions = 30): Promise<PriceRow[]> {
      const rows = await sql<PriceRow[]>`
        SELECT ${columns()} FROM prices_eod WHERE symbol = ${symbol} ORDER BY session_date DESC LIMIT ${sessions}`;
      return rows.reverse();
    },

    async sessionCount(symbol?: string): Promise<number> {
      const [row] = symbol
        ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM prices_eod WHERE symbol = ${symbol}`
        : await sql<{ n: number }[]>`SELECT count(DISTINCT session_date)::int AS n FROM prices_eod`;
      return row?.n ?? 0;
    },

    async count(): Promise<number> {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM prices_eod`;
      return row?.n ?? 0;
    },
  };
}

export type PricesRepo = ReturnType<typeof pricesRepo>;
