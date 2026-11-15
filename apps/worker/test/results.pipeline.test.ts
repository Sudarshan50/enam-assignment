import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@finn/db";
import { announcementsRepo } from "@finn/db/repositories/announcements";
import { companiesRepo } from "@finn/db/repositories/companies";
import { filingsRepo } from "@finn/db/repositories/filings";
import type { ResultsCard } from "@finn/shared/contracts/cards";
import { ResultsCardSchema } from "@finn/shared/contracts/cards";
import { integratedFilingsUrl } from "@finn/sources/nse/integratedFilings";
import { UsageError } from "../src/args";
import { placeholderCard, RESULTS_PARSER_VERSION, resultsBackfillCommand, resultsCommand, runResults } from "../src/pipelines/results";
import { cleanupScope, connectTestDb, insertCompany } from "./support/db";
import { fakeContext, outage, readSourcesFixture, readXbrlFixture } from "./support/fakes";
import { scope, setScope } from "./support/scope";

vi.mock("@finn/db/repositories/companies", async (orig) => (await import("./support/scope")).scopeCompanies(await orig()));

setScope("ZTDR");
const SYMBOL = `${scope.symbol}TCS`;
const p = scope.seq;

const tcs = JSON.parse(readSourcesFixture("integrated_TCS.json")) as { data: Record<string, string>[] };
const index = { data: tcs.data.map((r) => ({ ...r, symbol: SYMBOL, seq_Id: `${p}-${r.seq_Id}` })) };
const xbrlUrl = (seq: string) => tcs.data.find((r) => r.seq_Id === seq)!.xbrl!;
const XBRL: Record<string, string> = {
  "200121": "TCS_30-SEP-2026_consolidated.xml",
  "173420": "TCS_30-JUN-2026_consolidated.xml",
  "119003": "TCS_30-SEP-2025_consolidated.xml",
  "150312": "TCS_31-MAR-2026_consolidated.xml",
};

const sql = (await connectTestDb()) as Sql;

describe.skipIf(sql === null)("results pipeline against the local database", () => {
  const { ctx, http, log } = fakeContext(sql);
  const filings = () => filingsRepo(sql);
  const card = async (seq: string) => (await announcementsRepo(sql).get(`${p}-${seq}`))?.card as ResultsCard | null;

  /** A results announcement already classified into the (symbol, period) cluster. */
  async function resultsAnnouncement(seq: string, periodEnd: string, symbol = SYMBOL) {
    const repo = announcementsRepo(sql);
    await repo.upsertRaw([
      {
        seqId: `${p}-${seq}`,
        symbol,
        subject: "Outcome of Board Meeting",
        headline: `Financial results for the quarter ended ${periodEnd}`,
        bodyText: null,
        pdfUrl: null,
        publishedAt: new Date(`${periodEnd}T12:00:00Z`),
        raw: { desc: "Outcome of Board Meeting" },
      },
    ]);
    await repo.saveClassification(`${p}-${seq}`, {
      category: "results",
      confidence: 0.9,
      source: "rule",
      reasonCodes: ["subject:board_outcome"],
      score: 80,
      tier: "act",
      clusterKey: `${symbol}:results:${periodEnd}`,
      oneLiner: null,
    });
  }

  beforeAll(async () => {
    await cleanupScope(sql, scope);
    await insertCompany(sql, SYMBOL, { family: null, holding: true });
    await insertCompany(sql, `${scope.symbol}NOXBRL`, { holding: true });
    await resultsAnnouncement("outcome", "2026-09-30");
    await resultsAnnouncement("pressrel", "2026-09-30");
    await resultsAnnouncement("q3", "2026-12-31");
  });

  afterAll(async () => {
    await cleanupScope(sql, scope);
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    http.reset();
    http.route(integratedFilingsUrl(SYMBOL), index);
    for (const [seq, file] of Object.entries(XBRL)) http.route(xbrlUrl(seq), readXbrlFixture(file));
  });

  it("TCS fixtures: persists filings and facts, attaches a ready card to every filing in the cluster", async () => {
    const summary = await runResults(ctx, { symbol: SYMBOL.toLowerCase(), period: "2026-09-30" });
    expect(summary).toMatchObject({ symbol: SYMBOL, periodEnd: "2026-09-30", outcome: "ready", basis: "consolidated", filingsParsed: 3, announcementsUpdated: 2 });
    expect(summary.factsWritten).toBeGreaterThan(30);

    const current = await filings().get(`${p}-200121`);
    expect(current).toMatchObject({ symbol: SYMBOL, periodEnd: "2026-09-30", periodStart: "2026-07-01", basis: "consolidated", statementFamily: "industrial", audited: true, status: "parsed", error: null, parserVersion: RESULTS_PARSER_VERSION });
    expect(current!.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const seq of ["173420", "119003"]) expect((await filings().get(`${p}-${seq}`))?.status).toBe("parsed");
    expect(await filings().get(`${p}-200120`)).toBeNull(); // standalone is never fetched

    const revenue = (await filings().getFacts(`${p}-200121`, ["OneD", "FourD"])).filter((f) => f.concept === "RevenueFromOperations");
    expect(revenue.map((f) => [f.context, Math.round(f.value / 1e7), f.periodStart, f.periodEnd])).toEqual([
      ["FourD", 145463, "2026-04-01", "2026-09-30"],
      ["OneD", 73188, "2026-07-01", "2026-09-30"],
    ]);
    const instants = await filings().getFacts(`${p}-200121`, ["PY_I"]);
    expect(instants.length).toBeGreaterThan(0);
    expect(instants.every((f) => f.periodEnd === "2026-03-31" && f.periodStart === null)).toBe(true);

    for (const seq of ["outcome", "pressrel"]) {
      const c = (await card(seq))!;
      expect(ResultsCardSchema.parse(c)).toBeTruthy();
      expect(c).toMatchObject({ status: "ready", periodLabel: "Q2 FY27", basis: "consolidated", statementFamily: "industrial" });
      const rev = c.metrics.find((m) => m.key === "revenue")!;
      expect(rev.yoyPct).toBeCloseTo(((73188 - 65799) / 65799) * 100, 6);
      expect(rev.qoqPct).toBeCloseTo(((73188 - 72275) / 72275) * 100, 6);
      expect((await announcementsRepo(sql).get(`${p}-${seq}`))?.status).toBe("ready");
    }
    // The family is learned from the XBRL filename.
    expect((await companiesRepo(sql).get(SYMBOL))?.statementFamily).toBe("industrial");
    // The other quarter's cluster is untouched.
    expect(await card("q3")).toBeNull();
  });

  it("is idempotent: re-running rewrites the same facts and card", async () => {
    const before = await filings().countFacts(`${p}-200121`);
    const cardBefore = await card("outcome");
    const summary = await runResults(ctx, { symbol: SYMBOL });
    expect(summary).toMatchObject({ periodEnd: "2026-09-30", outcome: "ready" });
    expect(await filings().countFacts(`${p}-200121`)).toBe(before);
    expect(await card("outcome")).toEqual(cardBefore);
  });

  it("announcement with no XBRL yet: not_filed_yet placeholder, never numbers", async () => {
    const summary = await runResults(ctx, { symbol: SYMBOL, period: "2026-12-31" });
    expect(summary).toMatchObject({ outcome: "not_filed_yet", filingsParsed: 0, factsWritten: 0, announcementsUpdated: 1 });
    const c = (await card("q3"))!;
    expect(c).toEqual(placeholderCard({ periodEnd: "2026-12-31", status: "not_filed_yet", statementFamily: "industrial" }));
    expect(c.metrics).toEqual([]);
    expect(c.periodLabel).toBe("Q3 FY27");
    expect((await announcementsRepo(sql).get(`${p}-q3`))?.status).toBe("ready");
  });

  it("malformed XBRL: numbers under review, filing marked failed, earlier good facts untouched", async () => {
    const goodFacts = await filings().getFacts(`${p}-200121`);
    http.route(xbrlUrl("200121"), "<xbrl>truncated");
    const summary = await runResults(ctx, { symbol: SYMBOL, period: "2026-09-30" });
    expect(summary).toMatchObject({ outcome: "under_review", factsWritten: 0, announcementsUpdated: 2 });
    expect(await filings().get(`${p}-200121`)).toMatchObject({ status: "failed", error: expect.any(String) });
    expect(await filings().getFacts(`${p}-200121`)).toEqual(goodFacts);
    expect(await card("outcome")).toMatchObject({ status: "under_review", metrics: [], audited: true });
    expect(log.messages("warn")).toContain("XBRL parse failed");

    // The good file comes back: card is ready again.
    http.route(xbrlUrl("200121"), readXbrlFixture(XBRL["200121"]!));
    expect((await runResults(ctx, { symbol: SYMBOL, period: "2026-09-30" })).outcome).toBe("ready");
    expect((await filings().get(`${p}-200121`))?.status).toBe("parsed");
  });

  it("a never-parsed filing that fails to parse is stored as failed with its hash", async () => {
    http.route(xbrlUrl("134548"), "not xml at all");
    const summary = await runResults(ctx, { symbol: SYMBOL, period: "2025-12-31" });
    expect(summary.outcome).toBe("under_review");
    expect(await filings().get(`${p}-134548`)).toMatchObject({ status: "failed", taxonomy: "unknown", periodStart: null, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("current XBRL download failure records a failed filing and propagates", async () => {
    http.route(xbrlUrl("150312"), outage(503));
    await expect(runResults(ctx, { symbol: SYMBOL, period: "2026-03-31" })).rejects.toThrow(/503/);
    expect(await filings().get(`${p}-150312`)).toMatchObject({ status: "failed", sha256: null, error: expect.stringMatching(/503/) });
  });

  it("a missing comparison filing degrades the card instead of failing it", async () => {
    http.route(xbrlUrl("173420"), outage(503));
    const summary = await runResults(ctx, { symbol: SYMBOL, period: "2026-09-30" });
    expect(summary).toMatchObject({ outcome: "ready", filingsParsed: 2 });
    const rev = (await card("outcome"))!.metrics.find((m) => m.key === "revenue")!;
    expect(rev.qoqPct).toBeNull();
    expect(rev.yoyPct).not.toBeNull();
    expect(log.messages("warn")).toContain("Comparison filing unavailable");
  });

  it("no filings at all and no period: nothing to do", async () => {
    http.route(integratedFilingsUrl(SYMBOL), { data: [] });
    expect(await runResults(ctx, { symbol: SYMBOL })).toMatchObject({ outcome: "no_filings", periodEnd: null, basis: null });
  });

  it("unknown symbols are rejected before any network call", async () => {
    await expect(runResults(ctx, { symbol: `${scope.symbol}NOPE` })).rejects.toThrow(/Unknown symbol/);
    expect(http.calls).toEqual([]);
  });

  it("commands: results requires --symbol; results-backfill reports failing holdings", async () => {
    await expect(resultsCommand.run(ctx, { _: [] })).rejects.toThrow(UsageError);
    await resultsCommand.run(ctx, { _: [], symbol: SYMBOL, period: "2026-09-30" });
    expect(log.messages("info")).toContain("Results processed");
    // ZTDRNOXBRL has no integrated-filing index (404), ZTDRTCS succeeds.
    await expect(resultsBackfillCommand.run(ctx, { _: [] })).rejects.toThrow(`results-backfill failed for ${scope.symbol}NOXBRL`);
    expect(http.calls.some((u) => u === integratedFilingsUrl(SYMBOL))).toBe(true);
  });
});
