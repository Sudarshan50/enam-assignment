import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "@finn/db";
import { sourceHealthRepo } from "@finn/db/repositories/sourceHealth";
import { MASTER_LIST_URL } from "@finn/sources/nse/masterList";
import { guessFamily, masterListCommand, runMasterList, toMasterListUpserts } from "../src/pipelines/masterList";
import { cleanupScope, connectTestDb } from "./support/db";
import { fakeContext, outage, readSourcesFixture } from "./support/fakes";
import { scope, setScope } from "./support/scope";

vi.mock("@finn/db/repositories/sourceHealth", async (orig) => (await import("./support/scope")).scopeSourceHealth(await orig()));

setScope("ZTDM");
const S = (s: string) => `${scope.symbol}${s}`;

describe("master list transforms", () => {
  it.each([
    ["HDFC Bank Limited", "banking"],
    ["State Bank of India", "banking"],
    ["Bank of Baroda", "banking"],
    ["JM Financial Investment Bank Ltd", "industrial"],
    ["Merchant Bank Services", "industrial"],
    ["Bankruptcy Advisors Ltd", "industrial"],
    ["Tata Consultancy Services Limited", "industrial"],
  ] as const)("guessFamily(%s) = %s", (name, family) => {
    expect(guessFamily(name)).toBe(family);
  });

  it("keeps EQ/BE/BZ series only, normalises symbol and series, drops blanks and later duplicates", () => {
    const e = (symbol: string, series: string, name = `${symbol} Ltd`, isin = `INE${symbol}`) => ({ symbol, name, series, isin, listedOn: null, faceValue: 10 });
    expect(
      toMasterListUpserts([
        e(" abc ", " eq ", "  ABC Bank Ltd  "),
        e("ABC", "BE", "ABC duplicate"),
        e("DEF", "bz"),
        e("GHI", "SM"),
        e("JKL", "ST"),
        e("   ", "EQ"),
        e("MNO", "BE", "MNO Ltd", ""),
      ]),
    ).toEqual([
      { symbol: "ABC", name: "ABC Bank Ltd", isin: "INE abc ", series: "EQ", statementFamily: "banking" },
      { symbol: "DEF", name: "DEF Ltd", isin: "INEDEF", series: "BZ", statementFamily: "industrial" },
      { symbol: "MNO", name: "MNO Ltd", isin: null, series: "BE", statementFamily: "industrial" },
    ]);
  });
});

/** The first rows of the real EQUITY_L.csv, re-keyed to this file's prefix, plus crafted edge rows. */
function masterCsv(opts: { isinSuffix?: string } = {}) {
  const [header, ...lines] = readSourcesFixture("EQUITY_L.csv").trim().split(/\r?\n/);
  const real = lines.slice(0, 12).map((line) => {
    const cols = line.split(",");
    cols[0] = S(cols[0]!);
    cols[6] = `ZTDM${cols[6]!.slice(4)}${opts.isinSuffix ?? ""}`;
    return cols.join(",");
  });
  const crafted = [
    `${S("SMEONE")},ZTD SME One Limited,SM,01-JAN-2024,10,1,ZTDMSME00001,10`,
    `${S("NOISIN")},ZTD No Isin Limited,EQ,01-JAN-2024,10,1,,10`,
    `${S("BANKX")},ZTD Cooperative Bank Limited,EQ,01-JAN-2024,10,1,ZTDMBANK0001${opts.isinSuffix ?? ""},10`,
    `${S("BANKX")},ZTD Duplicate Row Limited,BE,01-JAN-2024,10,1,ZTDMBANK0002,10`,
  ];
  return { csv: [header, ...real, ...crafted].join("\n"), eligible: real.length + 1, fetched: real.length + 3 };
}

const sql = (await connectTestDb()) as Sql;

describe.skipIf(sql === null)("runMasterList against the local database", () => {
  const { ctx, http, log } = fakeContext(sql);
  const rows = () =>
    sql<{ symbol: string; name: string; isin: string | null; series: string; statement_family: string }[]>`
      SELECT symbol, name, isin, series, statement_family FROM companies WHERE symbol LIKE ${`${scope.symbol}%`} ORDER BY symbol`;

  beforeAll(() => cleanupScope(sql, scope));
  afterAll(async () => {
    await cleanupScope(sql, scope);
    await sql.end({ timeout: 5 });
  });

  it("upserts eligible equities, records health, and a re-run writes nothing", async () => {
    const { csv, eligible, fetched } = masterCsv();
    http.route(MASTER_LIST_URL, csv);

    const first = await runMasterList(ctx);
    expect(first).toMatchObject({ fetched, eligible, written: eligible });
    expect(first.total).toBeGreaterThanOrEqual(eligible);
    const stored = await rows();
    expect(stored).toHaveLength(eligible);
    expect(stored.map((r) => r.symbol)).not.toContain(S("SMEONE"));
    expect(stored.map((r) => r.symbol)).not.toContain(S("NOISIN"));
    expect(stored.find((r) => r.symbol === S("BANKX"))).toEqual({
      symbol: S("BANKX"),
      name: "ZTD Cooperative Bank Limited",
      isin: "ZTDMBANK0001",
      series: "EQ",
      statement_family: "banking",
    });
    expect(stored.find((r) => r.symbol === S("20MICRONS"))).toMatchObject({ name: "20 Microns Limited", series: "EQ", statement_family: "industrial" });
    expect(await sourceHealthRepo(sql).get("nse_master_list")).toMatchObject({ consecutiveFailures: 0, lastError: null, recordsLastRun: eligible });

    expect(await runMasterList(ctx)).toMatchObject({ fetched, eligible, written: 0 });
    expect(await rows()).toEqual(stored);
  });

  it("updates ISIN/series changes but never overwrites a learned statement family or the name", async () => {
    await sql`UPDATE companies SET statement_family = 'nbfc', name = 'Renamed by user' WHERE symbol = ${S("BANKX")}`;
    http.route(MASTER_LIST_URL, masterCsv({ isinSuffix: "9" }).csv);
    const { written, eligible } = await runMasterList(ctx);
    expect(written).toBe(eligible);
    expect((await rows()).find((r) => r.symbol === S("BANKX"))).toMatchObject({ isin: "ZTDMBANK00019", statement_family: "nbfc", name: "Renamed by user" });
  });

  it("records a failure and rethrows on outage or an empty file; companies are untouched", async () => {
    const before = await rows();
    http.route(MASTER_LIST_URL, outage(503));
    await expect(runMasterList(ctx)).rejects.toThrow(/HTTP 503/);
    expect(await sourceHealthRepo(sql).get("nse_master_list")).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringMatching(/HTTP 503/) });

    http.route(MASTER_LIST_URL, "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\n");
    await expect(runMasterList(ctx)).rejects.toThrow("NSE master list parsed to zero rows");
    expect(await sourceHealthRepo(sql).get("nse_master_list")).toMatchObject({ consecutiveFailures: 2, lastError: "NSE master list parsed to zero rows", recordsLastRun: masterCsv().eligible });
    expect(await rows()).toEqual(before);
  });

  it("master-list command logs the summary", async () => {
    http.route(MASTER_LIST_URL, masterCsv({ isinSuffix: "9" }).csv);
    expect(masterListCommand.name).toBe("master-list");
    await masterListCommand.run(ctx, { _: [] });
    const entry = log.entries.find((e) => e.msg === "Master list loaded");
    expect(entry?.obj).toMatchObject({ written: 0 });
  });
});
