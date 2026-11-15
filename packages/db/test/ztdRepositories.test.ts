import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "../src/client";
import { alertsRepo } from "../src/repositories/alerts";
import { announcementsRepo } from "../src/repositories/announcements";
import { companiesRepo } from "../src/repositories/companies";
import { prefsRepo } from "../src/repositories/prefs";
import { AVG_VOLUME_SESSIONS, pricesRepo, type PriceUpsert } from "../src/repositories/prices";
import { pushRepo } from "../src/repositories/push";
import { sourceHealthRepo } from "../src/repositories/sourceHealth";
import { watermarksRepo } from "../src/repositories/watermarks";

/**
 * Repository methods not exercised elsewhere. Every row carries the ZTDB / ztdb prefix; writes that can
 * only target shared rows (the user_prefs singleton, interactions without a seq id, a global avg20
 * recompute) run inside a transaction that is always rolled back.
 */
const url = process.env.DATABASE_URL ?? "postgres://finn:finn@localhost:54329/finn";
const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {}, connect_timeout: 3, types: { bigint: postgres.BigInt } }) as unknown as Sql;
const reachable = await sql`SELECT 1`.then(
  () => true,
  () => false,
);

const P = "ZTDB";
const S = (s: string) => `${P}${s}`;
const SOURCE = "ztdb_source";
const ENDPOINT = "https://ztdb.push.test/";
const RULE = "ztdb-rule";

class Rollback extends Error {}
async function inRolledBackTx(fn: (tx: Sql) => Promise<void>): Promise<void> {
  await sql
    .begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

async function cleanup() {
  await sql`DELETE FROM alert_rules WHERE name LIKE ${`${RULE}%`}`;
  await sql`DELETE FROM alerts WHERE symbol LIKE ${`${P}%`}`;
  await sql`DELETE FROM push_subscriptions WHERE endpoint LIKE ${`${ENDPOINT}%`}`;
  await sql`DELETE FROM announcements WHERE seq_id LIKE 'ztdb%' OR symbol LIKE ${`${P}%`}`;
  await sql`DELETE FROM prices_eod WHERE symbol LIKE ${`${P}%`}`;
  await sql`DELETE FROM companies WHERE symbol LIKE ${`${P}%`}`;
  await sql`DELETE FROM source_health WHERE source LIKE 'ztdb%'`;
  await sql`DELETE FROM ingestion_watermarks WHERE source LIKE 'ztdb%'`;
}

describe.skipIf(!reachable)("repositories (ZTDB scope) against the local database", () => {
  beforeAll(async () => {
    await cleanup();
    await sql`
      INSERT INTO companies (symbol, name, statement_family, screener_slug) VALUES
        (${S("BANK")}, 'ZTDB Bank', 'banking', 'ztdb-bank'),
        (${S("HOLD")}, 'ZTDB Held Bank', 'banking', NULL),
        (${S("LOOSE")}, 'ZTDB Untracked Bank', 'banking', NULL),
        (${S("IND")}, 'ZTDB Industrial', 'industrial', 'ztdb-ind'),
        (${S("NOFAM")}, 'ZTDB No Family', NULL, NULL)`;
    await sql`INSERT INTO holdings (symbol) VALUES (${S("HOLD")})`;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("companies: lookups are case-insensitive; families, holdings and counts", async () => {
    const repo = companiesRepo(sql);
    expect(await repo.get(S("bank").toLowerCase())).toMatchObject({ symbol: S("BANK"), statementFamily: "banking", screenerSlug: "ztdb-bank" });
    expect(await repo.get(S("MISSING"))).toBeNull();
    expect(await repo.getMany([])).toEqual([]);
    expect((await repo.getMany([S("ind").toLowerCase(), S("BANK"), S("MISSING")])).map((c) => c.symbol)).toEqual([S("BANK"), S("IND")]);
    expect(await repo.exists(S("hold").toLowerCase())).toBe(true);
    expect(await repo.exists(S("MISSING"))).toBe(false);

    const mine = (xs: string[]) => xs.filter((s) => s.startsWith(P));
    expect(mine(await repo.symbolsInFamily("banking"))).toEqual([S("BANK"), S("HOLD")]);
    expect(mine(await repo.symbolsInFamily("banking", false))).toEqual([S("BANK"), S("HOLD"), S("LOOSE")]);
    expect(mine(await repo.listHoldingSymbols())).toEqual([S("HOLD")]);
    expect(mine((await repo.listTracked()).map((c) => c.symbol))).toEqual([S("BANK"), S("HOLD"), S("IND")]);
    expect(mine((await repo.listAll()).map((c) => c.symbol))).toHaveLength(5);
    expect((await repo.familyMap()).get(S("NOFAM"))).toBeNull();
    expect(await repo.count()).toBeGreaterThanOrEqual(5);

    await repo.setStatementFamily(S("nofam").toLowerCase(), "nbfc");
    await repo.setStatementFamily(S("NOFAM"), "nbfc");
    expect((await repo.get(S("NOFAM")))?.statementFamily).toBe("nbfc");
  });

  it("companies: master-list upsert fills a missing family, ignores unchanged rows and batches", async () => {
    const repo = companiesRepo(sql);
    await sql`UPDATE companies SET statement_family = NULL WHERE symbol = ${S("NOFAM")}`;
    expect(await repo.upsertMasterList([{ symbol: S("nofam").toLowerCase(), name: "ignored", isin: null, series: null, statementFamily: "industrial" }])).toBe(1);
    expect(await repo.get(S("NOFAM"))).toMatchObject({ name: "ZTDB No Family", statementFamily: "industrial" });
    expect(await repo.upsertMasterList([{ symbol: S("NOFAM"), name: "ignored", isin: null, series: null, statementFamily: "banking" }])).toBe(0);

    const many = Array.from({ length: 1001 }, (_, i) => ({ symbol: S(`M${i}`), name: `ZTDB M${i}`, isin: null, series: "EQ", statementFamily: "industrial" as const }));
    expect(await repo.upsertMasterList(many)).toBe(1001);
    expect(await repo.upsertMasterList(many)).toBe(0);
    await sql`DELETE FROM companies WHERE symbol LIKE ${`${P}M%`}`;
  });

  it("prices: bhavcopy wins over Yahoo, prev close is kept, volume rounds, and the read models", async () => {
    const repo = pricesRepo(sql);
    const row = (symbol: string, sessionDate: string, close: number, extra: Partial<PriceUpsert> = {}): PriceUpsert => ({
      symbol,
      sessionDate,
      open: null,
      high: null,
      low: null,
      close,
      prevClose: null,
      volume: null,
      source: "yahoo",
      ...extra,
    });
    const A = S("BANK");
    const B = S("IND");
    expect(await repo.upsertMany([])).toBe(0);
    expect(await repo.upsertMany([row(A, "2099-01-01", 10, { source: "bhavcopy", prevClose: 9, volume: 100.6 }), row(B, "2099-01-01", 20)])).toBe(2);
    // Yahoo can't overwrite bhavcopy; bhavcopy replaces Yahoo; a null prev close keeps the stored one.
    expect(await repo.upsertMany([row(A, "2099-01-01", 99)])).toBe(0);
    expect(await repo.upsertMany([row(B, "2099-01-01", 21, { source: "bhavcopy", volume: 7 })])).toBe(1);
    expect(await repo.upsertMany([row(A, "2099-01-01", 11, { source: "bhavcopy" })])).toBe(1);
    await repo.upsertMany([row(A, "2099-01-02", 12, { source: "bhavcopy" })]);

    const session = (await repo.forSession("2099-01-01")).filter((p) => p.symbol.startsWith(P));
    expect(session).toEqual([
      { symbol: A, sessionDate: "2099-01-01", open: null, high: null, low: null, close: 11, prevClose: 9, volume: null, avg20Volume: null, source: "bhavcopy" },
      expect.objectContaining({ symbol: B, close: 21, volume: 7, source: "bhavcopy" }),
    ]);
    expect(await repo.countForSession("2099-01-01")).toBe(2);
    expect(await repo.countForSession("2099-01-01", "yahoo")).toBe(0);
    expect(await repo.countForSession("2099-01-02", "bhavcopy")).toBe(1);
    expect(await repo.latestSessionDate()).toBe("2099-01-02");
    expect((await repo.latestPerSymbol([A, B])).map((p) => [p.symbol, p.sessionDate])).toEqual([
      [A, "2099-01-02"],
      [B, "2099-01-01"],
    ]);
    expect((await repo.latestPerSymbol()).filter((p) => p.symbol.startsWith(P))).toHaveLength(2);
    expect((await repo.history(A)).map((p) => p.sessionDate)).toEqual(["2099-01-01", "2099-01-02"]);
    expect((await repo.history(A, 1)).map((p) => p.sessionDate)).toEqual(["2099-01-02"]);
    expect(await repo.sessionCount(A)).toBe(2);
    expect(await repo.sessionCount()).toBeGreaterThanOrEqual(2);
    expect(await repo.count()).toBeGreaterThanOrEqual(3);
  });

  it("prices: recomputeAvg20({ from }) only updates sessions on or after the date", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = pricesRepo(tx);
      const sym = S("AVG");
      await tx`INSERT INTO companies (symbol, name) VALUES (${sym}, 'ZTDB Avg')`;
      const days = Array.from({ length: AVG_VOLUME_SESSIONS + 3 }, (_, i) => `2099-02-${String(i + 1).padStart(2, "0")}`);
      await repo.upsertMany(days.map((d, i) => ({ symbol: sym, sessionDate: d, open: null, high: null, low: null, close: 1, prevClose: null, volume: (i + 1) * 10, source: "bhavcopy" as const })));
      // Volumes are 10, 20, ...; sessions 21..23 have 20 sessions of history, but only 22 and 23 are on/after `from`.
      expect(await repo.recomputeAvg20({ from: days[21]! })).toBe(2);
      const avg = (await repo.history(sym, 100)).map((p) => p.avg20Volume);
      expect(avg.slice(0, 21)).toEqual(Array(21).fill(null));
      expect(avg.slice(21)).toEqual([115, 125]);
      expect(await repo.recomputeAvg20({ from: days[21]! })).toBe(0);
    });
    expect(await companiesRepo(sql).exists(S("AVG"))).toBe(false);
  });

  it("alerts: rule CRUD, invalid definitions, listing, reading and counts", async () => {
    const repo = alertsRepo(sql);
    const def = { type: "price_move" as const, scope: { kind: "symbols" as const, symbols: [S("BANK")] }, direction: "up" as const, thresholdPct: 2 };
    const rule = await repo.createRule(`${RULE}-a`, def);
    expect(await repo.getRule(rule.id)).toMatchObject({ name: `${RULE}-a`, enabled: true, definition: def });
    expect(await repo.getRule("00000000-0000-0000-0000-000000000000")).toBeNull();

    expect(await repo.updateRule(rule.id, { enabled: false })).toBe(true);
    expect(await repo.getRule(rule.id)).toMatchObject({ name: `${RULE}-a`, enabled: false, definition: def });
    const def2 = { ...def, direction: "down" as const };
    expect(await repo.updateRule(rule.id, { name: `${RULE}-renamed`, definition: def2 })).toBe(true);
    expect(await repo.getRule(rule.id)).toMatchObject({ name: `${RULE}-renamed`, enabled: false, definition: def2 });
    expect(await repo.updateRule("00000000-0000-0000-0000-000000000000", { enabled: true })).toBe(false);

    const [bad] = await sql<{ id: string }[]>`INSERT INTO alert_rules (name, definition) VALUES (${`${RULE}-bad`}, '{"type":"nope"}') RETURNING id`;
    const all = await repo.listRules();
    expect(all.rules.map((r) => r.id)).toContain(rule.id);
    expect(all.invalid.find((i) => i.id === bad!.id)?.error).toBeTruthy();
    expect((await repo.listRules({ enabledOnly: true })).rules.map((r) => r.id)).not.toContain(rule.id);

    const drafts = ["e1", "e2"].map((eventKey) => ({
      ruleId: rule.id,
      symbol: S("BANK"),
      kind: "price_move" as const,
      eventKey,
      title: `t-${eventKey}`,
      body: "b",
      sessionDate: "2099-01-01",
      announcementSeqId: null,
    }));
    const created = await repo.insertMany(drafts);
    expect(created.map((c) => c.eventKey)).toEqual(["e1", "e2"]);
    expect(await repo.insertMany(drafts)).toEqual([]);

    const one = await repo.get(created[0]!.id);
    expect(one).toMatchObject({ ruleName: `${RULE}-renamed`, symbol: S("BANK"), sessionDate: "2099-01-01", readAt: null });
    expect(await repo.get("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect((await repo.list({ limit: 1000 })).filter((a) => a.symbol === S("BANK"))).toHaveLength(2);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
    expect((await repo.unreadCountBySymbol())[S("BANK")]).toBe(2);

    expect(await repo.markRead(created[0]!.id)).toBe(true);
    expect(await repo.markRead(created[0]!.id)).toBe(false);
    expect((await repo.get(created[0]!.id))?.readAt).toBeInstanceOf(Date);
    expect((await repo.list({ unreadOnly: true, limit: 1000 })).filter((a) => a.symbol === S("BANK")).map((a) => a.eventKey)).toEqual(["e2"]);
    expect((await repo.unreadCountBySymbol())[S("BANK")]).toBe(1);
    expect(await repo.count()).toBeGreaterThanOrEqual(2);

    expect(await repo.deleteRule(rule.id)).toBe(true);
    expect(await repo.deleteRule(rule.id)).toBe(false);
    expect(await repo.get(created[1]!.id)).toBeNull();
  });

  it("push: subscription upsert replaces keys; delete reports; delivery counts by status", async () => {
    const repo = pushRepo(sql);
    const endpoint = `${ENDPOINT}a`;
    await repo.upsertSubscription({ endpoint, p256dh: "p1", auth: "a1" });
    await repo.upsertSubscription({ endpoint, p256dh: "p2", auth: "a2" });
    expect((await repo.listSubscriptions()).find((s) => s.endpoint === endpoint)).toMatchObject({ p256dh: "p2", auth: "a2", lastOkAt: null });

    // countDeliveries is global and other files deliver concurrently; a repeatable-read snapshot sees only this test's writes.
    await sql
      .begin("isolation level repeatable read", async (raw) => {
        const tx = raw as unknown as Sql;
        const txRepo = pushRepo(tx);
        const before = await txRepo.countDeliveries();
        const rule = await alertsRepo(tx).createRule(`${RULE}-push`, { type: "price_move", scope: { kind: "symbols", symbols: [S("BANK")] }, direction: "either", thresholdPct: 1 });
        const [alert] = await alertsRepo(tx).insertMany([
          { ruleId: rule.id, symbol: S("BANK"), kind: "price_move", eventKey: "p", title: "t", body: "b", sessionDate: null, announcementSeqId: null },
        ]);
        expect(await txRepo.claimDelivery(alert!.id, endpoint)).toBe(true);
        expect(await txRepo.claimDelivery(alert!.id, endpoint)).toBe(false);
        expect(((await txRepo.countDeliveries()).pending ?? 0) - (before.pending ?? 0)).toBe(1);
        expect(await txRepo.deleteSubscription(endpoint)).toBe(true);
        expect(((await txRepo.countDeliveries()).pending ?? 0) - (before.pending ?? 0)).toBe(0);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    expect(await repo.deleteSubscription(endpoint)).toBe(true);
    expect(await repo.deleteSubscription(endpoint)).toBe(false);
  });

  it("source health list and watermarks never rewind", async () => {
    const health = sourceHealthRepo(sql);
    await health.recordFailure(`${SOURCE}_b`, "x".repeat(2000));
    await health.recordSuccess(`${SOURCE}_a`, 5);
    const mine = (await health.list()).filter((h) => h.source.startsWith("ztdb"));
    expect(mine.map((h) => [h.source, h.consecutiveFailures, h.recordsLastRun, h.lastError?.length ?? null])).toEqual([
      [`${SOURCE}_a`, 0, 5, null],
      [`${SOURCE}_b`, 1, null, 1000],
    ]);
    expect(await health.get(`${SOURCE}_missing`)).toBeNull();

    const marks = watermarksRepo(sql);
    expect(await marks.get(SOURCE)).toBeNull();
    const t1 = new Date("2099-01-02T00:00:00Z");
    expect(await marks.advance(SOURCE, t1)).toEqual(t1);
    expect(await marks.advance(SOURCE, new Date("2099-01-01T00:00:00Z"))).toEqual(t1);
    expect(await marks.get(SOURCE)).toEqual(t1);
  });

  it("announcements: one-liner, status, failures with and without counting an attempt, by-symbol listing", async () => {
    const repo = announcementsRepo(sql);
    const seq = "ztdb-ann-1";
    await repo.upsertRaw([
      { seqId: seq, symbol: S("BANK"), subject: "Updates", headline: "h", bodyText: null, pdfUrl: null, publishedAt: new Date("2099-01-01T05:00:00Z"), raw: {} },
      { seqId: "ztdb-ann-2", symbol: S("BANK"), subject: "Updates", headline: "h2", bodyText: null, pdfUrl: null, publishedAt: new Date("2099-01-02T05:00:00Z"), raw: {} },
    ]);
    await repo.setOneLiner(seq, "one liner");
    await repo.markStatus(seq, "review");
    expect(await repo.get(seq)).toMatchObject({ oneLiner: "one liner", status: "review", attempts: 0, subject: "Updates" });
    await repo.markFailed(seq, "e".repeat(1500));
    expect(await repo.get(seq)).toMatchObject({ status: "failed", attempts: 0 });
    expect((await repo.get(seq))?.error).toHaveLength(1000);
    await repo.markFailed(seq, "again", true);
    expect(await repo.get(seq)).toMatchObject({ status: "failed", attempts: 1, error: "again" });

    expect((await repo.listBySymbol(S("bank").toLowerCase())).map((a) => a.seqId)).toEqual(["ztdb-ann-2", seq]);
    expect((await repo.listBySymbol(S("BANK"), 1)).map((a) => a.seqId)).toEqual(["ztdb-ann-2"]);
    expect(await repo.listChildren([])).toEqual([]);
    const counts = await repo.countByStatus();
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    expect(counts.raw).toBeGreaterThanOrEqual(1);
  });

  it("announcements: corporate actions in a window carry the card record date and the exchange text", async () => {
    const repo = announcementsRepo(sql);
    const filed = (seqId: string, symbol: string, publishedAt: string, bodyText: string | null) => ({
      seqId,
      symbol,
      subject: "Bonus",
      headline: `${seqId} bonus issue 1:1`,
      bodyText,
      pdfUrl: null,
      publishedAt: new Date(publishedAt),
      raw: {},
    });
    await repo.upsertRaw([
      filed("ztdb-ca-card", S("BANK"), "2099-03-01T05:00:00Z", "Record date is 20-Mar-2099"),
      filed("ztdb-ca-text", S("IND"), "2099-03-02T05:00:00Z", null),
      filed("ztdb-ca-generic", S("HOLD"), "2099-03-03T05:00:00Z", null),
      filed("ztdb-ca-late", S("BANK"), "2099-04-01T05:00:00Z", null),
    ]);
    const classify = (seqId: string, category: "bonus_split" | "dividend") =>
      repo.saveClassification(seqId, { category, confidence: 0.95, source: "rule", reasonCodes: [], score: 40, tier: "know", clusterKey: seqId, oneLiner: null });
    for (const seqId of ["ztdb-ca-card", "ztdb-ca-text", "ztdb-ca-late"]) await classify(seqId, "bonus_split");
    await classify("ztdb-ca-generic", "dividend");
    await repo.saveCard("ztdb-ca-card", { kind: "corporate_action", action: "bonus", amountPerShare: null, ratio: "1:1", recordDate: "2099-03-20", yieldPct: null });
    await repo.saveCard("ztdb-ca-text", { kind: "generic", oneLiner: "Bonus" });

    const rows = (await repo.corporateActionsBetween("bonus_split", new Date("2099-02-01T00:00:00Z"), new Date("2099-04-01T00:00:00Z")))
      .filter((r) => r.symbol.startsWith(P))
      .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
    expect(rows).toEqual([
      { symbol: S("BANK"), publishedAt: new Date("2099-03-01T05:00:00Z"), recordDate: "2099-03-20", text: "ztdb-ca-card bonus issue 1:1\nRecord date is 20-Mar-2099" },
      { symbol: S("IND"), publishedAt: new Date("2099-03-02T05:00:00Z"), recordDate: null, text: "ztdb-ca-text bonus issue 1:1" },
    ]);
  });

  it("prefs: weights merge and are sanitised, default window, interactions and dismiss counts (rolled back)", async () => {
    const shared = await prefsRepo(sql).get();
    await inRolledBackTx(async (tx) => {
      const repo = prefsRepo(tx);
      const dismissedBefore = await repo.dismissCounts();

      await tx`UPDATE user_prefs SET category_weights = '{"dividend": 0.5, "not_a_category": 2, "results": "high", "pledging": null}' WHERE id = 1`;
      expect(await repo.getCategoryWeights()).toEqual({ dividend: 0.5 });
      await repo.setCategoryWeight("results", 1.4);
      await repo.setCategoryWeight("dividend", 0.7);
      expect(await repo.getCategoryWeights()).toEqual({ dividend: 0.7, results: 1.4 });

      await repo.setDefaultWindow("7d");
      expect((await repo.get()).defaultWindow).toBe("7d");

      await repo.recordInteraction({ seqId: null, action: "dismiss", category: "dividend" });
      await repo.recordInteraction({ seqId: null, action: "dismiss", category: "dividend" });
      await repo.recordInteraction({ seqId: null, action: "pin", category: "dividend" });
      await repo.recordInteraction({ seqId: null, action: "dismiss", category: null });
      await tx`INSERT INTO interactions (action, category) VALUES ('dismiss', 'ztdb_unknown_category')`;
      const dismissed = await repo.dismissCounts();
      expect((dismissed.dividend ?? 0) - (dismissedBefore.dividend ?? 0)).toBe(2);
      expect(Object.keys(dismissed)).not.toContain("ztdb_unknown_category");
      expect(await repo.dismissCounts(0)).toEqual({});

      await tx`DELETE FROM user_prefs WHERE id = 1`;
      expect(await repo.get()).toEqual({ categoryWeights: {}, defaultWindow: "24h", updatedAt: new Date(0) });
    });
    expect(await prefsRepo(sql).get()).toEqual(shared);
  });
});
