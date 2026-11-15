import { describe, expect, it } from "vitest";
import { fetchMasterList, MASTER_LIST_URL, parseMasterList } from "../src/nse/masterList";
import { parseCsv, parseCsvRecords } from "../src/util/csv";
import { fakeHttp, readFixture } from "./helpers";

const csv = readFixture("EQUITY_L.csv");

describe("parseMasterList", () => {
  it("handles the leading-space headers and parses every row", () => {
    const entries = parseMasterList(csv);
    expect(entries.length).toBe(2635);
    expect(entries.find((e) => e.symbol === "TCS")).toEqual({
      symbol: "TCS",
      name: "Tata Consultancy Services Limited",
      series: "EQ",
      isin: "INE467B01029",
      listedOn: "2004-08-25",
      faceValue: 1,
    });
    expect(new Set(entries.map((e) => e.series))).toEqual(new Set(["EQ", "BE", "BZ"]));
  });

  it("fetches from NSE archives and refuses an empty list", async () => {
    expect(await fetchMasterList(fakeHttp({ [MASTER_LIST_URL]: csv }))).toHaveLength(2635);
    await expect(fetchMasterList(fakeHttp({ [MASTER_LIST_URL]: "SYMBOL, ISIN NUMBER\n" }))).rejects.toThrow(/zero rows/);
  });
});

describe("parseMasterList edge rows", () => {
  const header = "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE";

  it("skips rows without a symbol or ISIN and defaults unparseable fields", () => {
    const csv = [
      header,
      "ACME,,EQ,31-Feb-20x6,10,1,INE000A01010,abc",
      ",Ghost Ltd,EQ,01-Jan-2000,10,1,INE000B01010,10",
      "NOISIN,No Isin Ltd,EQ,01-Jan-2000,10,1,,10",
      '"M&M","Mahindra & Mahindra, Ltd",EQ,28-Jun-1995,5,1,INE101A01026,5',
    ].join("\n");
    expect(parseMasterList(csv)).toEqual([
      { symbol: "ACME", name: "ACME", series: "EQ", isin: "INE000A01010", listedOn: null, faceValue: null },
      { symbol: "M&M", name: "Mahindra & Mahindra, Ltd", series: "EQ", isin: "INE101A01026", listedOn: "1995-06-28", faceValue: 5 },
    ]);
  });
});

describe("parseCsv", () => {
  it("handles quoted commas, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("strips a BOM, keeps a final line without a newline and skips blank lines", () => {
    expect(parseCsv("\ufeffa,b\n\n1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsv("a,")).toEqual([["a", ""]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("keeps newlines inside quoted fields", () => {
    expect(parseCsv('"line 1\nline 2",x\n')).toEqual([["line 1\nline 2", "x"]]);
  });

  it("parseCsvRecords trims headers and cells and fills short rows with ''", () => {
    expect(parseCsvRecords(" A , B ,C\n 1 ,2\n")).toEqual([{ A: "1", B: "2", C: "" }]);
    expect(parseCsvRecords("")).toEqual([]);
  });
});
