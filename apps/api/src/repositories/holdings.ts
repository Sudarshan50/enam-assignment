import type { Sql } from "@finn/db";
import type { HoldingRow, HoldingsRepository, PricePoint } from "../services/holdingsService";

interface RawHolding extends Omit<HoldingRow, "prices"> {
  prices: { d: string; c: number; pc: number | null; v: number | null; a: number | null }[];
}

export function createHoldingsRepository(sql: Sql): HoldingsRepository {
  return {
    async list(sessions) {
      const rows = await sql<RawHolding[]>`
        SELECT h.symbol, c.name, c.statement_family AS "statementFamily",
          (SELECT count(*)::int FROM announcements a
            WHERE a.symbol = h.symbol AND a.status = 'ready' AND a.parent_seq_id IS NULL
              AND a.tier IN ('act','know') AND a.published_at > now() - interval '7 days'
              AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.seq_id = a.seq_id AND i.action IN ('open','dismiss','pin'))
          ) AS "unreadCount",
          EXISTS (SELECT 1 FROM research_runs r WHERE r.symbol = h.symbol AND r.status IN ('completed','partial')) AS "researchReady",
          COALESCE((
            SELECT json_agg(json_build_object('d', p.session_date::text, 'c', p.close::float8, 'pc', p.prev_close::float8,
                                              'v', p.volume::float8, 'a', p.avg20_volume::float8) ORDER BY p.session_date)
            FROM (SELECT * FROM prices_eod WHERE symbol = h.symbol ORDER BY session_date DESC LIMIT ${sessions}) p
          ), '[]'::json) AS prices
        FROM holdings h JOIN companies c ON c.symbol = h.symbol
        ORDER BY h.symbol`;
      return rows.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        statementFamily: r.statementFamily,
        unreadCount: r.unreadCount,
        researchReady: r.researchReady,
        prices: r.prices.map(
          (p): PricePoint => ({ sessionDate: p.d, close: p.c, prevClose: p.pc, volume: p.v, avg20Volume: p.a }),
        ),
      }));
    },
  };
}
