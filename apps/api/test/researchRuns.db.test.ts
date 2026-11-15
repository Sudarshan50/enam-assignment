import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@finn/db";
import { MODULE_KEYS, ResearchRunSchema } from "@finn/shared";
import { StartRunResponseSchema } from "../../web/src/lib/api/schemas";
import { CompanyResearchSchema, CreateResearchRunResponseSchema } from "../src/contracts";
import type { ResearchRepository } from "../src/services/researchService";
import { JOBS_SECRET, TOKEN, auth } from "./helpers";
import { buildDbApp, cleanupPrefix, dbReachable, expectParse, fakeDispatcher, insertCompany } from "./support/db";

const dbUp = await dbReachable();
const P = "ZTPR";
const MINUTE = 60_000;

interface RunRow {
  status: string;
  dispatchAttempts: number;
  error: string | null;
  dispatchedAt: Date | null;
  requestedBy: string | null;
}

describe.skipIf(!dbUp)("research runs against the local database", async () => {
  if (!dbUp) return it.skip("needs the local database", () => {});
  const sql = getDb();

  const runRow = async (id: string) =>
    (
      await sql<RunRow[]>`
        SELECT status, dispatch_attempts AS "dispatchAttempts", error, dispatched_at AS "dispatchedAt", requested_by AS "requestedBy"
        FROM research_runs WHERE id = ${id}`
    )[0];
  const runsFor = (symbol: string) => sql<{ id: string; status: string }[]>`SELECT id, status FROM research_runs WHERE symbol = ${symbol}`;
  const post = (app: Parameters<typeof request>[0], symbol: string) => request(app).post("/api/v1/research-runs").set(auth).send({ symbol });

  beforeAll(async () => {
    await cleanupPrefix(sql, P);
    for (const s of ["NEW", "RACE", "CACHE", "OLD", "DEAD", "FAIL", "QUOTA", "Q"]) await insertCompany(sql, `${P}${s}`);
  });

  afterAll(async () => {
    await cleanupPrefix(sql, P);
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM research_runs WHERE symbol LIKE ${`${P}%`}`;
    expect(left!.n).toBe(0);
    await closeDb();
  });

  it("404s for a symbol that is not in companies and never dispatches", async () => {
    const { app, dispatcher } = await buildDbApp(sql);
    const res = await post(app, `${P}NONE`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "not_found", message: `Company ${P}NONE not found` });
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
    expect(await runsFor(`${P}NONE`)).toHaveLength(0);
  });

  it("queues a new run: 202, one dispatch with {symbol, runId}, a run.queued event, and the active run on repeat", async () => {
    const { app, dispatcher } = await buildDbApp(sql);
    const res = await post(app, `${P.toLowerCase()}new`);
    expect(res.status).toBe(202);
    const body = expectParse(CreateResearchRunResponseSchema, res.body, "create run");
    expectParse(StartRunResponseSchema, res.body, "web start run");
    expect(body).toMatchObject({ status: "queued", cached: false });
    expect(dispatcher.dispatchResearch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchResearch).toHaveBeenCalledWith({ symbol: `${P}NEW`, runId: body.runId });

    const row = await runRow(body.runId);
    expect(row).toMatchObject({ status: "queued", dispatchAttempts: 1, error: null });
    expect(row!.dispatchedAt).toBeInstanceOf(Date);
    expect(row!.requestedBy).toBeTruthy();

    const events = await sql<{ type: string; data: { symbol: string; modules: string[] } }[]>`
      SELECT type, data FROM research_events WHERE run_id = ${body.runId} ORDER BY id`;
    expect(events).toEqual([{ type: "run.queued", data: { symbol: `${P}NEW`, modules: [...MODULE_KEYS] } }]);

    const again = await post(app, `${P}NEW`);
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ runId: body.runId, status: "queued", cached: false });
    expect(dispatcher.dispatchResearch).toHaveBeenCalledTimes(1);

    const run = await request(app).get(`/api/v1/research-runs/${body.runId}`).set(auth);
    expect(run.status).toBe(200);
    const parsed = expectParse(ResearchRunSchema, run.body, "run");
    expect(parsed).toMatchObject({ id: body.runId, symbol: `${P}NEW`, companyName: `${P}NEW Test Ltd`, status: "queued", documents: [] });
    expect(parsed.modules.map((m) => [m.key, m.status])).toEqual(MODULE_KEYS.map((k) => [k, "pending"]));

    const page = await request(app).get(`/api/v1/companies/${P}NEW/research`).set(auth);
    const research = expectParse(CompanyResearchSchema, page.body, "company research");
    expect(research).toMatchObject({ symbol: `${P}NEW`, promiseLedger: null });
    expect(research.run?.id).toBe(body.runId);
  });

  it("only queues the requested modules, de-duplicated", async () => {
    await sql`DELETE FROM research_runs WHERE symbol = ${`${P}QUOTA`}`;
    const { app } = await buildDbApp(sql);
    const res = await request(app)
      .post("/api/v1/research-runs")
      .set(auth)
      .send({ symbol: `${P}QUOTA`, modules: ["bull_bear", "bull_bear", "promise_ledger"] });
    expect(res.status).toBe(202);
    const [row] = await sql<{ modules: string[] }[]>`SELECT modules FROM research_runs WHERE id = ${res.body.runId}`;
    expect(row!.modules).toEqual(["bull_bear", "promise_ledger"]);
    await sql`DELETE FROM research_runs WHERE symbol = ${`${P}QUOTA`}`;
  });

  it("concurrent POSTs for one symbol create one run (partial unique index) and dispatch once", async () => {
    const N = 6;
    let arrivals = 0;
    let release!: () => void;
    const allArrived = new Promise<void>((r) => (release = r));
    // Every request reads "no active run" before any of them inserts, so the index has to settle it.
    const wrapRepo = (repo: ResearchRepository): ResearchRepository => ({
      ...repo,
      async findActive(symbol) {
        const found = await repo.findActive(symbol);
        if (symbol === `${P}RACE` && arrivals < N) {
          if (++arrivals === N) release();
          await allArrived;
        }
        return found;
      },
    });
    const { app, dispatcher } = await buildDbApp(sql, { wrapRepo });
    const results = await Promise.all(Array.from({ length: N }, () => post(app, `${P}RACE`)));
    expect(results.map((r) => r.status)).toEqual(Array(N).fill(202));
    const ids = new Set(results.map((r) => r.body.runId));
    expect(ids.size).toBe(1);
    expect(await runsFor(`${P}RACE`)).toEqual([{ id: [...ids][0], status: "queued" }]);
    expect(dispatcher.dispatchResearch).toHaveBeenCalledTimes(1);
  });

  it("returns a completed run under 7 days old as cached (200) without dispatching", async () => {
    const [cached] = await sql<{ id: string }[]>`
      INSERT INTO research_runs (symbol, status, modules, created_at, updated_at)
      VALUES (${`${P}CACHE`}, 'completed', ${[...MODULE_KEYS]}::text[], now() - interval '2 days', now() - interval '2 days')
      RETURNING id`;
    const { app, dispatcher } = await buildDbApp(sql);
    const res = await post(app, `${P}CACHE`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: cached!.id, status: "completed", cached: true });
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
  });

  it("starts a fresh run when the last completed run is older than 7 days", async () => {
    const [old] = await sql<{ id: string }[]>`
      INSERT INTO research_runs (symbol, status, modules, created_at, updated_at)
      VALUES (${`${P}OLD`}, 'completed', ${[...MODULE_KEYS]}::text[], now() - interval '8 days', now() - interval '8 days')
      RETURNING id`;
    const { app, dispatcher } = await buildDbApp(sql);
    const res = await post(app, `${P}OLD`);
    expect(res.status).toBe(202);
    expect(res.body.runId).not.toBe(old!.id);
    expect(dispatcher.dispatchResearch).toHaveBeenCalledTimes(1);
  });

  it("shows a module's automatic retry, and stops serving a completed run from cache once that retry gives up", async () => {
    const symbol = `${P}DEAD`;
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO research_runs (symbol, status, modules, created_at, updated_at)
      VALUES (${symbol}, 'completed', ${["financial_snapshot", "bull_bear"]}::text[], now() - interval '1 day', now() - interval '1 day')
      RETURNING id`;
    await sql`
      INSERT INTO research_modules (run_id, module, status, payload, error) VALUES
        (${run!.id}, 'financial_snapshot', 'done', ${sql.json({ ok: true })}, null),
        (${run!.id}, 'bull_bear', 'failed', null, 'LlmTransportError: LLM HTTP 503')`;
    await sql`
      INSERT INTO module_retries (symbol, module, run_id, attempts, reason, next_attempt_at)
      VALUES (${symbol}, 'bull_bear', ${run!.id}, 2, 'LLM HTTP 503', '2026-11-15T07:00:00Z')`;
    const { app, dispatcher } = await buildDbApp(sql);

    const modules = async () => expectParse(ResearchRunSchema, (await request(app).get(`/api/v1/research-runs/${run!.id}`).set(auth)).body, "run").modules;
    const pending = await modules();
    expect(pending.find((m) => m.key === "bull_bear")).toMatchObject({ status: "failed", retry: { status: "pending", attempts: 2, nextAttemptAt: "2026-11-15T07:00:00.000Z" } });
    expect(pending.find((m) => m.key === "financial_snapshot")).not.toHaveProperty("retry");
    expect((await post(app, symbol)).body).toEqual({ runId: run!.id, status: "completed", cached: true });

    await sql`UPDATE module_retries SET status = 'dead', attempts = 5 WHERE run_id = ${run!.id}`;
    expect((await modules()).find((m) => m.key === "bull_bear")).toMatchObject({ retry: { status: "dead", attempts: 5, nextAttemptAt: null } });
    const fresh = await post(app, symbol);
    expect(fresh.status).toBe(202);
    expect(fresh.body.runId).not.toBe(run!.id);
    expect(dispatcher.dispatchResearch).toHaveBeenCalledTimes(1);
  });

  it("accepts the run (202) when dispatch fails; dispatch-research retries until 3 attempts, then fails the run", async () => {
    let offset = 0;
    const dispatcher = fakeDispatcher(true);
    // The stale-run scan is global; scope it to this test's symbol so other suites' runs are never touched.
    const wrapRepo = (repo: ResearchRepository): ResearchRepository => ({
      ...repo,
      listStaleQueued: async (before, limit) => (await repo.listStaleQueued(before, limit)).filter((r) => r.symbol === `${P}FAIL`),
    });
    const { app } = await buildDbApp(sql, { dispatcher, wrapRepo, clock: () => new Date(Date.now() + offset) });

    const res = await post(app, `${P}FAIL`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "queued", cached: false });
    const runId = res.body.runId as string;
    expect(await runRow(runId)).toMatchObject({ status: "queued", dispatchAttempts: 1, error: expect.stringContaining("503") });

    const bearer = { Authorization: `Bearer ${JOBS_SECRET}` };
    expect((await request(app).post("/api/v1/internal/jobs/dispatch-research").set(auth)).status).toBe(401);
    expect((await request(app).post("/api/v1/internal/jobs/dispatch-research").set("Authorization", `Bearer ${TOKEN}`)).status).toBe(401);

    // Not stale yet: it was dispatched moments ago.
    const early = await request(app).post("/api/v1/internal/jobs/dispatch-research").set(bearer);
    expect(early.body).toEqual({ job: "dispatch-research", ok: true, result: { redispatched: 0, failed: 0, givenUp: 0 } });

    const job = async (minutesLater: number) => {
      offset = minutesLater * MINUTE;
      const r = await request(app).post("/api/v1/internal/jobs/dispatch-research").set(bearer);
      expect(r.status).toBe(200);
      return r.body.result;
    };
    expect(await job(11)).toEqual({ redispatched: 0, failed: 1, givenUp: 0 });
    expect((await runRow(runId))!.dispatchAttempts).toBe(2);
    expect(await job(22)).toEqual({ redispatched: 0, failed: 1, givenUp: 0 });
    expect((await runRow(runId))!.dispatchAttempts).toBe(3);
    expect(await job(33)).toEqual({ redispatched: 0, failed: 0, givenUp: 1 });
    expect(await runRow(runId)).toMatchObject({ status: "failed", dispatchAttempts: 3, error: expect.stringContaining("3 dispatch attempts") });
    expect(dispatcher.dispatchResearch).toHaveBeenCalledTimes(3);

    const events = await sql<{ type: string }[]>`SELECT type FROM research_events WHERE run_id = ${runId} ORDER BY id`;
    expect(events.map((e) => e.type)).toEqual(["run.queued", "run.failed"]);
    expect(await job(44)).toEqual({ redispatched: 0, failed: 0, givenUp: 0 });
  });

  it("re-dispatches a stale run successfully once the worker can be reached", async () => {
    let offset = 0;
    const dispatcher = fakeDispatcher(true);
    const wrapRepo = (repo: ResearchRepository): ResearchRepository => ({
      ...repo,
      listStaleQueued: async (before, limit) => (await repo.listStaleQueued(before, limit)).filter((r) => r.symbol === `${P}Q`),
    });
    const { app } = await buildDbApp(sql, { dispatcher, wrapRepo, clock: () => new Date(Date.now() + offset) });
    const runId = (await post(app, `${P}Q`)).body.runId as string;
    dispatcher.fail = false;
    offset = 11 * MINUTE;
    const r = await request(app).post("/api/v1/internal/jobs/dispatch-research").set("Authorization", `Bearer ${JOBS_SECRET}`);
    expect(r.body.result).toEqual({ redispatched: 1, failed: 0, givenUp: 0 });
    expect(await runRow(runId)).toMatchObject({ status: "queued", dispatchAttempts: 2, error: null });
    await sql`DELETE FROM research_runs WHERE symbol = ${`${P}Q`}`;
  });

  it("enforces RESEARCH_RUNS_PER_DAY with 429 research_limit_reached and inserts nothing", async () => {
    const { app, dispatcher } = await buildDbApp(sql, { runsPerDay: 0 });
    const res = await post(app, `${P}QUOTA`);
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({ code: "research_limit_reached", message: expect.stringContaining("limit of 0") });
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
    expect(await runsFor(`${P}QUOTA`)).toHaveLength(0);
  });

  it("a burst of requests for different symbols never takes more runs than the daily limit allows", async () => {
    const symbols = ["BA", "BB", "BC", "BD", "BE", "BF"].map((s) => `${P}${s}`);
    for (const s of symbols) await insertCompany(sql, s);
    let arrivals = 0;
    let release!: () => void;
    const allArrived = new Promise<void>((r) => (release = r));
    // Counting from the burst's start keeps other suites' earlier runs (and their cleanup) out of the quota.
    const burstStart = new Date(Date.now() - 1000);
    const allowed = 2;
    // Every request passes the cache and active-run checks before any of them reaches the count + insert.
    const wrapRepo = (repo: ResearchRepository): ResearchRepository => ({
      ...repo,
      insertQueued: (args) => repo.insertQueued({ ...args, since: burstStart, dailyLimit: allowed }),
      async findActive(symbol) {
        const found = await repo.findActive(symbol);
        if (symbols.includes(symbol) && arrivals < symbols.length) {
          if (++arrivals === symbols.length) release();
          await allArrived;
        }
        return found;
      },
    });
    const { app } = await buildDbApp(sql, { runsPerDay: 1000, wrapRepo });

    const results = await Promise.all(symbols.map((s) => post(app, s)));
    const accepted = results.filter((r) => r.status === 202);
    const refused = results.filter((r) => r.status === 429);
    expect(accepted.length + refused.length).toBe(symbols.length);
    expect(refused.every((r) => r.body.error.code === "research_limit_reached")).toBe(true);
    // Other suites may insert runs meanwhile, which can only leave fewer slots for this burst.
    expect(accepted.length).toBeLessThanOrEqual(allowed);
    const [created] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM research_runs WHERE symbol = ANY(${symbols}::text[])`;
    expect(created!.n).toBe(accepted.length);
    await sql`DELETE FROM research_runs WHERE symbol = ANY(${symbols}::text[])`;
  });

  it("counts the daily quota from midnight IST, not UTC", async () => {
    // A far-future day nobody else writes to: one run a millisecond before IST midnight, one at midnight.
    await sql`
      INSERT INTO research_runs (symbol, status, modules, created_at, updated_at) VALUES
        (${`${P}Q`}, 'failed', '{}'::text[], '2163-03-13T18:29:59.999Z', '2163-03-13T18:29:59.999Z'),
        (${`${P}Q`}, 'failed', '{}'::text[], '2163-03-13T18:30:00.000Z', '2163-03-13T18:30:00.000Z')`;
    const clock = () => new Date("2163-03-14T05:00:00Z"); // 10:30 IST on 14 March
    const one = await buildDbApp(sql, { runsPerDay: 1, clock });
    expect((await post(one.app, `${P}Q`)).status).toBe(429);

    const two = await buildDbApp(sql, { runsPerDay: 2, clock });
    const res = await post(two.app, `${P}Q`);
    expect(res.status).toBe(202);
    expect(two.dispatcher.dispatchResearch).toHaveBeenCalledTimes(1);
    await sql`DELETE FROM research_runs WHERE symbol = ${`${P}Q`}`;
  });

  it("serves a run whose company row is gone, skipping unknown module rows", async () => {
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO research_runs (symbol, status, modules) VALUES (${`${P}GHOST`}, 'synthesizing', ARRAY['bull_bear','cash_quality'])
      RETURNING id`;
    await sql`
      INSERT INTO research_modules (run_id, module, status, payload) VALUES
        (${run!.id}, 'bull_bear', 'done', ${sql.json({ bull: [], bear: [] })}),
        (${run!.id}, 'legacy_module', 'done', NULL)`;
    const { app } = await buildDbApp(sql);
    const res = await request(app).get(`/api/v1/research-runs/${run!.id}`).set(auth);
    const parsed = expectParse(ResearchRunSchema, res.body, "ghost run");
    expect(parsed.companyName).toBeNull();
    expect(parsed.modules.map((m) => [m.key, m.status])).toEqual([
      ["cash_quality", "pending"],
      ["bull_bear", "done"],
    ]);
    expect((await request(app).get(`/api/v1/research-runs/${randomUUID()}`).set(auth)).status).toBe(404);
    expect((await request(app).get(`/api/v1/companies/${P}GHOST/research`).set(auth)).status).toBe(404);
  });
});
