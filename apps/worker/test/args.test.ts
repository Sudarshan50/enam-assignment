import { describe, expect, it } from "vitest";
import { argFlag, argInt, argIsoDate, argString, parseArgv, UsageError } from "../src/args";
import { toPriceRows } from "../src/pipelines/eod";
import { guessFamily, toMasterListUpserts } from "../src/pipelines/masterList";

describe("parseArgv", () => {
  it("parses command, --key value, --key=value, flags and --no-flag", () => {
    const { command, args } = parseArgv(["results", "--symbol", "TCS", "--period=2026-09-30", "--once", "--no-push", "extra"]);
    expect(command).toBe("results");
    expect(argString(args, "symbol")).toBe("TCS");
    expect(argIsoDate(args, "period")).toBe("2026-09-30");
    expect(argFlag(args, "once")).toBe(true);
    expect(args.push).toBe(false);
    expect(args._).toEqual(["extra"]);
  });

  it("treats an empty value as absent and validates types", () => {
    const { args } = parseArgv(["research", "--symbol", "TCS", "--run-id", "", "--days", "x"]);
    expect(argString(args, "run-id")).toBeUndefined();
    expect(() => argInt(args, "days", 30)).toThrow(UsageError);
    expect(argInt(parseArgv(["x"]).args, "days", 30)).toBe(30);
    expect(() => argIsoDate(parseArgv(["x", "--date", "13-11-2026"]).args, "date")).toThrow(UsageError);
  });
});

describe("pipeline helpers", () => {
  it("keeps one EQ row per tracked symbol from the bhavcopy", () => {
    const base = { isin: "X", sessionDate: "2026-11-13", open: 1, high: 1, low: 1, close: 1, prevClose: 1, volume: 10, turnover: 1, trades: 1 };
    const rows = toPriceRows(
      [
        { ...base, symbol: "TCS", series: "BE", close: 2 },
        { ...base, symbol: "TCS", series: "EQ", close: 3 },
        { ...base, symbol: "OTHER", series: "EQ" },
      ],
      new Set(["TCS"]),
      "bhavcopy",
    );
    expect(rows).toEqual([expect.objectContaining({ symbol: "TCS", close: 3, source: "bhavcopy" })]);
  });

  it("filters the master list to equity series and guesses banks", () => {
    const rows = toMasterListUpserts([
      { symbol: "HDFCBANK", name: "HDFC Bank Limited", series: "EQ", isin: "INE040A01034", listedOn: null, faceValue: 1 },
      { symbol: "SOMEGS", name: "Some Govt Sec", series: "GS", isin: "IN0000", listedOn: null, faceValue: 100 },
      { symbol: "21STCENMGM", name: "21st Century Management Services Limited", series: "BE", isin: "INE253B01015", listedOn: null, faceValue: 10 },
    ]);
    expect(rows.map((r) => [r.symbol, r.statementFamily])).toEqual([
      ["HDFCBANK", "banking"],
      ["21STCENMGM", "industrial"],
    ]);
    expect(guessFamily("Bank of Baroda")).toBe("banking");
  });
});
