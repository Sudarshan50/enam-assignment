import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeDb, getDb } from "@finn/db";
import {
  AlertRuleSchema,
  AlertSchema,
  AskResponseSchema,
  BullBearPayloadSchema,
  BusinessSnapshotPayloadSchema,
  CashQualityPayloadSchema,
  DigestItemSchema,
  DigestResponseSchema,
  EngineStatsSchema,
  FinancialSnapshotPayloadSchema,
  HoldingSchema,
  type ModuleKey,
  PreviewAlertRuleResponseSchema,
  PromiseLedgerPayloadSchema,
  ResearchModuleSchema,
  ResearchRunSchema,
} from "@finn/shared";
import * as web from "../../web/src/lib/api/schemas";
import {
  AnnouncementDetailSchema,
  CompanyResearchSchema,
  CompanySearchResultSchema,
  EngineResponseSchema,
  FinancialsResponseSchema,
  HealthSchema,
  JobListSchema,
  PrefsSchema,
  PreviewResponseSchema,
  VapidKeyResponseSchema,
} from "../src/contracts";
import { JOBS_SECRET, TOKEN, auth } from "./helpers";
import { buildDbApp, dbReachable, expectParse } from "./support/db";

const dbUp = await dbReachable();

/** What the research canvas parses each finished module's payload with (apps/web research-screen). */
const PAYLOAD_SCHEMAS: Record<ModuleKey, z.ZodType> = {
  promise_ledger: PromiseLedgerPayloadSchema,
  financial_snapshot: FinancialSnapshotPayloadSchema,
  cash_quality: CashQualityPayloadSchema,
  bull_bear: BullBearPayloadSchema,
  business_snapshot: BusinessSnapshotPayloadSchema,
};

describe.skipIf(!dbUp)("response contracts against the local database", async () => {
  if (!dbUp) return it.skip("needs the local database", () => {});
  const sql = getDb();
  // Contract checks happen in the test, as in production where response validation is off.
  const { app } = await buildDbApp(sql, { config: { responseValidation: "off" } });

  // Real rows only: other suites create and delete ZT* rows concurrently.
  const companies = (await sql<{ symbol: string }[]>`SELECT symbol FROM companies WHERE symbol NOT LIKE 'ZT%' ORDER BY symbol`).map((r) => r.symbol);
  const runIds = (await sql<{ id: string }[]>`SELECT id FROM research_runs WHERE symbol NOT LIKE 'ZT%' ORDER BY created_at DESC LIMIT 25`).map((r) => r.id);
  const seqIds = (
    await sql<{ seqId: string }[]>`
      (SELECT seq_id AS "seqId" FROM announcements WHERE symbol NOT LIKE 'ZT%' AND length(seq_id) <= 64 ORDER BY published_at DESC LIMIT 30)
      UNION
      (SELECT seq_id FROM announcements WHERE symbol NOT LIKE 'ZT%' AND length(seq_id) <= 64 AND card IS NOT NULL ORDER BY published_at DESC LIMIT 30)
      UNION
      (SELECT seq_id FROM announcements WHERE symbol NOT LIKE 'ZT%' AND length(seq_id) <= 64 AND parent_seq_id IS NOT NULL LIMIT 10)`
  ).map((r) => r.seqId);

  afterAll(async () => {
    await closeDb();
  });

  const get = (path: string) => request(app).get(path).set(auth);

  it("has real data to check against", () => {
    expect(companies.length).toBeGreaterThan(0);
    expect(seqIds.length).toBeGreaterThan(0);
  });

  it("GET /healthz and /api/v1/healthz match HealthSchema without a token", async () => {
    for (const path of ["/healthz", "/api/v1/healthz"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(expectParse(HealthSchema, res.body, path)).toMatchObject({ ok: true, db: "up" });
    }
  });

  describe("GET /api/v1/digest", () => {
    const variants = ["", "?window=24h", "?window=3d", "?window=7d", `?from=${encodeURIComponent(new Date(Date.now() - 30 * 86_400_000).toISOString())}`];

    it.each(variants)("%s matches DigestResponseSchema and its own invariants", async (query) => {
      const res = await get(`/api/v1/digest${query}`);
      expect(res.status).toBe(200);
      const digest = expectParse(DigestResponseSchema, res.body, `digest${query}`);
      expect(digest.counts).toEqual({ act: digest.act.length, know: digest.know.length, noise: digest.noise.length });
      const heads = [...digest.act, ...digest.know, ...digest.noise];
      const linked = new Set(heads.flatMap((h) => h.linked.map((l) => l.seqId)));
      expect(heads.filter((h) => linked.has(h.id))).toEqual([]);
      for (const tier of ["act", "know", "noise"] as const) {
        expect(digest[tier].every((i) => i.tier === tier)).toBe(true);
        const scores = digest[tier].map((i) => i.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
      }
      const from = Date.parse(digest.window.from);
      const to = Date.parse(digest.window.to);
      expect(heads.every((h) => Date.parse(h.publishedAt) >= from && Date.parse(h.publishedAt) < to)).toBe(true);
    });
  });

  it("GET /api/v1/announcements/:seqId matches AnnouncementDetailSchema (and DigestItemSchema, which the web uses)", async () => {
    for (const seqId of seqIds) {
      const res = await get(`/api/v1/announcements/${encodeURIComponent(seqId)}`);
      // The database is shared: a row deleted by someone else since collection is not an API failure.
      if (res.status === 404 && (await sql`SELECT 1 FROM announcements WHERE seq_id = ${seqId}`).length === 0) continue;
      expect(res.status, seqId).toBe(200);
      const detail = expectParse(AnnouncementDetailSchema, res.body, `announcement ${seqId}`);
      expectParse(DigestItemSchema, res.body, `announcement ${seqId} as DigestItem`);
      expect(detail.id).toBe(seqId);
    }
  });

  it("GET /api/v1/holdings matches Holding[]", async () => {
    const res = await get("/api/v1/holdings");
    expect(res.status).toBe(200);
    const holdings = expectParse(z.array(HoldingSchema), res.body, "holdings");
    expect(holdings.length).toBeGreaterThan(0);
    for (const h of holdings) {
      expect(h.sparkline.length).toBeLessThanOrEqual(30);
      if (h.close !== null) expect(h.sparkline.at(-1)).toBe(h.close);
    }
  });

  it("GET /api/v1/companies/search matches CompanySearchResult[]", async () => {
    for (const q of ["a", "TC", companies[0]!, "%"]) {
      const res = await get(`/api/v1/companies/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      const results = expectParse(z.array(CompanySearchResultSchema), res.body, `search ${q}`);
      expect(results.length).toBeLessThanOrEqual(10);
    }
    const exact = await get(`/api/v1/companies/search?q=${encodeURIComponent(companies[0]!.toLowerCase())}`);
    expect(exact.body[0].symbol).toBe(companies[0]);
    // LIKE wildcards are escaped, so a bare % only matches a literal percent sign.
    const wildcard = await get("/api/v1/companies/search?q=%25");
    expect(wildcard.body.filter((r: { name: string }) => !r.name.includes("%"))).toEqual([]);
  });

  it("GET /api/v1/companies/:symbol/financials matches FinancialsResponseSchema for every company", async () => {
    for (const symbol of companies) {
      const res = await get(`/api/v1/companies/${symbol}/financials`);
      expect(res.status, symbol).toBe(200);
      const fin = expectParse(FinancialsResponseSchema, res.body, `financials ${symbol}`);
      expect(fin.quarters.length).toBeLessThanOrEqual(8);
      // Never mixes consolidated and standalone.
      expect(fin.quarters.every((q) => q.basis === fin.basis)).toBe(true);
    }
  });

  it("GET /api/v1/companies/:symbol/research matches CompanyResearchSchema, with payloads the canvas can parse", async () => {
    for (const symbol of companies) {
      const res = await get(`/api/v1/companies/${symbol}/research`);
      expect(res.status, symbol).toBe(200);
      const page = expectParse(CompanyResearchSchema, res.body, `research ${symbol}`);
      expect(page.symbol).toBe(symbol);
      if (page.run) {
        expectParse(ResearchRunSchema, page.run, `research ${symbol} run`);
        expect(page.modules).toEqual(page.run.modules);
      }
      expectParse(z.array(ResearchModuleSchema), page.modules, `research ${symbol} modules`);
      for (const m of page.modules.filter((x) => x.status === "done")) {
        expectParse(PAYLOAD_SCHEMAS[m.key], m.payload, `${symbol} ${m.key} payload`);
      }
    }
  });

  it("GET /api/v1/research-runs/:id matches ResearchRunSchema for every stored run", async () => {
    for (const id of runIds) {
      const res = await get(`/api/v1/research-runs/${id}`);
      if (res.status === 404 && (await sql`SELECT 1 FROM research_runs WHERE id = ${id}`).length === 0) continue;
      expect(res.status, id).toBe(200);
      const run = expectParse(ResearchRunSchema, res.body, `run ${id}`);
      expect(run.id).toBe(id);
    }
  });

  it("GET /api/v1/alert-rules matches AlertRule[] and GET /api/v1/alerts matches Alert[]", async () => {
    const rules = await get("/api/v1/alert-rules");
    expect(rules.status).toBe(200);
    expectParse(z.array(AlertRuleSchema), rules.body, "alert rules");

    for (const limit of ["", "?limit=1", "?limit=100"]) {
      const alerts = await get(`/api/v1/alerts${limit}`);
      expect(alerts.status).toBe(200);
      const list = expectParse(z.array(AlertSchema), alerts.body, `alerts${limit}`);
      if (limit === "?limit=1") expect(list.length).toBeLessThanOrEqual(1);
    }
  });

  it("GET /api/v1/prefs matches PrefsSchema", async () => {
    const res = await get("/api/v1/prefs");
    expect(res.status).toBe(200);
    expectParse(PrefsSchema, res.body, "prefs");
  });

  it("GET /api/v1/engine matches EngineStatsSchema and the API's EngineResponseSchema", async () => {
    const res = await get("/api/v1/engine");
    expect(res.status).toBe(200);
    expectParse(EngineStatsSchema, res.body, "engine (shared)");
    const engine = expectParse(EngineResponseSchema, res.body, "engine (extended)");
    expect(engine.llm.budgetRemaining).toBeGreaterThanOrEqual(0);
    expect(engine.llm.cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(engine.llm.cacheHitRate).toBeLessThanOrEqual(1);
  });

  it("GET /api/v1/push/vapid-public-key matches VapidKeyResponseSchema", async () => {
    const res = await get("/api/v1/push/vapid-public-key");
    expect(res.status).toBe(200);
    expect(expectParse(VapidKeyResponseSchema, res.body, "vapid")).toEqual({ enabled: false, publicKey: null });
  });

  it("GET /api/v1/internal/jobs matches JobListSchema with the jobs secret", async () => {
    const res = await request(app).get("/api/v1/internal/jobs").set("Authorization", `Bearer ${JOBS_SECRET}`);
    expect(res.status).toBe(200);
    expectParse(JobListSchema, res.body, "jobs");
  });

  it("POST /api/v1/alert-rules/preview matches PreviewResponseSchema (shared PreviewAlertRuleResponse + backtest)", async () => {
    for (const text of ["tell me when any holding falls more than 4%", "volume above 3x average", "new results for my banks", "gibberish here"]) {
      const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text });
      expect(res.status, text).toBe(200);
      expectParse(PreviewAlertRuleResponseSchema, res.body, `preview "${text}" (shared)`);
      expectParse(PreviewResponseSchema, res.body, `preview "${text}" (extended)`);
    }
  });

  it("POST /api/v1/ask matches AskResponseSchema", async () => {
    const res = await request(app).post("/api/v1/ask").set(auth).send({ symbol: companies[0], question: "What changed this quarter?" });
    expect(res.status).toBe(200);
    expect(expectParse(AskResponseSchema, res.body, "ask")).toEqual({ answer: [], insufficientSources: true });
  });

  describe("the web client's own parsers (apps/web/src/lib/api/schemas.ts) accept live responses", () => {
    it("holdings, alerts, alert rules, search, engine and prefs", async () => {
      expectParse(web.HoldingsResponseSchema, (await get("/api/v1/holdings")).body, "web holdings");
      expectParse(web.AlertsResponseSchema, (await get("/api/v1/alerts")).body, "web alerts");
      expectParse(web.AlertRulesResponseSchema, (await get("/api/v1/alert-rules")).body, "web rules");
      const search = expectParse(web.CompanySearchResponseSchema, (await get("/api/v1/companies/search?q=a")).body, "web search");
      expect(search.every((r) => typeof r.inPortfolio === "boolean")).toBe(true);
      expectParse(web.EngineResponseSchema, (await get("/api/v1/engine")).body, "web engine");
      const prefs = expectParse(web.PrefsSchema, (await get("/api/v1/prefs")).body, "web prefs");
      expect(prefs.defaultWindow).toBeDefined();
    });

    it("rule previews", async () => {
      const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: "tell me when any holding falls more than 4%" });
      const preview = expectParse(web.RulePreviewSchema, res.body, "web preview");
      if (preview.backtest) expect(preview.backtest.sessions).toBe(res.body.backtest.sessions);
    });

    it("company research: the web unwraps the run from the API envelope", async () => {
      for (const symbol of companies) {
        const body = (await get(`/api/v1/companies/${symbol}/research`)).body;
        const parsed = expectParse(web.SymbolResearchResponseSchema, body, `web research ${symbol}`);
        expect(parsed.run?.id ?? null).toBe(body.run?.id ?? null);
      }
    });

    it("vapid key with push disabled reads as no key", async () => {
      expect(expectParse(web.VapidKeyResponseSchema, (await get("/api/v1/push/vapid-public-key")).body, "web vapid")).toBeNull();
    });  });

  it("every contract check above went through the demo-token gate", async () => {
    expect((await request(app).get("/api/v1/holdings")).status).toBe(401);
    expect((await request(app).get("/api/v1/holdings").set("Cookie", `finn_access=${TOKEN}`)).status).toBe(200);
  });
});
