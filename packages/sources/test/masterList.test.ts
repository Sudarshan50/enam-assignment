import { describe, expect, it } from "vitest";
import { fetchMasterList, MASTER_LIST_URL, parseMasterList } from "../src/nse/masterList";
import { parseCsv } from "../src/util/csv";
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

describe("parseCsv", () => {
  it("handles quoted commas, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
});
