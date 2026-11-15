import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createNoopDispatcher } from "../src/adapters/workerDispatcher";
import { HttpError } from "../src/http/errors";
import { sendJson } from "../src/http/respond";
import { clamp, num, round } from "../src/lib/numbers";
import { startOfIstDay, toIso, toIsoRequired } from "../src/lib/time";
import { describeBacktest } from "../src/services/alertBacktest";
import { type AlertRepository, createAlertRuleService, createAlertService, withThreshold } from "../src/services/alertRuleService";
import { createAskService, mapAskError } from "../src/services/askService";
import { type CompanyRepository, type FilingRow, createCompanyService } from "../src/services/companyService";
import { type EngineRepository, createEngineService, createLlmBudget } from "../src/services/engineService";
import { createHealthService } from "../src/services/healthService";
import { toHolding, volumeVsAverage } from "../src/services/holdingsService";
import { createPrefsService, sanitizeWeights, toPrefs } from "../src/services/prefsService";
import { type PushRepository, type PushSender, createPushService } from "../src/services/pushService";
import { parseLastEventId, streamResearchEvents } from "../src/services/researchEventStream";
import { type ResearchRepository, type RunRecord, createResearchService, ledgerFromModules, toModules } from "../src/services/researchService";
import { createSourceHealthService } from "../src/services/sourceHealthService";
import { auth, buildTestApp, silentLog } from "./helpers";

function researchRepo(overrides: Partial<ResearchRepository> = {}): ResearchRepository {
  const run: RunRecord = { id: randomUUID(), symbol: "TCS", status: "queued", modules: [], createdAt: new Date(), updatedAt: new Date(), dispatchAttempts: 0 };
  return {
    findCompany: async (symbol) => ({ symbol, name: `${symbol} Ltd` }),
    findLatestCompleted: async () => null,
    findActive: async () => null,
    countCreatedSince: async () => 0,
    insertQueued: async () => run,
    appendEvent: async () => {},
    markDispatched: vi.fn(async () => {}),
    recordDispatchFailure: vi.fn(async () => {}),
    markFailed: async () => {},
    getRun: async () => null,
    findLatestRun: async () => null,
    listModules: async () => [],
    listDocuments: async () => [],
    listStaleQueued: async () => [],
    ...overrides,
  };
}

describe("research quota window", () => {
  it.each([
    ["23:59 IST counts from that day's midnight", "2026-11-15T18:29:00Z", "2026-11-14T18:30:00.000Z"],
    ["00:01 IST counts from the new midnight", "2026-11-15T18:31:00Z", "2026-11-15T18:30:00.000Z"],
    ["05:00 IST (still the previous UTC day)", "2026-11-14T23:30:00Z", "2026-11-14T18:30:00.000Z"],
  ])("%s", async (_label, now, expectedSince) => {
    const countCreatedSince = vi.fn(async () => 0);
    const research = createResearchService({
      repo: researchRepo({ countCreatedSince }),
      dispatcher: createNoopDispatcher(silentLog),
      runsPerDay: 5,
      now: () => new Date(now),
      log: silentLog,
    });
    await research.create({ symbol: "TCS" });
    expect((countCreatedSince.mock.calls[0] as unknown as [Date])[0].toISOString()).toBe(expectedSince);
    expect(startOfIstDay(new Date(now)).toISOString()).toBe(expectedSince);
  });

  it("does not mark a run dispatched when the dispatcher is the no-op (it waits for a manual worker)", async () => {
    const repo = researchRepo();
    const log = { ...silentLog, warn: vi.fn() };
    const research = createResearchService({ repo, dispatcher: createNoopDispatcher(log), runsPerDay: 5, log });
    expect((await research.create({ symbol: "TCS" })).status).toBe(202);
    expect(repo.markDispatched).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ symbol: "TCS" }), expect.stringContaining("GITHUB_DISPATCH_TOKEN not set"));
  });

  it("fails loudly if the insert conflicted but no active run can be found", async () => {
    const research = createResearchService({
      repo: researchRepo({ insertQueued: async () => null }),
      dispatcher: createNoopDispatcher(silentLog),
      runsPerDay: 5,
      log: silentLog,
    });
    await expect(research.create({ symbol: "TCS" })).rejects.toThrow(/conflicted/);
  });
});

describe("research read models", () => {
  const updatedAt = new Date("2026-11-15T08:00:00Z");

  it("maps unknown module statuses to failed and drops unknown modules", () => {
    const modules = toModules({ modules: ["cash_quality", "nonsense"], updatedAt }, [
      { module: "bull_bear", status: "exploded", payload: undefined, error: "x", updatedAt },
      { module: "nonsense", status: "done", payload: {}, error: null, updatedAt },
    ]);
    expect(modules).toEqual([
      { key: "cash_quality", status: "pending", payload: null, error: null, updatedAt: updatedAt.toISOString() },
      { key: "bull_bear", status: "failed", payload: null, error: "x", updatedAt: updatedAt.toISOString() },
    ]);
  });

  it("takes the promise ledger from the done promise_ledger module and nothing else", () => {
    const promise = {
      id: "g1",
      metric: "revenue_growth",
      statementType: "explicit_guidance",
      low: 10,
      high: 12,
      unit: "pct",
      horizonLabel: "FY27",
      horizonEnd: "2027-03-31",
      saidIn: "Q2 FY26 call",
      speaker: null,
      quote: "We expect 10-12% growth",
      citation: { chunkId: "c1", documentId: "d1", documentLabel: "Transcript Q2 FY26", page: 4, quote: "We expect 10-12% growth", url: null },
      actual: null,
      actualPeriod: null,
      actualSource: null,
      verdict: "pending",
      explanation: "FY27 has not ended yet.",
    };
    const summary = { elapsed: 0, delivered: 0, missed: 0, pending: 1, quietlyDropped: 0 };
    const mod = (status: "done" | "running", payload: unknown) => ({ key: "promise_ledger" as const, status, payload, error: null, updatedAt: updatedAt.toISOString() });

    expect(ledgerFromModules([mod("done", { summary, promises: [promise], transcriptsUsed: ["Q2 FY26"] })])).toEqual({ summary, promises: [promise] });
    expect(ledgerFromModules([mod("running", { summary, promises: [promise], transcriptsUsed: [] })])).toBeNull();
    expect(ledgerFromModules([mod("done", { summary, promises: [], transcriptsUsed: [] })])).toBeNull();
    expect(ledgerFromModules([mod("done", { nonsense: true })])).toBeNull();
    expect(ledgerFromModules([])).toBeNull();
  });

  it("reports an unknown stored run status as failed", async () => {
    const research = createResearchService({
      repo: researchRepo({
        getRun: async (id) => ({ id, symbol: "TCS", status: "weird", modules: [], createdAt: updatedAt, updatedAt, dispatchAttempts: 0, companyName: "TCS" }),
      }),
      dispatcher: createNoopDispatcher(silentLog),
      runsPerDay: 1,
      log: silentLog,
    });
    expect((await research.getRun(randomUUID())).status).toBe("failed");
  });
});

describe("POST /api/v1/ask passthrough", () => {
  it("returns insufficientSources answers unchanged", async () => {
    const answer = { answer: [], insufficientSources: true };
    const ask = createAskService({ engine: { answer: async () => answer }, companyExists: async () => true });
    const res = await request(buildTestApp({ ask })).post("/api/v1/ask").set(auth).send({ symbol: "TCS", question: "Any guidance on margins?" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
  });

  it("keeps HttpErrors, maps LLM errors by name and lets anything else become a 500", async () => {
    const teapot = new HttpError(418, "teapot", "no");
    expect(mapAskError(teapot)).toBe(teapot);
    expect(mapAskError(Object.assign(new Error("x"), { name: "BudgetExceededError" }))).toMatchObject({ status: 429, code: "llm_budget_exhausted" });
    expect(mapAskError(Object.assign(new Error("x"), { name: "LlmUnavailableError" }))).toMatchObject({ status: 503, code: "llm_unavailable" });
    expect(mapAskError(null)).toBeNull();

    const ask = createAskService({ engine: { answer: async () => Promise.reject(new TypeError("boom")) }, companyExists: async () => true });
    const res = await request(buildTestApp({ ask })).post("/api/v1/ask").set(auth).send({ symbol: "TCS", question: "Any guidance on margins?" });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
  });
});

describe("engine stats and the LLM budget", () => {
  const usage = (calls: number, cacheHits: number, schemaChecked: number, schemaValid: number) => ({
    calls,
    billableCalls: calls - cacheHits,
    cacheHits,
    promptTokens: calls * 100,
    completionTokens: calls * 10,
    schemaChecked,
    schemaValid,
  });

  function repo(overrides: Partial<EngineRepository> = {}): EngineRepository {
    return {
      llmUsageSince: async (since) => (since.getTime() > Date.parse("2026-11-14T00:00:00Z") ? usage(3, 1, 0, 0) : usage(30, 6, 9, 8)),
      billableLlmCallsSince: async () => 7,
      llmByPurposeSince: async () => [{ purpose: "classify", calls: 30, tokens: 3300, cacheHits: 6 }],
      neuronsSince: async () => 12.345,
      chunksTotal: async () => 900,
      documentCounts: async () => ({ ready: 5, failed: 1, scanned: 2 }),
      announcementCounts: async () => ({ processedToday: 4, processed7d: 40, ready: 38, pending: 1, failed: 1 }),
      ...overrides,
    };
  }

  it("never reports a negative remaining budget and counts from IST midnight", async () => {
    const billable = vi.fn(async () => 2500);
    const now = new Date("2026-11-15T20:00:00Z");
    expect(await createLlmBudget({ repo: repo({ billableLlmCallsSince: billable }), dailyBudget: 2000, now: () => now }).remaining()).toBe(0);
    expect((billable.mock.calls[0] as unknown as [Date])[0].toISOString()).toBe("2026-11-15T18:30:00.000Z");
    expect(await createLlmBudget({ repo: repo(), dailyBudget: 10 }).remaining()).toBe(3);
  });

  it("computes rates, rounds neurons and picks the latest ingest", async () => {
    const now = new Date("2026-11-15T06:00:00Z");
    const sourceHealth = createSourceHealthService(
      {
        list: async () => [
          { source: "nse_announcements", lastSuccessAt: new Date("2026-11-15T05:45:00Z"), lastAttemptAt: null, consecutiveFailures: 0, lastError: null },
          { source: "nse_bhavcopy", lastSuccessAt: new Date("2026-11-14T13:30:00Z"), lastAttemptAt: null, consecutiveFailures: 0, lastError: null },
          { source: "screener", lastSuccessAt: null, lastAttemptAt: null, consecutiveFailures: 4, lastError: "403" },
        ],
      },
      () => now,
    );
    const stats = await createEngineService({ repo: repo(), sourceHealth, budget: { remaining: async () => 42 }, now: () => now }).stats();
    expect(stats.llm).toEqual({
      callsToday: 3,
      cacheHitRate: 0.333,
      promptTokensToday: 300,
      completionTokensToday: 30,
      jsonAdherenceRate: 0.889,
      budgetRemaining: 42,
    });
    expect(stats.embeddings).toEqual({ neuronsToday: 12.3, chunksTotal: 900 });
    expect(stats.lastIngestAt).toBe("2026-11-15T05:45:00.000Z");
    expect(stats.asOf).toBe(now.toISOString());
    expect(stats.sourceHealth.find((s) => s.source === "screener")!.stale).toBe(true);
  });

  it("reports a zero cache rate and full JSON adherence when there were no calls", async () => {
    const idle = repo({ llmUsageSince: async () => usage(0, 0, 0, 0) });
    const stats = await createEngineService({ repo: idle, sourceHealth: { list: async () => [] }, budget: { remaining: async () => 1 } }).stats();
    expect(stats.llm.cacheHitRate).toBe(0);
    expect(stats.llm.jsonAdherenceRate).toBe(1);
    expect(stats.lastIngestAt).toBeNull();
  });
});

describe("company financials", () => {
  const filing = (partial: Partial<FilingRow>): FilingRow => ({
    seqId: "f",
    periodEnd: "2026-09-30",
    basis: "consolidated",
    statementFamily: "industrial",
    audited: false,
    status: "ok",
    broadcastAt: null,
    xbrlUrl: "https://x/xbrl.xml",
    facts: [],
    ...partial,
  });

  function repo(filings: FilingRow[]): CompanyRepository {
    return {
      search: async () => [{ symbol: "TCS", name: "TCS", statementFamily: "weird", isHolding: false }],
      get: async (symbol) => (symbol === "TCS" ? { symbol, name: "Tata Consultancy", statementFamily: "industrial", isHolding: true } : null),
      listFilings: async () => filings,
      listHistory: async () => [
        { statement: "pnl", basis: "consolidated", periods: ["FY25"], rows: [], unit: "cr", source: "screener", fetchedAt: new Date("2026-11-01T00:00:00Z") },
        { statement: "bs", basis: "standalone", periods: [], rows: {}, unit: "cr", source: "manual", fetchedAt: new Date("2026-11-01T00:00:00Z") },
      ],
    };
  }

  it("prefers consolidated, keeps 8 quarters, splits OneD/FourD facts and de-duplicates derived concepts", async () => {
    const quarters = Array.from({ length: 10 }, (_, i) => filing({ seqId: `c${i}`, periodEnd: `20${16 + i}-03-31` }));
    quarters[0] = filing({
      seqId: "c0",
      statementFamily: "mystery",
      broadcastAt: new Date("2026-10-10T10:00:00Z"),
      facts: [
        { concept: "Revenue", context: "OneD", value: 100, derived: false },
        { concept: "Revenue", context: "FourD", value: 300, derived: false },
        { concept: "Ebitda", context: "OneD", value: 20, derived: true },
        { concept: "Ebitda", context: "FourD", value: 60, derived: true },
        { concept: "Equity", context: "OneI", value: 999, derived: true },
      ],
    });
    const service = createCompanyService(repo([...quarters, filing({ seqId: "s1", basis: "standalone" })]));
    const fin = await service.financials("TCS");
    expect(fin.basis).toBe("consolidated");
    expect(fin.quarters).toHaveLength(8);
    expect(fin.quarters.every((q) => q.basis === "consolidated")).toBe(true);
    expect(fin.quarters[0]).toMatchObject({
      quarter: { Revenue: 100, Ebitda: 20 },
      yearToDate: { Revenue: 300, Ebitda: 60 },
      derived: ["Ebitda"],
      statementFamily: "industrial",
      broadcastAt: "2026-10-10T10:00:00.000Z",
      source: "nse_xbrl",
    });
    expect(fin.history.map((h) => h.sourceLabel)).toEqual(["Standardised by screener.in from company filings", "manual"]);
  });

  it("falls back to standalone, and 404s for unknown companies", async () => {
    const fin = await createCompanyService(repo([filing({ basis: "standalone" })])).financials("TCS");
    expect(fin.basis).toBe("standalone");
    await expect(createCompanyService(repo([])).financials("NOPE")).rejects.toMatchObject({ status: 404 });
    expect((await createCompanyService(repo([])).search("t"))[0]!.statementFamily).toBeNull();
  });
});

describe("prefs read model", () => {
  it("drops unknown categories and non-numeric weights and clamps the rest", () => {
    expect(sanitizeWeights(null)).toEqual({});
    expect(sanitizeWeights("x")).toEqual({});
    expect(sanitizeWeights({ dividend: 5, results: "0.1", capex: "abc", made_up: 1, litigation: null })).toEqual({ dividend: 1.6, results: 0.4 });
  });

  it("defaults an unknown window to 24h and malformed quiet hours to null", async () => {
    const row = { categoryWeights: {}, defaultWindow: "1y", quietHours: { enabled: true, start: "9", end: "10" }, updatedAt: new Date(0) };
    expect(toPrefs(row)).toEqual({ categoryWeights: {}, defaultWindow: "24h", quietHours: null, updatedAt: "1970-01-01T00:00:00.000Z" });
    const update = vi.fn(async () => ({ ...row, defaultWindow: "7d" }));
    const service = createPrefsService({ get: async () => row, update, updateCategoryWeight: async () => 1 });
    expect((await service.update({ defaultWindow: "7d" })).defaultWindow).toBe("7d");
    expect(update).toHaveBeenCalledWith({ defaultWindow: "7d" });
  });
});

describe("push test sends", () => {
  function setup(results: Record<string, Awaited<ReturnType<PushSender["send"]>>>) {
    const subs = Object.keys(results).map((endpoint) => ({ endpoint, p256dh: "k", auth: "a" }));
    const repo: PushRepository = { upsert: vi.fn(), remove: vi.fn(async () => true), list: async () => subs, markOk: vi.fn(async () => {}) };
    const send = vi.fn(async (sub: { endpoint: string }) => results[sub.endpoint]!);
    const log = { ...silentLog, warn: vi.fn() };
    return { repo, send, log, service: createPushService({ repo, sender: { send }, vapidPublicKey: "BPK", log }) };
  }

  it("counts sent, failed and pruned, marks good endpoints and removes gone ones", async () => {
    const { repo, send, log, service } = setup({
      "https://a": { ok: true },
      "https://gone": { ok: false, gone: true, error: "410: Gone" },
      "https://flaky": { ok: false, gone: false, error: "500: oops" },
    });
    expect(await service.sendTest()).toEqual({ sent: 1, failed: 1, pruned: 1 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://a" }), { title: "FINN", body: "Push notifications are working.", url: "/" });
    expect(repo.markOk).toHaveBeenCalledWith("https://a");
    expect(repo.remove).toHaveBeenCalledWith("https://gone");
    expect(repo.remove).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ error: "500: oops" }, "test push failed");
    expect(service.publicKey()).toEqual({ enabled: true, publicKey: "BPK" });
  });

  it("is disabled without a sender or without a public key", async () => {
    const repo: PushRepository = { upsert: vi.fn(async () => {}), remove: vi.fn(async () => false), list: vi.fn(async () => []), markOk: vi.fn() };
    const noSender = createPushService({ repo, sender: null, vapidPublicKey: "BPK", log: silentLog });
    expect(noSender.publicKey()).toEqual({ enabled: false, publicKey: null });
    expect(await noSender.sendTest()).toEqual({ sent: 0, failed: 0, pruned: 0 });
    expect(repo.list).not.toHaveBeenCalled();
    const noKey = createPushService({ repo, sender: { send: vi.fn() }, vapidPublicKey: null, log: silentLog });
    expect(noKey.publicKey()).toEqual({ enabled: false, publicKey: null });
    await noKey.subscribe({ endpoint: "https://e", keys: { p256dh: "p", auth: "a" } });
    expect(repo.upsert).toHaveBeenCalledWith({ endpoint: "https://e", p256dh: "p", auth: "a" });
    await noKey.unsubscribe("https://e");
    expect(repo.remove).toHaveBeenCalledWith("https://e");
  });

  it("routes push endpoints through the HTTP layer", async () => {
    const { service } = setup({ "https://a": { ok: true } });
    const app = buildTestApp({ push: service });
    expect((await request(app).post("/api/v1/push/test").set(auth)).body).toEqual({ sent: 1, failed: 0, pruned: 0 });
    expect((await request(app).get("/api/v1/push/vapid-public-key").set(auth)).body).toEqual({ enabled: true, publicKey: "BPK" });
  });
});

describe("health check", () => {
  it("reports up with latency, down on error, and down when the ping hangs past the timeout", async () => {
    expect(await createHealthService({ ping: async () => {} }).check()).toMatchObject({ ok: true, db: "up", latencyMs: expect.any(Number) });
    expect(await createHealthService({ ping: async () => Promise.reject(new Error("refused")) }).check()).toMatchObject({ ok: false, db: "down", latencyMs: null });
    const started = Date.now();
    const hung = await createHealthService({ ping: () => new Promise(() => {}), timeoutMs: 30 }).check();
    expect(hung).toMatchObject({ ok: false, db: "down" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("alert rules and alerts service edges", () => {
  function repo(overrides: Partial<AlertRepository> = {}): AlertRepository {
    return {
      listRules: async () => [],
      getRule: async () => null,
      insertRule: async (name, definition) => ({ id: "r", name, enabled: true, definition, createdAt: new Date(0) }),
      updateRule: async () => null,
      deleteRule: async () => false,
      listAlerts: async () => [],
      markAlertRead: async () => false,
      listHoldings: async () => [
        { symbol: "HDFCBANK", statementFamily: "banking" },
        { symbol: "TCS", statementFamily: "industrial" },
      ],
      existingSymbols: async () => [],
      allSymbols: async () => [],
      priceSeries: async () => new Map(),
      bonusSplitDates: async () => new Map(),
      categoryFilings: async () => [],
      ...overrides,
    };
  }
  const parser = (definition: unknown) => ({ parse: () => definition as never, explain: () => "Rule." });

  it("resolves statement-family scopes from holdings and explains empty replays", async () => {
    const def = { type: "price_move", scope: { kind: "statement_family", family: "nbfc" }, direction: "up", thresholdPct: 3 };
    const preview = await createAlertRuleService({ repo: repo(), parser: parser(def) }).preview("nbfc moves 3%");
    expect(preview.resolvedSymbols).toEqual([]);
    expect(preview.backtest).toEqual({ sessions: 0, fires: 0, bySymbol: [], note: "No matching companies to replay." });
    expect(preview.explanation).toBe("Rule. No matching companies to replay.");

    const banks = await createAlertRuleService({ repo: repo(), parser: parser({ ...def, scope: { kind: "statement_family", family: "banking" } }) }).preview("banks");
    expect(banks.resolvedSymbols).toEqual(["HDFCBANK"]);
    expect(banks.backtest?.note).toBe("No price history yet, so there is nothing to replay.");
  });

  it("treats a parser result that fails the schema as unparsed", async () => {
    const preview = await createAlertRuleService({ repo: repo(), parser: parser({ type: "price_move", thresholdPct: 99 }) }).preview("x moves 99%");
    expect(preview).toMatchObject({ definition: null, backtest: null });
  });

  it("explains a category rule with no matching filings", async () => {
    const def = { type: "category", scope: { kind: "portfolio" }, categories: ["dividend"] };
    const preview = await createAlertRuleService({ repo: repo(), parser: parser(def) }).preview("dividends");
    expect(preview.explanation).toBe("Rule. No matching filings in the last 30 sessions.");
  });

  it("hides invalid stored rules with a warning, and refuses to return an invalid insert", async () => {
    const log = { ...silentLog, warn: vi.fn() };
    const bad = { id: "bad", name: "x", enabled: true, definition: { type: "nope" }, createdAt: new Date() };
    const service = createAlertRuleService({ repo: repo({ listRules: async () => [bad], insertRule: async () => bad }), parser: parser(null), log });
    expect(await service.list()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith({ ruleId: "bad" }, expect.stringContaining("invalid"));
    await expect(service.create({ name: "x", definition: { type: "category", scope: { kind: "portfolio" }, categories: ["results"] } })).rejects.toThrow(
      "Inserted rule failed validation",
    );
  });

  it("404s on update/delete of missing rules and on marking a missing alert read", async () => {
    const service = createAlertRuleService({ repo: repo(), parser: parser(null) });
    await expect(service.update("x", { enabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(service.remove("x")).rejects.toMatchObject({ status: 404 });
    await expect(createAlertService(repo()).markRead("x")).rejects.toMatchObject({ status: 404 });
  });

  it("maps alert rows to the shared Alert shape", async () => {
    const createdAt = new Date("2026-11-15T04:00:00Z");
    const alerts = await createAlertService(
      repo({
        listAlerts: async () => [
          { id: "a", ruleId: "r", ruleName: "n", symbol: "TCS", kind: "category", title: "t", body: "b", sessionDate: null, announcementId: "s1", createdAt, readAt: null },
        ],
      }),
    ).list(5);
    expect(alerts).toEqual([
      { id: "a", ruleId: "r", ruleName: "n", symbol: "TCS", kind: "category", title: "t", body: "b", sessionDate: null, announcementId: "s1", createdAt: createdAt.toISOString(), readAt: null },
    ]);
  });

  it("rejects thresholds outside the rule type's range", () => {
    expect(() => withThreshold({ type: "volume_spike", scope: { kind: "portfolio" }, multiple: 2 }, 11)).toThrow();
  });

  it("summarises long and singular replays", () => {
    const bySymbol = ["A", "B", "C", "D"].map((symbol) => ({ symbol, fires: 1, lastFiredOn: null }));
    expect(describeBacktest({ sessions: 1, fires: 4, bySymbol, note: null })).toBe("It would have fired 4 times in the last 1 session (A, B, C, …).");
    expect(describeBacktest({ sessions: 30, fires: 1, bySymbol: [bySymbol[0]!], note: null })).toBe("It would have fired 1 time in the last 30 sessions (A).");
    expect(describeBacktest({ sessions: 0, fires: 0, bySymbol: [], note: null })).toBe("No history to replay yet.");
  });
});

describe("holdings read model", () => {
  it("returns nulls without prices and uses the stored 20-day average when present", () => {
    expect(toHolding({ symbol: "X", name: "X", statementFamily: null, unreadCount: 0, researchReady: false, prices: [] })).toMatchObject({
      close: null,
      changePct: null,
      volume: null,
      volumeVsAvg: null,
      sessionDate: null,
      sparkline: [],
    });
    const prices = [
      { sessionDate: "2026-11-12", close: 100, prevClose: null, volume: 10, avg20Volume: null },
      { sessionDate: "2026-11-13", close: 103, prevClose: null, volume: 300, avg20Volume: 100 },
    ];
    expect(toHolding({ symbol: "X", name: "X", statementFamily: "banking", unreadCount: 2, researchReady: true, prices })).toMatchObject({
      close: 103,
      changePct: 3,
      volumeVsAvg: 3,
      statementFamily: "banking",
    });
    expect(volumeVsAverage([{ sessionDate: "d", close: 1, prevClose: null, volume: 5, avg20Volume: 0 }], 0)).toBeNull();
    expect(volumeVsAverage([], 0)).toBeNull();
  });
});

describe("small helpers", () => {
  it("coerces database numbers", () => {
    expect([num(null), num(undefined), num("12.5"), num(BigInt(7)), num("abc"), num(Infinity), num(3)]).toEqual([null, null, 12.5, 7, null, null, 3]);
    expect(round(1.23456, 3)).toBe(1.235);
    expect(clamp(5, 0, 1)).toBe(1);
  });

  it("formats timestamps defensively", () => {
    expect(toIso("not a date")).toBeNull();
    expect(toIso(null)).toBeNull();
    expect(toIso("2026-11-15T00:00:00Z")).toBe("2026-11-15T00:00:00.000Z");
    expect(toIsoRequired("garbage")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("ignores unsafe or negative Last-Event-ID values", () => {
    expect(parseLastEventId(" 12 ", undefined)).toBe(12);
    expect(parseLastEventId("99999999999999999999", undefined)).toBe(0);
    expect(parseLastEventId(undefined, -4)).toBe(0);
  });

  it("does not open a poll loop when the server is already shutting down", async () => {
    const controller = new AbortController();
    controller.abort();
    const listAfter = vi.fn(async () => []);
    const res = { status: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn(), writableEnded: false };
    const req = { socket: { setNoDelay: vi.fn(), setKeepAlive: vi.fn() } };
    await streamResearchEvents(req as never, res as never, {
      source: { listAfter, runStatus: async () => "queued" },
      runId: "r",
      lastEventId: 0,
      options: { pollMs: 10, heartbeatMs: 10, maxDurationMs: 100, retryMs: 10 },
      log: silentLog,
      signal: controller.signal,
    });
    expect(listAfter).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });

  it("sends mismatching bodies in warn mode even without a request logger, and skips checks when unset", () => {
    const json = vi.fn();
    const res = { app: { locals: { responseValidation: "warn" } }, req: {}, status: vi.fn(() => ({ json })) };
    sendJson(res as never, { safeParse: () => ({ success: false, error: { issues: [] } }) } as never, {} as never);
    expect(json).toHaveBeenCalledWith({});
    const unset = { app: { locals: {} }, req: {}, status: vi.fn(() => ({ json })) };
    sendJson(unset as never, { safeParse: () => { throw new Error("should not validate"); } } as never, { a: 1 } as never, 201);
    expect(unset.status).toHaveBeenCalledWith(201);
  });
});
