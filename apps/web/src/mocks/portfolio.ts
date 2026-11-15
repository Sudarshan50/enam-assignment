import type { Holding, StatementFamily } from "@finn/shared";
import { lastSessionDate, round, seeded } from "./util";

interface Company {
  symbol: string;
  name: string;
  family: StatementFamily;
}

interface HoldingSeed extends Company {
  close: number;
  changePct: number;
  volumeVsAvg: number;
  avgVolume: number;
  unread: number;
  researchReady: boolean;
}

export const PORTFOLIO: HoldingSeed[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", family: "industrial", close: 1512.4, changePct: 0.62, volumeVsAvg: 0.94, avgVolume: 11_200_000, unread: 1, researchReady: true },
  { symbol: "HDFCBANK", name: "HDFC Bank", family: "banking", close: 1004.15, changePct: 1.84, volumeVsAvg: 1.62, avgVolume: 18_400_000, unread: 1, researchReady: true },
  { symbol: "ICICIBANK", name: "ICICI Bank", family: "banking", close: 1408.9, changePct: -0.41, volumeVsAvg: 0.88, avgVolume: 14_100_000, unread: 1, researchReady: true },
  { symbol: "TCS", name: "Tata Consultancy Services", family: "industrial", close: 3412.6, changePct: 3.42, volumeVsAvg: 2.41, avgVolume: 2_900_000, unread: 2, researchReady: true },
  { symbol: "INFY", name: "Infosys", family: "industrial", close: 1598.35, changePct: 1.12, volumeVsAvg: 1.08, avgVolume: 7_600_000, unread: 1, researchReady: true },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", family: "industrial", close: 2086.0, changePct: 0.95, volumeVsAvg: 1.21, avgVolume: 6_300_000, unread: 1, researchReady: true },
  { symbol: "ITC", name: "ITC", family: "industrial", close: 412.3, changePct: -0.22, volumeVsAvg: 0.79, avgVolume: 12_800_000, unread: 1, researchReady: true },
  { symbol: "LT", name: "Larsen & Toubro", family: "industrial", close: 3968.75, changePct: -1.06, volumeVsAvg: 1.04, avgVolume: 2_100_000, unread: 1, researchReady: true },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical Industries", family: "industrial", close: 1742.2, changePct: 0.31, volumeVsAvg: 0.72, avgVolume: 3_400_000, unread: 0, researchReady: true },
  { symbol: "TITAN", name: "Titan Company", family: "industrial", close: 3780.45, changePct: -1.38, volumeVsAvg: 1.15, avgVolume: 1_500_000, unread: 1, researchReady: true },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", family: "nbfc", close: 1034.8, changePct: -2.14, volumeVsAvg: 1.73, avgVolume: 8_900_000, unread: 1, researchReady: true },
  { symbol: "MARUTI", name: "Maruti Suzuki India", family: "industrial", close: 16240.0, changePct: 0.48, volumeVsAvg: 0.91, avgVolume: 520_000, unread: 0, researchReady: true },
  { symbol: "TRENT", name: "Trent", family: "industrial", close: 4610.55, changePct: -4.82, volumeVsAvg: 2.86, avgVolume: 1_250_000, unread: 2, researchReady: false },
  { symbol: "ETERNAL", name: "Eternal", family: "industrial", close: 318.2, changePct: 2.21, volumeVsAvg: 1.34, avgVolume: 42_000_000, unread: 0, researchReady: true },
  { symbol: "DIXON", name: "Dixon Technologies (India)", family: "industrial", close: 15880.0, changePct: -2.67, volumeVsAvg: 1.92, avgVolume: 410_000, unread: 1, researchReady: false },
  { symbol: "POLYCAB", name: "Polycab India", family: "industrial", close: 7420.3, changePct: 1.57, volumeVsAvg: 1.11, avgVolume: 640_000, unread: 0, researchReady: true },
  { symbol: "PERSISTENT", name: "Persistent Systems", family: "industrial", close: 6150.9, changePct: 0.84, volumeVsAvg: 0.86, avgVolume: 780_000, unread: 0, researchReady: true },
  { symbol: "ADANIPORTS", name: "Adani Ports and Special Economic Zone", family: "industrial", close: 1466.1, changePct: -0.57, volumeVsAvg: 0.97, avgVolume: 3_900_000, unread: 0, researchReady: true },
];

export const SUGGESTED_RESEARCH: Company[] = [
  { symbol: "CDSL", name: "Central Depository Services (India)", family: "industrial" },
  { symbol: "ASTRAL", name: "Astral", family: "industrial" },
  { symbol: "PAGEIND", name: "Page Industries", family: "industrial" },
  { symbol: "DEEPAKNTR", name: "Deepak Nitrite", family: "industrial" },
];

const OTHER_LISTED: Company[] = [
  { symbol: "ASIANPAINT", name: "Asian Paints", family: "industrial" },
  { symbol: "NESTLEIND", name: "Nestle India", family: "industrial" },
  { symbol: "HAL", name: "Hindustan Aeronautics", family: "industrial" },
  { symbol: "IRCTC", name: "Indian Railway Catering and Tourism Corporation", family: "industrial" },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", family: "banking" },
  { symbol: "AXISBANK", name: "Axis Bank", family: "banking" },
  { symbol: "BAJAJFINSV", name: "Bajaj Finserv", family: "nbfc" },
  { symbol: "CHOLAFIN", name: "Cholamandalam Investment and Finance", family: "nbfc" },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", family: "industrial" },
  { symbol: "PIDILITIND", name: "Pidilite Industries", family: "industrial" },
  { symbol: "BSE", name: "BSE", family: "industrial" },
  { symbol: "KAYNES", name: "Kaynes Technology India", family: "industrial" },
  { symbol: "CAMS", name: "Computer Age Management Services", family: "industrial" },
];

export const ALL_COMPANIES: Company[] = [...PORTFOLIO, ...SUGGESTED_RESEARCH, ...OTHER_LISTED];

export function companyName(symbol: string): string {
  return ALL_COMPANIES.find((c) => c.symbol === symbol)?.name ?? symbol;
}

/** A 30-session random walk that ends exactly on today's close and change. */
function sparkline(seed: HoldingSeed): number[] {
  const rand = seeded(seed.symbol);
  const points: number[] = [seed.close];
  const prevClose = seed.close / (1 + seed.changePct / 100);
  points.unshift(prevClose);
  let p = prevClose;
  for (let i = 0; i < 28; i++) {
    const drift = (rand() - 0.5) * 0.028;
    p = p / (1 + drift);
    points.unshift(p);
  }
  return points.map((v) => round(v, 2));
}

export function buildHoldings(now: Date): Holding[] {
  const sessionDate = lastSessionDate(now);
  return PORTFOLIO.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    statementFamily: h.family,
    close: h.close,
    changePct: h.changePct,
    volume: Math.round(h.avgVolume * h.volumeVsAvg),
    volumeVsAvg: h.volumeVsAvg,
    sessionDate,
    sparkline: sparkline(h),
    unreadCount: h.unread,
    researchReady: h.researchReady,
  }));
}
