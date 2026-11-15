import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyByRules, needsLlmFallback } from "@finn/domain/classify/rules";
import { pickClusterHead } from "@finn/domain/cluster/clusterKey";
import { scoreAnnouncement } from "@finn/domain/score/score";
import type { Sql } from "@finn/db";
import { alertsRepo } from "@finn/db/repositories/alerts";
import { announcementsRepo, type AnnouncementRow } from "@finn/db/repositories/announcements";
import { sourceHealthRepo } from "@finn/db/repositories/sourceHealth";
import { watermarksRepo } from "@finn/db/repositories/watermarks";
import { nseQueryDate } from "@finn/shared/format";
import { ANNOUNCEMENTS_SOURCE, INTEGRATED_FILINGS_SOURCE, ingestCommand, runIngest } from "../src/pipelines/ingest";
import { MAX_ATTEMPTS } from "../src/pipelines/ingest/process";
import { cleanupScope, connectTestDb, insertCompany } from "./support/db";
import { fakeContext, istDate, nseDay, outage, readSourcesFixture } from "./support/fakes";
import { scope, setScope } from "./support/scope";

vi.mock("@finn/db/repositories/companies", async (orig) => (await import("./support/scope")).scopeCompanies(await orig()));
vi.mock("@finn/db/repositories/announcements", async (orig) => (await import("./support/scope")).scopeAnnouncements(await orig()));
vi.mock("@finn/db/repositories/alerts", async (orig) => (await import("./support/scope")).scopeAlerts(await orig()));
vi.mock("@finn/db/repositories/push", async (orig) => (await import("./support/scope")).scopePush(await orig()));
vi.mock("@finn/db/repositories/sourceHealth", async (orig) => (await import("./support/scope")).scopeSourceHealth(await orig()));
vi.mock("@finn/db/repositories/watermarks", async (orig) => (await import("./support/scope")).scopeWatermarks(await orig()));
vi.mock("@finn/db/repositories/prefs", async (orig) => (await import("./support/scope")).scopePrefs(await orig()));
vi.mock("@finn/sources/pdf/extract", () => ({ extractPdfPages: vi.fn(async () => [{ page: 1, text: "Brief profile of the incoming director." }]) }));

setScope("ZTDI");
const P = scope.symbol;
const p = scope.seq;
const DAY = istDate(-1);

type RawRow = Record<string, unknown> & { seq_id: string; symbol: string; desc: string; attchmntText: string; voiceSummary: string | null; an_dt: string; sort_date: string };
const original = JSON.parse(readSourcesFixture("announcements_2026-11-13.json")) as RawRow[];

/** The real NSE snapshot re-keyed onto this file's prefix and moved to yesterday (IST), times kept. */
const feed: RawRow[] = original.map((r) => ({
  ...r,
  symbol: `${P}${r.symbol}`,
  seq_id: `${p}-${r.seq_id}`,
  an_dt: `${nseDay(DAY)} ${r.an_dt.slice(12)}`,
  sort_date: `${DAY} ${r.sort_date.slice(11)}`,
}));
const extra = (seq: string, symbol: string, desc: string, text: string, time = "15:00:00"): RawRow => ({
  ...feed[0]!,
  seq_id: `${p}-${seq}`,
  symbol: `${P}${symbol}`,
  desc,
  attchmntText: text,
  voiceSummary: null,
  attchmntFile: "-",
  an_dt: `${nseDay(DAY)} ${time}`,
  sort_date: `${DAY} ${time}`,
});

const UNTRACKED_NO_COMPANY = `${P}RELIANCE`;
const UNTRACKED_COMPANY = `${P}TRENT`;
const HOLDINGS = [`${P}HDFCBANK`, `${P}SARVESHWAR`, `${P}INDOMIM`];
const PDF_URL = original.find((r) => r.symbol === "HDFCBANK")!.attchmntFile as string;
const ANN_ROUTE = "https://www.nseindia.in/api/corporate-announcements?";
const IFR_ROUTE = "https://www.nseindia.in/api/integrated-filing-results?";

const sql = (await connectTestDb()) as Sql;
const reachable = sql !== null;

const mine = async (): Promise<AnnouncementRow[]> => {
  const rows = await sql<{ seq_id: string }[]>`SELECT seq_id FROM announcements WHERE seq_id LIKE ${`${p}-%`}`;
  const repo = announcementsRepo(sql);
  return (await Promise.all(rows.map((r) => repo.get(r.seq_id)))).filter((r): r is AnnouncementRow => r !== null);
};
const row = async (seq: string) => (await announcementsRepo(sql).get(`${p}-${seq}`))!;

describe.skipIf(!reachable)("ingest pipeline against the local database", () => {
  const env = fakeContext(sql);
  const { ctx, http, classifier, enricher, log } = env;

  beforeAll(async () => {
    await cleanupScope(sql, scope);
    const symbols = [...new Set(feed.map((r) => r.symbol))].filter((s) => s !== UNTRACKED_NO_COMPANY && s !== UNTRACKED_COMPANY);
    for (const s of symbols) await insertCompany(sql, s, { holding: HOLDINGS.includes(s) });
    await insertCompany(sql, UNTRACKED_COMPANY, { tracked: false });
    await insertCompany(sql, `${P}VTL`);
    await insertCompany(sql, `${P}NEWBUCKET`);
    await alertsRepo(sql).createRule(`${scope.rule}-material`, { type: "category", scope: { kind: "portfolio" }, categories: ["management_change", "m_and_a"] });
    scope.weights = { dividend: 0.5 };
  });

  afterAll(async () => {
    await cleanupScope(sql, scope);
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    http.reset();
    http.route(ANN_ROUTE, { data: feed });
    http.route(IFR_ROUTE, { data: [] });
    http.route(PDF_URL, new Uint8Array([37, 80, 68, 70]));
    classifier.impl = (input) => ({
      category: /results/i.test(input.text) ? "results" : "press_release",
      impact: 1.2,
      confidence: 0.85,
      oneLiner: `LLM: ${input.subject}`,
      reasonCodes: ["fake"],
    });
    enricher.impl = undefined;
  });

  it("first poll: inserts tracked rows, classifies, scores, clusters, attaches cards, marks ready and advances the watermark", async () => {
    const before = Date.now();
    const summary = await runIngest(ctx);
    const after = Date.now();

    const tracked = feed.filter((r) => r.symbol !== UNTRACKED_NO_COMPANY && r.symbol !== UNTRACKED_COMPANY);
    expect(summary).toMatchObject({ windows: 1, fetched: 65, relevant: tracked.length, inserted: tracked.length, processed: tracked.length, ready: tracked.length, failed: 0, fetchError: null });
    expect(http.calls.filter((u) => u.startsWith(ANN_ROUTE))).toHaveLength(1);

    const rows = await mine();
    expect(rows.map((r) => r.seqId).sort()).toEqual(tracked.map((r) => r.seq_id).sort());
    for (const r of rows) {
      const src = feed.find((f) => f.seq_id === r.seqId)!;
      const rule = classifyByRules({ subject: src.desc, text: src.attchmntText, exchangeSummary: src.voiceSummary });
      const usedLlm = needsLlmFallback(rule);
      const category = usedLlm ? (/results/i.test(src.attchmntText) ? "results" : "press_release") : rule.category;
      expect(r.status, r.seqId).toBe("ready");
      expect(r.category, r.seqId).toBe(category);
      expect(r.categorySource, r.seqId).toBe(usedLlm ? "llm_text" : "rule");
      expect(r.attempts).toBe(1);
      const expected = scoreAnnouncement({ category, userWeight: scope.weights[category] ?? null, impact: usedLlm ? 1.2 : null, pinned: rule.pinned });
      expect(r.score, r.seqId).toBeCloseTo(expected.score, 4);
      expect(r.tier, r.seqId).toBe(expected.tier);
      if (rule.pinned) expect(r.tier).toBe("act");
      expect(r.clusterKey).toMatch(new RegExp(`^${r.symbol}:${category}:\\d{4}-\\d{2}-\\d{2}$`));
      if (category === "results") {
        expect(r.card).toMatchObject({ kind: "results", status: "not_filed_yet" });
      } else {
        expect(r.card?.kind).toBe("generic");
        expect(r.error).toBeNull();
      }
    }

    // User weights flow into the score: dividends are halved into noise.
    const dividend = rows.find((r) => r.category === "dividend")!;
    expect(dividend).toMatchObject({ score: 20, tier: "noise" });

    // Enriched categories went through the enricher; the one attachment we serve reached it as text.
    const enrichedSeqs = new Set(enricher.calls.map((c) => c.seqId));
    expect(rows.filter((r) => r.card?.kind === "generic" && (r.card as { oneLiner: string | null }).oneLiner?.startsWith("enriched")).map((r) => r.seqId).sort()).toEqual([...enrichedSeqs].sort());
    const hdfc = enricher.calls.find((c) => c.symbol === `${P}HDFCBANK`)!;
    expect(hdfc.attachmentText).toContain("[page 1]");
    expect(hdfc.attachmentText).toContain("Brief profile");
    expect(enricher.calls.filter((c) => c.symbol !== `${P}HDFCBANK`).every((c) => c.attachmentText === null)).toBe(true);
    expect(enricher.calls.some((c) => c.category === "results")).toBe(false);

    // Every touched cluster has exactly one head: the member pickClusterHead chooses.
    const byCluster = new Map<string, AnnouncementRow[]>();
    for (const r of rows) byCluster.set(r.clusterKey!, [...(byCluster.get(r.clusterKey!) ?? []), r]);
    expect(summary.clusters).toBe(byCluster.size);
    for (const [key, members] of byCluster) {
      const heads = members.filter((m) => m.parentSeqId === null);
      expect(heads, key).toHaveLength(1);
      expect(heads[0]!.seqId).toBe(pickClusterHead(members)!.seqId);
      for (const m of members) if (m !== heads[0]) expect(m.parentSeqId).toBe(heads[0]!.seqId);
    }
    expect([...byCluster.values()].some((m) => m.length > 1)).toBe(true);

    // Results clusters asked the integrated-filing index and got the not-filed-yet placeholder.
    const resultClusters = new Set(rows.filter((r) => r.category === "results").map((r) => r.clusterKey));
    expect(summary.results).toHaveLength(resultClusters.size);
    expect(summary.results.every((r) => r.outcome === "not_filed_yet")).toBe(true);
    expect((await sourceHealthRepo(sql).get(INTEGRATED_FILINGS_SOURCE))?.consecutiveFailures).toBe(0);

    // Category alerts: one per matching cluster for holdings only.
    const holdingsHits = new Set(rows.filter((r) => HOLDINGS.includes(r.symbol) && ["management_change", "m_and_a"].includes(r.category!)).map((r) => r.clusterKey));
    expect(summary.alertsCreated).toBe(holdingsHits.size);
    expect(summary.alertsCreated).toBeGreaterThan(0);
    expect(summary.pushesSent).toBe(0);

    // Bookkeeping lands on the prefixed source rows only (the repositories are scoped in this file).
    const [raw] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ingestion_watermarks WHERE source = ${`${scope.source}${ANNOUNCEMENTS_SOURCE}`}`;
    expect(raw?.n).toBe(1);
    const wm = await watermarksRepo(sql).get(ANNOUNCEMENTS_SOURCE);
    expect(wm!.getTime()).toBeGreaterThanOrEqual(before);
    expect(wm!.getTime()).toBeLessThanOrEqual(after);
    expect(summary.watermark).toBe(wm!.toISOString());
    expect(await sourceHealthRepo(sql).get(ANNOUNCEMENTS_SOURCE)).toMatchObject({ consecutiveFailures: 0, lastError: null, recordsLastRun: tracked.length });
  });

  it("re-run: fetches from watermark minus overlap, inserts 0 rows and creates no duplicate alerts", async () => {
    const wm = await watermarksRepo(sql).get(ANNOUNCEMENTS_SOURCE);
    const summary = await runIngest(ctx);
    expect(summary).toMatchObject({ fetched: 65, inserted: 0, processed: 0, alertsCreated: 0, fetchError: null });
    const url = new URL(http.calls.find((u) => u.startsWith(ANN_ROUTE))!);
    expect(url.searchParams.get("from_date")).toBe(nseQueryDate(new Date(wm!.getTime() - 30 * 60 * 1000)));
    expect(new Date(summary.watermark!).getTime()).toBeGreaterThanOrEqual(wm!.getTime());
    // Results still waiting for XBRL are retried from the awaiting list.
    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.results.every((r) => r.outcome === "not_filed_yet")).toBe(true);
  });

  it("NSE outage: records the failure, keeps the watermark, and the next poll catches up", async () => {
    const health = () => sourceHealthRepo(sql).get(ANNOUNCEMENTS_SOURCE);
    const wmBefore = await watermarksRepo(sql).get(ANNOUNCEMENTS_SOURCE);

    http.route(ANN_ROUTE, outage(503));
    const down = await runIngest(ctx);
    expect(down.fetchError).toMatch(/HTTP 503/);
    expect(down.watermark).toBeNull();
    expect(down.inserted).toBe(0);
    expect(await health()).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringMatching(/503/) });

    // An HTML/JSON error page is a failure too, never "no news".
    http.route(ANN_ROUTE, { message: "Resource not found" });
    expect((await runIngest(ctx)).fetchError).toMatch(/Unexpected announcements payload/);
    expect((await health())?.consecutiveFailures).toBe(2);
    await expect(ingestCommand.run(ctx, { _: [] })).rejects.toThrow(/Announcements fetch failed/);
    expect((await health())?.consecutiveFailures).toBe(3);
    expect((await watermarksRepo(sql).get(ANNOUNCEMENTS_SOURCE))?.getTime()).toBe(wmBefore!.getTime());
    expect(log.messages("error")).toContain("Announcements fetch failed; watermark not advanced");

    // Recovery: a filing published during the outage is picked up.
    http.route(ANN_ROUTE, { data: [...feed, extra("missed-1", "HDFCBANK", "Credit Rating- Revision", "CRISIL upgraded the rating to AAA")] });
    const up = await runIngest(ctx);
    expect(up).toMatchObject({ inserted: 1, processed: 1, ready: 1, fetchError: null });
    expect(await health()).toMatchObject({ consecutiveFailures: 0, lastError: null });
    expect(new Date(up.watermark!).getTime()).toBeGreaterThan(wmBefore!.getTime());
    expect(await row("missed-1")).toMatchObject({ category: "credit_rating", status: "ready" });
  });

  it("LLM classifier down: rule result kept, row still ready, and it is upgraded once the LLM is back", async () => {
    classifier.impl = () => {
      throw new Error("LLM 503");
    };
    http.route(ANN_ROUTE, {
      data: [...feed, extra("llm-1", "VTL", "Amendment(s)", "Amendment to the code of conduct"), extra("llm-2", "NEWBUCKET", "Brand New Bucket", "Company informs the exchange")],
    });
    const down = await runIngest(ctx);
    expect(down).toMatchObject({ inserted: 2, processed: 2, ready: 2, failed: 0 });
    for (const seq of ["llm-1", "llm-2"]) {
      const r = await row(seq);
      expect(r).toMatchObject({ status: "ready", category: "unclassified", categorySource: "fallback", tier: "noise", attempts: 1 });
      expect(r.reasonCodes).toContain("llm_unavailable");
      expect(r.card).toMatchObject({ kind: "generic" });
    }
    expect(log.messages("warn")).toContain("LLM classifier failed; keeping rule result");

    // LLM back: degraded rows are re-classified on the next poll.
    classifier.impl = () => ({ category: "press_release", impact: 1, confidence: 0.9, oneLiner: "Code of conduct amended", reasonCodes: ["recovered"] });
    const up = await runIngest(ctx);
    expect(up.processed).toBe(2);
    const r = await row("llm-1");
    expect(r).toMatchObject({ categorySource: "llm_text", category: "press_release", oneLiner: "Code of conduct amended", attempts: 2 });
    expect(r.reasonCodes).toContain("llm:recovered");
    expect((await runIngest(ctx)).processed).toBe(0);
  });

  it("enricher failure: generic card now, retried on later polls, capped at MAX_ATTEMPTS", async () => {
    expect(MAX_ATTEMPTS).toBe(3);
    enricher.impl = () => Promise.reject(new Error("enrichment model timeout"));
    http.route(ANN_ROUTE, { data: [...feed, extra("enr-1", "BEL", "Credit Rating", "ICRA reaffirmed the long-term rating")] });
    const callsFor = () => enricher.calls.filter((c) => c.seqId === `${p}-enr-1`).length;

    await runIngest(ctx);
    expect(await row("enr-1")).toMatchObject({ status: "ready", card: { kind: "generic" }, error: "enrichment: enrichment model timeout", attempts: 1 });
    await runIngest(ctx);
    expect(await row("enr-1")).toMatchObject({ status: "ready", error: expect.stringMatching(/^enrichment:/), attempts: 2 });
    await runIngest(ctx);
    expect(await row("enr-1")).toMatchObject({ status: "ready", card: { kind: "generic" }, error: null, attempts: 3 });
    expect(log.messages("warn")).toContain("Enrichment failed on final attempt; keeping generic card");
    await runIngest(ctx);
    expect(callsFor()).toBe(3);
    expect((await row("enr-1")).attempts).toBe(3);
  });

  it("a processing failure marks the row failed with the attempt counted, and the next poll retries it", async () => {
    scope.failSave.add(`${p}-fail-1`);
    http.route(ANN_ROUTE, { data: [...feed, extra("fail-1", "BEL", "Dividend", "Board declared an interim dividend")] });
    const first = await runIngest(ctx);
    expect(first).toMatchObject({ inserted: 1, failed: 1, ready: 0 });
    expect(await row("fail-1")).toMatchObject({ status: "failed", attempts: 1, error: expect.stringMatching(/simulated database failure/) });

    scope.failSave.clear();
    const second = await runIngest(ctx);
    expect(second).toMatchObject({ processed: 1, ready: 1, failed: 0 });
    expect(await row("fail-1")).toMatchObject({ status: "ready", category: "dividend", attempts: 2, error: null });
  });

  it("results lookups that fail are reported per cluster and marked on the integrated-filing source", async () => {
    http.route(IFR_ROUTE, outage(500));
    const summary = await runIngest(ctx);
    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.results.every((r) => r.outcome.startsWith("error: HTTP 500"))).toBe(true);
    expect(await sourceHealthRepo(sql).get(INTEGRATED_FILINGS_SOURCE)).toMatchObject({
      consecutiveFailures: 1,
      lastError: `${summary.results.length}/${summary.results.length} results lookups failed`,
    });
  });

  it("backfill mode fetches one window per IST day and never moves the watermark", async () => {
    const wm = await watermarksRepo(sql).get(ANNOUNCEMENTS_SOURCE);
    const summary = await runIngest(ctx, { from: "2026-11-12", to: "2026-11-13" });
    expect(summary).toMatchObject({ windows: 2, fetched: 130, inserted: 0, watermark: null });
    const params = http.calls.filter((u) => u.startsWith(ANN_ROUTE)).map((u) => new URL(u).searchParams);
    expect(params.map((q) => [q.get("from_date"), q.get("to_date")])).toEqual([
      ["12-11-2026", "12-11-2026"],
      ["13-11-2026", "13-11-2026"],
    ]);
    expect((await watermarksRepo(sql).get(ANNOUNCEMENTS_SOURCE))?.getTime()).toBe(wm!.getTime());

    http.calls.length = 0;
    await ingestCommand.run(ctx, { _: [], from: "2026-11-10", to: "2026-11-10", "max-pending": "5" });
    expect(http.calls.filter((u) => u.startsWith(ANN_ROUTE))).toHaveLength(1);
    await expect(ingestCommand.run(ctx, { _: [], from: "2026-02-30" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("leaves no rows pending and touches nothing outside the ZTDI prefix", async () => {
    expect(await announcementsRepo(sql).listPending({ limit: 1000 })).toEqual([]);
    const [outside] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
      WHERE r.name LIKE ${`${scope.rule}%`} AND a.symbol NOT LIKE ${`${P}%`}`;
    expect(outside?.n).toBe(0);
  });
});
