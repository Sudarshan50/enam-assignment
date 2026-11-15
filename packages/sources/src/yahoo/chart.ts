import { istDateString } from "@finn/shared/format";
import type { HttpClient } from "../http/client";
import type { YahooDailyRow } from "../types";
import { isRecord } from "../util/values";

export type YahooRange = "5d" | "1mo" | "3mo" | "6mo" | "1y";

export function yahooChartUrl(symbol: string, range: YahooRange = "3mo"): string {
  const ticker = encodeURIComponent(`${symbol.trim().toUpperCase()}.NS`);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=1d`;
}

/** Fallback only: NSE bhavcopy is the primary price source. Bars with a null close are skipped. */
export function parseYahooChart(json: unknown, symbol: string): YahooDailyRow[] {
  const result = isRecord(json) && isRecord(json.chart) && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  if (!isRecord(result)) {
    const error = isRecord(json) && isRecord(json.chart) ? json.chart.error : null;
    throw new Error(`Yahoo chart has no result for ${symbol}: ${JSON.stringify(error ?? null)}`);
  }
  const timestamps = Array.isArray(result.timestamp) ? (result.timestamp as unknown[]) : [];
  const indicators = isRecord(result.indicators) && Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : null;
  const quote = isRecord(indicators) ? indicators : {};
  const meta = isRecord(result.meta) ? result.meta : {};
  const at = (key: string, i: number) => (Array.isArray(quote[key]) ? num((quote[key] as unknown[])[i]) : null);

  const rows: YahooDailyRow[] = [];
  let prevClose = num(meta.chartPreviousClose);
  timestamps.forEach((ts, i) => {
    const close = at("close", i);
    if (typeof ts !== "number" || close === null) return;
    rows.push({
      symbol,
      series: "EQ",
      isin: null,
      sessionDate: istDateString(new Date(ts * 1000)),
      open: at("open", i) ?? close,
      high: at("high", i) ?? close,
      low: at("low", i) ?? close,
      close,
      prevClose: prevClose ?? close,
      volume: at("volume", i) ?? 0,
      turnover: null,
      trades: null,
      source: "yahoo",
    });
    prevClose = close;
  });
  return rows;
}

export async function fetchYahooDaily(http: HttpClient, symbol: string, range: YahooRange = "3mo"): Promise<YahooDailyRow[]> {
  return parseYahooChart(await http.getJson<unknown>(yahooChartUrl(symbol, range)), symbol);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
