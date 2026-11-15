import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "../src/client";
import { alertsRepo } from "../src/repositories/alerts";
import { announcementsRepo, type NewAnnouncement } from "../src/repositories/announcements";
import { companiesRepo } from "../src/repositories/companies";
import { filingsRepo } from "../src/repositories/filings";
import { prefsRepo } from "../src/repositories/prefs";
import { pricesRepo } from "../src/repositories/prices";
import { pushRepo } from "../src/repositories/push";
import { sourceHealthRepo } from "../src/repositories/sourceHealth";
import { watermarksRepo } from "../src/repositories/watermarks";

const url = process.env.DATABASE_URL ?? "postgres://finn:finn@localhost:54329/finn";
const sql: Sql = postgres(url, { max: 2, prepare: false, onnotice: () => {}, connect_timeout: 3, types: { bigint: postgres.BigInt } });
const reachable = await sql`SELECT 1`.then(
  () => true,
  () => false,
);

const SYMBOL = "ZZFINNTEST";
const SOURCE = "zz_test_source";
const SEQ = "zz-test-seq-1";
const ENDPOINT = "https://push.example.test/zz-endpoint";

const announcement = (overrides: Partial<NewAnnouncement> = {}): NewAnnouncement => ({
  seqId: SEQ,
  symbol: SYMBOL,
  subject: "Credit Rating- Revision",
  headline: "ZZ Test Ltd has informed the Exchange about Credit Rating- Revision",
  bodyText: "India Ratings upgraded the long-term rating to IND AA.",
  pdfUrl: "https://nsearchives.nseindia.com/corporate/zz.pdf",
  publishedAt: new Date("2026-11-13T10:00:00Z"),
  raw: { seq_id: SEQ, symbol: SYMBOL, desc: "Credit Rating- Revision" },
  ...overrides,
});

async function cleanup() {
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${ENDPOINT}`;
  await sql`DELETE FROM alert_rules WHERE name LIKE 'zz-test-%'`;
  await sql`DELETE FROM prices_eod WHERE symbol = ${SYMBOL}`;
  await sql`DELETE FROM source_health WHERE source = ${SOURCE}`;
  await sql`DELETE FROM ingestion_watermarks WHERE source = ${SOURCE}`;
  await sql`DELETE FROM companies WHERE symbol IN (${SYMBOL}, 'ZZNEWCO')`;
}

describe.skipIf(!reachable)("repositories against the local database", () => {
  beforeAll(async () => {
    await cleanup();
    await sql`INSERT INTO companies (symbol, name, statement_family, sector) VALUES (${SYMBOL}, 'ZZ Test Ltd', 'industrial', 'Test')`;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("announcements: upserting the same filing twice leaves one row", async () => {
    const repo = announcementsRepo(sql);
    expect(await repo.upsertRaw([announcement()])).toEqual([SEQ]);
    expect(await repo.upsertRaw([announcement()])).toEqual([]);
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM announcements WHERE seq_id = ${SEQ}`;
    expect(count?.n).toBe(1);

    const row = await repo.get(SEQ);
    expect(row?.subject).toBe("Credit Rating- Revision");
    expect(row?.status).toBe("raw");
    expect(row?.companyName).toBe("ZZ Test Ltd");
  });

  it("announcements: classification, clustering and the pending queue", async () => {
    const repo = announcementsRepo(sql);
    expect((await repo.listPending({ limit: 1000 })).some((r) => r.seqId === SEQ)).toBe(true);
    await repo.upsertRaw([announcement({ seqId: "zz-test-seq-2", raw: { seq_id: "zz-test-seq-2", desc: "Credit Rating- Revision" } })]);
    const key = `${SYMBOL}:credit_rating:2026-11-13`;
    for (const [seqId, score] of [[SEQ, 60], ["zz-test-seq-2", 55]] as const) {
      await repo.saveClassification(seqId, {
        category: "credit_rating",
        confidence: 0.95,
        source: "rule",
        reasonCodes: ["subject:credit_rating"],
        score,
        tier: "know",
        clusterKey: key,
        oneLiner: null,
      });
      await repo.saveCard(seqId, { kind: "generic", oneLiner: "Upgraded" }, "ready");
    }
    const members = await repo.listClusterMembers(key);
    expect(members).toHaveLength(2);
    await repo.setClusterHead(key, SEQ);
    const heads = await repo.listReadyHeads({ from: new Date("2026-11-13T00:00:00Z"), to: new Date("2026-11-14T00:00:00Z") });
    expect(heads.filter((h) => h.symbol === SYMBOL).map((h) => h.seqId)).toEqual([SEQ]);
    expect((await repo.listChildren([SEQ])).map((c) => c.seqId)).toEqual(["zz-test-seq-2"]);
    expect((await repo.listPending({ limit: 1000 })).some((r) => r.seqId === SEQ)).toBe(false);
    expect((await repo.get(SEQ))?.attempts).toBe(1);
  });

  it("announcements: results cards attach by cluster", async () => {
    const repo = announcementsRepo(sql);
    await repo.upsertRaw([announcement({ seqId: "zz-test-res", subject: "Integrated Filing- Financial", raw: { desc: "Integrated Filing- Financial" } })]);
    const key = `${SYMBOL}:results:2026-09-30`;
    await repo.saveClassification("zz-test-res", { category: "results", confidence: 0.95, source: "rule", reasonCodes: [], score: 80, tier: "act", clusterKey: key, oneLiner: null });
    expect((await repo.listResultsAwaitingXbrl(10000)).some((r) => r.clusterKey === key)).toBe(true);
    const updated = await repo.attachResultsCard(key, {
      kind: "results",
      periodEnd: "2026-09-30",
      periodLabel: "Q2 FY27",
      basis: "consolidated",
      statementFamily: "industrial",
      audited: false,
      status: "not_filed_yet",
      metrics: [],
      marginBps: null,
      read: null,
      ebitdaDefinition: null,
    });
    expect(updated).toBe(1);
    expect((await repo.listResultsAwaitingXbrl(10000)).some((r) => r.clusterKey === key)).toBe(true);
    expect((await repo.get("zz-test-res"))?.status).toBe("ready");
  });

  it("source health counts consecutive failures and resets on success", async () => {
    const repo = sourceHealthRepo(sql);
    expect(await repo.recordFailure(SOURCE, "boom")).toBe(1);
    expect(await repo.recordFailure(SOURCE, "boom again")).toBe(2);
    await repo.recordSuccess(SOURCE, 7);
    const row = await repo.get(SOURCE);
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.recordsLastRun).toBe(7);
  });

  it("watermarks only move forward", async () => {
    const repo = watermarksRepo(sql);
    const t1 = new Date("2026-11-13T10:00:00Z");
    await repo.advance(SOURCE, t1);
    await repo.advance(SOURCE, new Date("2026-11-12T10:00:00Z"));
    expect((await repo.get(SOURCE))?.toISOString()).toBe(t1.toISOString());
  });

  it("prices: idempotent upsert and avg20 over the previous 20 sessions only", async () => {
    const repo = pricesRepo(sql);
    const rows = Array.from({ length: 22 }, (_, i) => ({
      symbol: SYMBOL,
      sessionDate: `2026-10-${String(i + 1).padStart(2, "0")}`,
      open: 100,
      high: 101,
      low: 99,
      close: 100 + i,
      prevClose: 99 + i,
      volume: (i + 1) * 100,
      source: "bhavcopy" as const,
    }));
    await repo.upsertMany(rows);
    await repo.upsertMany(rows);
    await repo.recomputeAvg20();
    const history = await repo.history(SYMBOL, 100);
    expect(history).toHaveLength(22);
    expect(history[19]!.avg20Volume).toBeNull();
    // Session 21 averages sessions 1..20: (100 + ... + 2000) / 20 = 1050.
    expect(history[20]!.avg20Volume).toBe(1050);
    expect(history[21]!.avg20Volume).toBe(1150);
    expect(history[21]!.close).toBe(121);

    await repo.upsertMany([{ ...rows[21]!, close: 1, source: "yahoo" }]);
    expect((await repo.history(SYMBOL, 1))[0]!.close).toBe(121);
  });

  it("alerts: the unique key makes inserts idempotent", async () => {
    const repo = alertsRepo(sql);
    const rule = await repo.createRule("zz-test-rule", { type: "price_move", scope: { kind: "symbols", symbols: [SYMBOL] }, direction: "either", thresholdPct: 3 });
    const draft = { ruleId: rule.id, symbol: SYMBOL, kind: "price_move" as const, eventKey: "2026-10-22", title: "t", body: "b", sessionDate: "2026-10-22", announcementSeqId: null };
    const created = await repo.insertMany([draft]);
    expect(created).toHaveLength(1);
    expect(await repo.insertMany([draft])).toHaveLength(0);
    const { rules } = await repo.listRules();
    expect(rules.find((r) => r.id === rule.id)?.definition.type).toBe("price_move");

    const alertId = created[0]!.id;
    const mine = async () => (await pushRepo(sql).listUndelivered({ sinceHours: 1, limit: 10_000 })).filter((p) => p.endpoint === ENDPOINT && p.alertId === alertId);
    const push = pushRepo(sql);
    await push.upsertSubscription({ endpoint: ENDPOINT, p256dh: "p", auth: "a" });
    expect(await mine()).toHaveLength(1);
    expect(await push.claimDelivery(alertId, ENDPOINT)).toBe(true);
    expect(await push.claimDelivery(alertId, ENDPOINT)).toBe(false);
    expect(await mine()).toHaveLength(0);
  });

  it("companies: master-list upsert keeps curated names and families", async () => {
    const repo = companiesRepo(sql);
    await repo.upsertMasterList([
      { symbol: SYMBOL, name: "ZZ TEST LIMITED", isin: "INE000ZZ0001", series: "EQ", statementFamily: "banking" },
      { symbol: "ZZNEWCO", name: "ZZ New Co Limited", isin: "INE000ZZ0002", series: "EQ", statementFamily: "industrial" },
    ]);
    const curated = await repo.get(SYMBOL);
    expect(curated?.name).toBe("ZZ Test Ltd");
    expect(curated?.statementFamily).toBe("industrial");
    expect(curated?.isin).toBe("INE000ZZ0001");
    expect((await repo.get("ZZNEWCO"))?.statementFamily).toBe("industrial");
    expect((await repo.listTracked()).some((c) => c.symbol === "ZZNEWCO")).toBe(false);
  });

  it("filings: facts upsert idempotently on (filing, concept, context)", async () => {
    const repo = filingsRepo(sql);
    const filing = {
      seqId: "zz-test-filing",
      symbol: SYMBOL,
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      basis: "consolidated" as const,
      statementFamily: "industrial" as const,
      taxonomy: "test",
      audited: false,
      revision: "original",
      broadcastAt: new Date(),
      xbrlUrl: "https://nsearchives.nseindia.com/zz.xml",
      sha256: "abc",
      parserVersion: 1,
      status: "parsed" as const,
      error: null,
    };
    await repo.upsertFiling(filing);
    await repo.upsertFiling(filing);
    const facts = [
      { concept: "RevenueFromOperations", context: "OneD" as const, periodStart: "2026-07-01", periodEnd: "2026-09-30", value: 731880000000, unit: "INR", derived: false },
      { concept: "RevenueFromOperations", context: "OneD" as const, periodStart: "2026-07-01", periodEnd: "2026-09-30", value: 1, unit: "INR", derived: false },
    ];
    expect(await repo.upsertFacts(filing.seqId, facts)).toBe(1);
    expect(await repo.upsertFacts(filing.seqId, facts)).toBe(1);
    const stored = await repo.getFacts(filing.seqId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.value).toBe(731880000000);
    expect((await repo.latestParsed(SYMBOL))?.seqId).toBe(filing.seqId);
  });

  it("filings: a revised parse that drops a line item removes the stale fact", async () => {
    const repo = filingsRepo(sql);
    const fact = (concept: string, context: "OneD" | "OneI", value: number) => ({ concept, context, periodStart: null, periodEnd: "2026-09-30", value, unit: "INR", derived: false });
    const original = [fact("RevenueFromOperations", "OneD", 100), fact("ExceptionalItems", "OneD", 7), fact("ExceptionalItems", "OneI", 9)];
    expect(await repo.upsertFacts("zz-test-filing", original)).toBe(3);
    expect((await repo.getFacts("zz-test-filing")).map((f) => `${f.concept}|${f.context}`)).toEqual(["ExceptionalItems|OneD", "ExceptionalItems|OneI", "RevenueFromOperations|OneD"]);

    const revised = [fact("RevenueFromOperations", "OneD", 101), fact("ExceptionalItems", "OneI", 9)];
    expect(await repo.upsertFacts("zz-test-filing", revised)).toBe(2);
    expect((await repo.getFacts("zz-test-filing")).map((f) => [f.concept, f.context, f.value])).toEqual([
      ["ExceptionalItems", "OneI", 9],
      ["RevenueFromOperations", "OneD", 101],
    ]);

    // A parse with no usable facts never wipes the stored ones.
    expect(await repo.upsertFacts("zz-test-filing", [fact("RevenueFromOperations", "OneD", Number.NaN)])).toBe(0);
    expect(await repo.countFacts("zz-test-filing")).toBe(2);
  });

  it("prefs: category weights merge", async () => {
    const repo = prefsRepo(sql);
    const before = await repo.getCategoryWeights();
    await repo.setCategoryWeight("dividend", 0.8);
    expect((await repo.getCategoryWeights()).dividend).toBe(0.8);
    await sql`UPDATE user_prefs SET category_weights = ${sql.json(before as postgres.JSONValue)} WHERE id = 1`;
  });
});
