import { describe, expect, it } from "vitest";
import { bhavcopyUrl, fetchBhavcopy, parseBhavcopyCsv, unzipBhavcopy } from "../src/nse/bhavcopy";
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
