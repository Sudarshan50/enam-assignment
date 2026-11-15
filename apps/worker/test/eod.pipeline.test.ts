import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@finn/db";
import { alertsRepo } from "@finn/db/repositories/alerts";
import { announcementsRepo } from "@finn/db/repositories/announcements";
import { pricesRepo } from "@finn/db/repositories/prices";
import { sourceHealthRepo } from "@finn/db/repositories/sourceHealth";
import { bhavcopyUrl } from "@finn/sources/nse/bhavcopy";
import { yahooChartUrl } from "@finn/sources/yahoo/chart";
import { alertsCommand, runPriceAlerts } from "../src/pipelines/alerts";
import { BHAVCOPY_SOURCE, backfillPrices, backfillPricesCommand, eodCommand, runEod, YAHOO_SOURCE } from "../src/pipelines/eod";
import { istNoon } from "../src/time";
import { cleanupScope, connectTestDb, insertCompany } from "./support/db";
import { fakeContext, outage, readSourcesFixtureBytes } from "./support/fakes";
import { scope, setScope } from "./support/scope";

vi.mock("@finn/db/repositories/companies", async (orig) => (await import("./support/scope")).scopeCompanies(await orig()));
vi.mock("@finn/db/repositories/announcements", async (orig) => (await import("./support/scope")).scopeAnnouncements(await orig()));
vi.mock("@finn/db/repositories/prices", async (orig) => (await import("./support/scope")).scopePrices(await orig()));
vi.mock("@finn/db/repositories/alerts", async (orig) => (await import("./support/scope")).scopeAlerts(await orig()));
vi.mock("@finn/db/repositories/push", async (orig) => (await import("./support/scope")).scopePush(await orig()));
vi.mock("@finn/db/repositories/sourceHealth", async (orig) => (await import("./support/scope")).scopeSourceHealth(await orig()));

setScope("ZTDE");
const P = scope.symbol;
const S = (name: string) => `${P}${name}`;

const fixtureCsv = strFromU8(Object.values(unzipSync(readSourcesFixtureBytes("bhavcopy_20261113.csv.zip")))[0]!);
const [header, ...body] = fixtureCsv.split(/\r?\n/).filter(Boolean);
const COL = Object.fromEntries(header!.split(",").map((name, i) => [name, i])) as Record<string, number>;
const RENAMED: Record<string, string> = { CDSL: S("CDSL"), INFY: S("INFY"), TCS: S("TCS") };
const tcsLine = body.find((l) => l.split(",")[COL.TckrSymb!] === "TCS" && l.split(",")[COL.SctySrs!] === "EQ")!;

function synthetic(symbol: string, close: number, prevClose: number, volume: number, series = "EQ"): string {
  const f = tcsLine.split(",");
  f[COL.TckrSymb!] = symbol;
  f[COL.SctySrs!] = series;
  for (const k of ["OpnPric", "HghPric", "LwPric", "ClsPric", "LastPric"]) f[COL[k]!] = String(close);
  f[COL.PrvsClsgPric!] = String(prevClose);
  f[COL.TtlTradgVol!] = String(volume);
  return f.join(",");
}

/** The fixture with three tickers re-keyed onto ZTDE plus crafted rows; TradDt rewritten for other sessions. */
function bhavZip(tradDt = "2026-11-13"): Uint8Array {
  const lines = body.map((l) => {
    const f = l.split(",");
    const renamed = RENAMED[f[COL.TckrSymb!]!];
    if (renamed) f[COL.TckrSymb!] = renamed;
    return f.join(",");
  });
  lines.push(
    synthetic(S("TCS"), 9999, 1, 1, "BE"), // EQ must win over BE
    synthetic(S("DOWN5"), 2.85, 3, 1000), // exactly -5.00%, computes as -4.999999999999993
    synthetic(S("SPLIT"), 50, 100, 100_000), // -50% and 1000× volume, but a bonus was filed
    synthetic(S("SPIKE"), 100, 100, 9000), // exactly 3× its 20-session average
    synthetic(S("NOAVG"), 100, 100, 1_000_000), // only 5 sessions of history
    synthetic(S("UNTRACKED"), 10, 5, 1000),
  );
  const csv = [header ?? "", ...lines].map((l) => l.replace(/^2026-11-13,2026-11-13,/, `${tradDt},${tradDt},`)).join("\n");
  return zipSync({ [`BhavCopy_NSE_CM_0_0_0_${tradDt.replace(/-/g, "")}_F_0000.csv`]: strToU8(csv) });
}

const bhavRoute = (date: string) => bhavcopyUrl(istNoon(date));
const TRACKED = ["CDSL", "INFY", "TCS", "DOWN5", "SPLIT", "SPIKE", "NOAVG"].map(S);

function yahooChart(sessionDate: string, close: number, prevClose: number, volume: number) {
  const ts = Math.floor(new Date(`${sessionDate}T09:15:00+05:30`).getTime() / 1000);
  return { chart: { result: [{ meta: { chartPreviousClose: prevClose }, timestamp: [ts], indicators: { quote: [{ open: [close], high: [close], low: [close], close: [close], volume: [volume] }] } }], error: null } };
}

/** Weekdays strictly before `iso`, most recent first. */
function weekdaysBefore(iso: string, n: number): string[] {
  const out: string[] = [];
  for (let d = new Date(`${iso}T00:00:00Z`); out.length < n; ) {
    d = new Date(d.getTime() - 86_400_000);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const sql = (await connectTestDb()) as Sql;

describe.skipIf(sql === null)("EOD prices and price alerts against the local database", () => {
  const { ctx, http, log } = fakeContext(sql);
  const health = (source: string) => sourceHealthRepo(sql).get(source);
  const ztdeAlerts = () => sql<{ rule: string; symbol: string; kind: string; event_key: string }[]>`
    SELECT r.name AS rule, a.symbol, a.kind, a.event_key FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
    WHERE a.symbol LIKE ${`${P}%`} ORDER BY r.name, a.symbol, a.event_key`;

  beforeAll(async () => {
    await cleanupScope(sql, scope);
    for (const s of TRACKED) await insertCompany(sql, s, { holding: [S("SPIKE"), S("NOAVG"), S("SPLIT")].includes(s), family: s === S("TCS") ? "banking" : "industrial" });
    await insertCompany(sql, S("UNTRACKED"), { tracked: false });

    const history = (symbol: string, sessions: number, volume: number) =>
      weekdaysBefore("2026-11-13", sessions).map((sessionDate) => ({ symbol, sessionDate, open: 100, high: 100, low: 100, close: 100, prevClose: 100, volume, source: "bhavcopy" as const }));
    await pricesRepo(sql).upsertMany([...history(S("SPIKE"), 20, 3000), ...history(S("SPLIT"), 20, 100), ...history(S("NOAVG"), 5, 100)]);

    const ann = announcementsRepo(sql);
    await ann.upsertRaw([{ seqId: `${scope.seq}-bonus`, symbol: S("SPLIT"), subject: "Bonus", headline: "Bonus issue 1:1", bodyText: null, pdfUrl: null, publishedAt: new Date("2026-11-10T10:00:00Z"), raw: {} }]);
    await ann.saveClassification(`${scope.seq}-bonus`, { category: "bonus_split", confidence: 0.95, source: "rule", reasonCodes: [], score: 45, tier: "know", clusterKey: `${S("SPLIT")}:bonus_split:2026-11-10`, oneLiner: null });

    const rules = alertsRepo(sql);
    await rules.createRule(`${scope.rule}-down5`, { type: "price_move", scope: { kind: "symbols", symbols: [S("DOWN5"), S("SPLIT")] }, direction: "down", thresholdPct: 5 });
    await rules.createRule(`${scope.rule}-vol3`, { type: "volume_spike", scope: { kind: "portfolio" }, multiple: 3 });
    await rules.createRule(`${scope.rule}-banks1`, { type: "price_move", scope: { kind: "statement_family", family: "banking" }, direction: "either", thresholdPct: 1 });
    const off = await rules.createRule(`${scope.rule}-off`, { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 0.5 });
    await rules.updateRule(off.id, { enabled: false });
    await sql`INSERT INTO alert_rules (name, definition) VALUES (${`${scope.rule}-bad`}, ${sql.json({ type: "price_move", thresholdPct: 99 })})`;
  });

  afterAll(async () => {
    await cleanupScope(sql, scope);
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    http.reset();
    http.route(bhavRoute("2026-11-13"), bhavZip());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bhavcopy fixture: stores one EQ row per tracked symbol, computes avg20 and inserts each alert once", async () => {
    const summary = await runEod(ctx, { date: "2026-11-13" });
    expect(summary).toMatchObject({ sessionDate: "2026-11-13", status: "stored", source: "bhavcopy", rowsStored: TRACKED.length, universe: TRACKED.length });

    const rows = await pricesRepo(sql).forSession("2026-11-13");
    expect(rows.map((r) => r.symbol).sort()).toEqual([...TRACKED].sort());
    expect(rows.find((r) => r.symbol === S("TCS"))).toMatchObject({ close: 2407.5, prevClose: 2442.4, volume: 3344738, source: "bhavcopy" });
    expect(rows.find((r) => r.symbol === S("SPIKE"))?.avg20Volume).toBe(3000);
    expect(rows.find((r) => r.symbol === S("NOAVG"))?.avg20Volume).toBeNull();
    expect(await health(BHAVCOPY_SOURCE)).toMatchObject({ consecutiveFailures: 0, recordsLastRun: TRACKED.length });

    expect(summary.alerts).toMatchObject({ sessionDate: "2026-11-13", evaluated: TRACKED.length, drafts: 3, created: 3, push: { configured: false, sent: 0 } });
    expect(await ztdeAlerts()).toEqual([
      { rule: `${scope.rule}-banks1`, symbol: S("TCS"), kind: "price_move", event_key: "2026-11-13" },
      { rule: `${scope.rule}-down5`, symbol: S("DOWN5"), kind: "price_move", event_key: "2026-11-13" },
      { rule: `${scope.rule}-vol3`, symbol: S("SPIKE"), kind: "volume_spike", event_key: "2026-11-13" },
    ]);
    expect(log.messages("warn")).toContain("Skipping alert rule with invalid definition");

    // Re-running the same session is a no-op for alerts.
    const again = await runEod(ctx, { date: "2026-11-13" });
    expect(again.alerts).toMatchObject({ drafts: 3, created: 0 });
    expect(await ztdeAlerts()).toHaveLength(3);
  });

  it("--if-missing skips a session that already has bhavcopy rows", async () => {
    expect(await runEod(ctx, { date: "2026-11-13", ifMissing: true })).toMatchObject({ status: "skipped_existing", rowsStored: 0 });
    expect(http.calls).toEqual([]);
  });

  it("--all widens the universe to every company", async () => {
    const summary = await runEod(ctx, { date: "2026-11-13", all: true, alerts: false });
    expect(summary).toMatchObject({ universe: TRACKED.length + 1, rowsStored: TRACKED.length + 1, alerts: null });
    expect((await pricesRepo(sql).forSession("2026-11-13")).some((r) => r.symbol === S("UNTRACKED"))).toBe(true);
  });

  it("holiday: no bhavcopy file is a successful no-op", async () => {
    const summary = await runEod(ctx, { date: "2026-11-14" });
    expect(summary).toMatchObject({ status: "not_published", rowsStored: 0, source: null, alerts: null });
    expect(await pricesRepo(sql).forSession("2026-11-14")).toEqual([]);
    expect(await health(BHAVCOPY_SOURCE)).toMatchObject({ consecutiveFailures: 0, recordsLastRun: 0 });
  });

  it("bhavcopy outage falls back to Yahoo for tracked symbols", async () => {
    http.route(bhavRoute("2026-11-16"), outage(503));
    for (const s of TRACKED.filter((x) => x !== S("INFY"))) http.route(yahooChartUrl(s, "5d"), yahooChart("2026-11-16", 2.85, 3, 500));
    http.route(yahooChartUrl(S("INFY"), "5d"), outage(500));

    const summary = await runEod(ctx, { date: "2026-11-16" });
    expect(summary).toMatchObject({ status: "stored", source: "yahoo", rowsStored: TRACKED.length - 1 });
    const rows = await pricesRepo(sql).forSession("2026-11-16");
    expect(rows.every((r) => r.source === "yahoo" && r.close === 2.85 && r.prevClose === 3)).toBe(true);
    expect(rows.some((r) => r.symbol === S("INFY"))).toBe(false);
    expect(await health(BHAVCOPY_SOURCE)).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringMatching(/503/) });
    expect(await health(YAHOO_SOURCE)).toMatchObject({ consecutiveFailures: 0, recordsLastRun: TRACKED.length - 1 });
    expect(log.messages("warn")).toContain("Yahoo fallback failed for symbol");
    expect(http.calls.some((u) => u.includes("UNTRACKED"))).toBe(false);
  });

  it("bhavcopy and Yahoo both failing throws and marks both sources", async () => {
    http.route(bhavRoute("2026-11-17"), outage(503));
    for (const s of TRACKED) http.route(yahooChartUrl(s, "5d"), yahooChart("2026-11-16", 10, 10, 1));
    await expect(runEod(ctx, { date: "2026-11-17", all: true })).rejects.toThrow(/No prices for 2026-11-17: bhavcopy failed/);
    expect(await health(YAHOO_SOURCE)).toMatchObject({ consecutiveFailures: 1, lastError: "No Yahoo rows for 2026-11-17" });
    expect((await health(BHAVCOPY_SOURCE))?.consecutiveFailures).toBe(2);
  });

  it("backfill walks back over weekdays, skips holidays and stored sessions, and counts failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T12:00:00+05:30"));
    http.route(bhavRoute("2026-11-19"), bhavZip("2026-11-19"));
    http.route(bhavRoute("2026-11-18"), outage(503));
    http.route(bhavRoute("2026-11-17"), bhavZip("2026-11-17"));

    const summary = await backfillPrices(ctx, { days: 3 });
    expect(summary).toEqual({ sessions: 3, rows: TRACKED.length * 2, failures: 1 });
    // 13 Nov was already complete, so it was never downloaded.
    expect(http.calls.some((u) => u.includes("20261113"))).toBe(false);
    expect(http.calls.some((u) => u.includes("20261115") || u.includes("20261114"))).toBe(false);
    expect((await pricesRepo(sql).forSession("2026-11-19")).map((r) => r.symbol).sort()).toEqual([...TRACKED].sort());
  });

  it("backfill that stores nothing and only fails throws", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-10T12:00:00+05:30"));
    http.route(/BhavCopy_NSE_CM_0_0_0_2027/, outage(503));
    await expect(backfillPrices(ctx, { days: 1 })).rejects.toThrow(/backfill-prices stored nothing \(\d+ failures\)/);
  });

  it("price alerts: re-evaluation, latest session default, empty scope and push opt-out", async () => {
    await alertsCommand.run(ctx, { _: [], date: "2026-11-13" });
    expect(log.messages("info")).toContain("Alerts evaluated");
    // 13 Nov: three alerts. 16 Nov (Yahoo, every row -5%): DOWN5 and the banking rule on TCS; SPLIT stays suppressed.
    expect((await ztdeAlerts()).map((a) => `${a.rule}:${a.symbol}:${a.event_key}`)).toEqual([
      `${scope.rule}-banks1:${S("TCS")}:2026-11-13`,
      `${scope.rule}-banks1:${S("TCS")}:2026-11-16`,
      `${scope.rule}-down5:${S("DOWN5")}:2026-11-13`,
      `${scope.rule}-down5:${S("DOWN5")}:2026-11-16`,
      `${scope.rule}-vol3:${S("SPIKE")}:2026-11-13`,
    ]);

    // Backfill stores prices without alerting; the first evaluation of that session creates them, the next none.
    // The 10 Nov bonus no longer suppresses SPLIT on 19 Nov (outside the 7-day window).
    const latest = await runPriceAlerts(ctx, { push: false });
    expect(latest).toMatchObject({ sessionDate: "2026-11-19", push: null, drafts: 4, created: 4 });
    expect((await ztdeAlerts()).filter((a) => a.event_key === "2026-11-19").map((a) => `${a.rule}:${a.symbol}`)).toEqual([
      `${scope.rule}-banks1:${S("TCS")}`,
      `${scope.rule}-down5:${S("DOWN5")}`,
      `${scope.rule}-down5:${S("SPLIT")}`,
      `${scope.rule}-vol3:${S("SPLIT")}`,
    ]);
    expect(await runPriceAlerts(ctx, { push: false })).toMatchObject({ sessionDate: "2026-11-19", created: 0 });

    const saved = scope.symbol;
    scope.symbol = "ZTDEZZZ";
    try {
      expect(await runPriceAlerts(ctx)).toEqual({ sessionDate: null, evaluated: 0, drafts: 0, created: 0, push: null });
    } finally {
      scope.symbol = saved;
    }
  });

  it("commands parse their flags", async () => {
    await eodCommand.run(ctx, { _: [], date: "2026-11-13", "if-missing": true });
    expect(log.messages("info")).toContain("EOD finished");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T20:00:00+05:30"));
    await backfillPricesCommand.run(ctx, { _: [], days: "1" });
    expect(log.messages("info")).toContain("Price backfill finished");
    await expect(backfillPricesCommand.run(ctx, { _: [], days: "0" })).rejects.toThrow(/positive integer/);
  });
});
