import { type Holding, StatementFamilySchema } from "@finn/shared";
import { round } from "../lib/numbers";

export interface PricePoint {
  sessionDate: string;
  close: number;
  prevClose: number | null;
  volume: number | null;
  avg20Volume: number | null;
}

export interface HoldingRow {
  symbol: string;
  name: string;
  statementFamily: string | null;
  unreadCount: number;
  researchReady: boolean;
  /** Most recent sessions, oldest first. */
  prices: PricePoint[];
}

export interface HoldingsRepository {
  list(sessions: number): Promise<HoldingRow[]>;
}

export interface HoldingsService {
  list(): Promise<Holding[]>;
}

export const SPARKLINE_SESSIONS = 30;
const AVG_WINDOW = 20;

/** Volume vs the previous 20 completed sessions; null until 20 sessions of history exist. */
export function volumeVsAverage(prices: PricePoint[], index: number): number | null {
  const point = prices[index];
  if (!point?.volume) return null;
  let avg = point.avg20Volume;
  if (avg == null) {
    if (index < AVG_WINDOW) return null;
    const window = prices.slice(index - AVG_WINDOW, index).map((p) => p.volume ?? 0);
    avg = window.reduce((s, v) => s + v, 0) / AVG_WINDOW;
  }
  return avg > 0 ? point.volume / avg : null;
}

export function toHolding(row: HoldingRow): Holding {
  const prices = row.prices;
  const lastIndex = prices.length - 1;
  const latest = prices[lastIndex];
  const prevClose = latest?.prevClose ?? prices[lastIndex - 1]?.close ?? null;
  const changePct = latest && prevClose ? round((latest.close / prevClose - 1) * 100, 2) : null;
  const vsAvg = latest ? volumeVsAverage(prices, lastIndex) : null;
  const family = StatementFamilySchema.safeParse(row.statementFamily);
  return {
    symbol: row.symbol,
    name: row.name,
    statementFamily: family.success ? family.data : null,
    close: latest?.close ?? null,
    changePct,
    volume: latest?.volume ?? null,
    volumeVsAvg: vsAvg === null ? null : round(vsAvg, 2),
    sessionDate: latest?.sessionDate ?? null,
    sparkline: prices.slice(-SPARKLINE_SESSIONS).map((p) => p.close),
    unreadCount: row.unreadCount,
    researchReady: row.researchReady,
  };
}

export function createHoldingsService(repo: HoldingsRepository): HoldingsService {
  return {
    async list() {
      return (await repo.list(SPARKLINE_SESSIONS + AVG_WINDOW)).map(toHolding);
    },
  };
}
