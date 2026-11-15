import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { HttpError, type HttpClient } from "../src/http/client";
import { bhavcopyUrl, EQUITY_SERIES, fetchBhavcopy, parseBhavcopyCsv, unzipBhavcopy } from "../src/nse/bhavcopy";
import { fakeHttp, readFixtureBytes } from "./helpers";

const zip = readFixtureBytes("bhavcopy_20261113.csv.zip");
const session = new Date("2026-11-13T12:00:00Z");

describe("bhavcopy", () => {
  it("builds the archive URL from the IST date", () => {
    expect(bhavcopyUrl(new Date("2026-11-12T20:00:00Z"))).toBe(
      "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20261113_F_0000.csv.zip",
    );
  });

  it("unzips and parses equity rows with numeric fields", () => {
    const rows = parseBhavcopyCsv(unzipBhavcopy(zip));
    expect(rows.length).toBeGreaterThan(3000);
    expect(new Set(rows.map((r) => r.series))).toEqual(new Set(["EQ", "BE", "BZ", "SM"]));

    expect(rows.find((r) => r.symbol === "RELIANCE")).toEqual({
      symbol: "RELIANCE",
      series: "EQ",
      isin: "INE002A01018",
      sessionDate: "2026-11-13",
      open: 1336.6,
      high: 1350.7,
      low: 1324,
      close: 1339.7,
      prevClose: 1339.7,
      volume: 13756247,
      turnover: 18407210893.7,
      trades: 207960,
    });
    const tcs = rows.find((r) => r.symbol === "TCS")!;
    expect(tcs.close).toBe(2407.5);
    expect(tcs.prevClose).toBe(2442.4);
    expect(tcs.close / tcs.prevClose - 1).toBeCloseTo(-0.01429, 4);
  });

  it("drops non-equity series such as gold bonds", () => {
    expect(parseBhavcopyCsv(unzipBhavcopy(zip)).some((r) => r.symbol.startsWith("SGB"))).toBe(false);
  });

  it("fetches a published day and returns null on 404 (holiday / not yet published)", async () => {
    const http = fakeHttp({ [bhavcopyUrl(session)]: zip });
    expect((await fetchBhavcopy(http, session))?.length).toBeGreaterThan(3000);
    expect(await fetchBhavcopy(http, new Date("2026-11-14T12:00:00Z"))).toBeNull();
  });
});

const HEADER =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";

function bhavLine(cells: { symbol: string; series: string; isin?: string; o?: string; h?: string; l?: string; c?: string; pc?: string; vol?: string; val?: string; trades?: string }): string {
  const { symbol, series, isin = "INE000A01010", o = "10", h = "11", l = "9", c = "10.5", pc = "10", vol = "100", val = "1050", trades = "7" } = cells;
  return ["2026-11-13", "2026-11-13", "CM", "NSE", "STK", "1", isin, symbol, series, "", "", "", "", symbol, o, h, l, c, c, pc, "", c, "", "", vol, val, trades, "F1", "1", "", "", "", "", ""].join(",");
}

const csvOf = (...lines: string[]) => [HEADER, ...lines].join("\n");
const zipOf = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([n, t]) => [n, strToU8(t)])));

describe("parseBhavcopyCsv", () => {
  it("keeps EQ/BE/BZ/SM by default and drops bonds, ETFs and the rest", () => {
    const csv = csvOf(
      bhavLine({ symbol: "A", series: "EQ" }),
      bhavLine({ symbol: "B", series: "BE" }),
      bhavLine({ symbol: "C", series: "BZ" }),
      bhavLine({ symbol: "D", series: "SM" }),
      bhavLine({ symbol: "SGBJUN31", series: "GB" }),
      bhavLine({ symbol: "NIFTYBEES", series: "ETF" }),
      bhavLine({ symbol: "E", series: "eq" }),
    );
    expect(parseBhavcopyCsv(csv).map((r) => r.symbol)).toEqual(["A", "B", "C", "D"]);
    expect(EQUITY_SERIES).toEqual(["EQ", "BE", "BZ", "SM"]);
  });

  it("honours a custom series filter", () => {
    const csv = csvOf(bhavLine({ symbol: "A", series: "EQ" }), bhavLine({ symbol: "G", series: "GB" }));
    expect(parseBhavcopyCsv(csv, ["GB"]).map((r) => r.symbol)).toEqual(["G"]);
    expect(parseBhavcopyCsv(csv, [])).toEqual([]);
  });

  it("parses numbers with thousands separators and defaults optional fields", () => {
    const csv = csvOf(bhavLine({ symbol: "MRF", series: "EQ", o: '"1,20,000.5"', h: "121000", l: "119000", c: "120500", pc: "", vol: "", val: "-", trades: "abc" }));
    expect(parseBhavcopyCsv(csv)).toEqual([
      { symbol: "MRF", series: "EQ", isin: "INE000A01010", sessionDate: "2026-11-13", open: 120000.5, high: 121000, low: 119000, close: 120500, prevClose: 120500, volume: 0, turnover: 0, trades: 0 },
    ]);
  });

  it("skips rows with a missing or non-numeric price and rows without a symbol", () => {
    const csv = csvOf(
      bhavLine({ symbol: "OK", series: "EQ" }),
      bhavLine({ symbol: "NOOPEN", series: "EQ", o: "" }),
      bhavLine({ symbol: "BADCLOSE", series: "EQ", c: "n/a" }),
      bhavLine({ symbol: "", series: "EQ" }),
    );
    expect(parseBhavcopyCsv(csv).map((r) => r.symbol)).toEqual(["OK"]);
  });

  it("tolerates truncated lines, blank lines, CRLF and a BOM", () => {
    const truncated = "2026-11-13,2026-11-13,CM,NSE,STK,1,INE1,CUT,EQ,,,,,CUT,10,11";
    const csv = `\ufeff${HEADER}\r\n${bhavLine({ symbol: "A", series: "EQ" })}\r\n\r\n${truncated}\r\n${bhavLine({ symbol: "B", series: "EQ" })}`;
    expect(parseBhavcopyCsv(csv).map((r) => r.symbol)).toEqual(["A", "B"]);
  });

  it("returns nothing for an empty file or a header-only file", () => {
    expect(parseBhavcopyCsv("")).toEqual([]);
    expect(parseBhavcopyCsv(HEADER)).toEqual([]);
  });
});

describe("unzipBhavcopy", () => {
  it("picks the CSV out of the archive regardless of case or other entries", () => {
    const csv = csvOf(bhavLine({ symbol: "A", series: "EQ" }));
    expect(unzipBhavcopy(zipOf({ "readme.txt": "hi", "BhavCopy_NSE_CM.CSV": csv }))).toBe(csv);
  });

  it("fails loudly on an archive without a CSV or on bytes that are not a zip", () => {
    expect(() => unzipBhavcopy(zipOf({ "readme.txt": "hi" }))).toThrow("Bhavcopy archive contains no CSV");
    expect(() => unzipBhavcopy(new TextEncoder().encode("<html>Access Denied</html>"))).toThrow();
  });
});

describe("fetchBhavcopy failures", () => {
  const url = bhavcopyUrl(session);

  it("rethrows non-404 HTTP errors and transport errors", async () => {
    const failing = (err: Error): HttpClient => ({ ...fakeHttp({}), getBuffer: async () => Promise.reject(err) });
    await expect(fetchBhavcopy(failing(new HttpError("HTTP 503", url, 503)), session)).rejects.toMatchObject({ status: 503 });
    await expect(fetchBhavcopy(failing(new HttpError("HTTP 403", url, 403)), session)).rejects.toMatchObject({ status: 403 });
    await expect(fetchBhavcopy(failing(new TypeError("fetch failed")), session)).rejects.toThrow("fetch failed");
  });

  it("refuses a published file that has no equity rows", async () => {
    const http = fakeHttp({ [url]: zipOf({ "x.csv": csvOf(bhavLine({ symbol: "SGB", series: "GB" })) }) });
    await expect(fetchBhavcopy(http, session)).rejects.toThrow("Bhavcopy for 2026-11-13 parsed to zero equity rows");
  });

  it("surfaces an unzip failure instead of returning null", async () => {
    await expect(fetchBhavcopy(fakeHttp({ [url]: "<html>maintenance</html>" }), session)).rejects.toThrow();
  });
});
