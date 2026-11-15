import { describe, expect, it } from "vitest";
import { fetchYahooDaily, parseYahooChart, yahooChartUrl } from "../src/yahoo/chart";
import { fakeHttp } from "./helpers";

const chart = {
  chart: {
    result: [
      {
        meta: { symbol: "TCS.NS", chartPreviousClose: 2400 },
        // 12, 13 and 14 Nov 2026, 09:15 IST
        timestamp: [1794455100, 1794541500, 1794627900],
        indicators: {
          quote: [
            {
              open: [2401, 2440, null],
              high: [2450, 2451, null],
              low: [2390, 2400, null],
              close: [2442.4, 2407.5, null],
              volume: [3000000, 3344738, null],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

describe("yahoo chart fallback", () => {
  it("maps bars to BhavRow-like rows with chained previous close", () => {
    const rows = parseYahooChart(chart, "TCS");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: "TCS", series: "EQ", sessionDate: "2026-11-12", close: 2442.4, prevClose: 2400, source: "yahoo" });
    expect(rows[1]).toMatchObject({ sessionDate: "2026-11-13", close: 2407.5, prevClose: 2442.4, volume: 3344738, turnover: null });
  });

  it("throws when Yahoo returns an error instead of a result", () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { code: "Not Found" } } }, "XYZ")).toThrow(/no result/);
  });

  it("falls back to the close for missing OHLC/volume and for the first previous close", () => {
    const sparse = {
      chart: {
        result: [{ meta: {}, timestamp: [1794455100, "bad", 1794541500], indicators: { quote: [{ close: [100, 101, Number.NaN], open: "x" }] } }],
      },
    };
    expect(parseYahooChart(sparse, "X")).toEqual([
      { symbol: "X", series: "EQ", isin: null, sessionDate: "2026-11-12", open: 100, high: 100, low: 100, close: 100, prevClose: 100, volume: 0, turnover: null, trades: null, source: "yahoo" },
    ]);
  });

  it("returns no rows for a result without timestamps or quotes", () => {
    expect(parseYahooChart({ chart: { result: [{ meta: { chartPreviousClose: 1 } }] } }, "X")).toEqual([]);
    expect(parseYahooChart({ chart: { result: [{ timestamp: [1794455100], indicators: {} }] } }, "X")).toEqual([]);
  });

  it("throws on payloads that are not a chart", () => {
    expect(() => parseYahooChart(null, "X")).toThrow("Yahoo chart has no result for X: null");
    expect(() => parseYahooChart({ chart: { result: [] } }, "X")).toThrow(/no result/);
    expect(() => parseYahooChart([], "X")).toThrow(/no result/);
  });

  it("encodes the ticker and range", () => {
    expect(yahooChartUrl(" m&m ", "1y")).toBe("https://query1.finance.yahoo.com/v8/finance/chart/M%26M.NS?range=1y&interval=1d");
  });

  it("fetches the .NS ticker", async () => {
    const url = yahooChartUrl("tcs");
    expect(url).toBe("https://query1.finance.yahoo.com/v8/finance/chart/TCS.NS?range=3mo&interval=1d");
    expect(await fetchYahooDaily(fakeHttp({ [url]: chart }), "TCS")).toHaveLength(2);
  });
});
