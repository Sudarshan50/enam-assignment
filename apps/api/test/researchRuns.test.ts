import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ResearchRunSchema } from "@finn/shared";
import { DispatchError, type WorkerDispatcher, createGithubDispatcher } from "../src/adapters/workerDispatcher";
import { type ResearchRepository, type RunRecord, createResearchService } from "../src/services/researchService";
import { auth, buildTestApp, silentLog } from "./helpers";

const NOW = new Date("2026-11-15T08:00:00Z");
const DAY = 24 * 3600_000;

function run(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: randomUUID(),
    symbol: "CDSL",
    status: "completed",
    modules: ["promise_ledger", "bull_bear"],
    createdAt: new Date(NOW.getTime() - DAY),
    updatedAt: new Date(NOW.getTime() - DAY),
    dispatchAttempts: 1,
    ...partial,
  };
}

/** In-memory repository honouring the same semantics as the SQL one. */
function fakeRepo(seed: { runs?: RunRecord[]; createdToday?: number; insertConflict?: RunRecord } = {}) {
  const runs = [...(seed.runs ?? [])];
  const events: { runId: string; type: string }[] = [];
  const ACTIVE = ["queued", "processing_docs", "synthesizing"];
  const repo: ResearchRepository = {
    findCompany: async (symbol) => (["CDSL", "TCS"].includes(symbol) ? { symbol, name: `${symbol} Ltd` } : null),
    findLatestCompleted: async (symbol, since) =>
      runs.filter((r) => r.symbol === symbol && r.status === "completed" && r.createdAt >= since).at(-1) ?? null,
    findActive: async (symbol) => runs.find((r) => r.symbol === symbol && ACTIVE.includes(r.status)) ?? null,
    countCreatedSince: async () => seed.createdToday ?? 0,
    insertQueued: vi.fn(async ({ symbol, modules }) => {
      if (seed.insertConflict) {
        runs.push(seed.insertConflict);
        return null;
      }
      const r = run({ symbol, modules, status: "queued", createdAt: NOW, updatedAt: NOW, dispatchAttempts: 0 });
      runs.push(r);
      return r;
    }),
    appendEvent: vi.fn(async (runId, type) => {
      events.push({ runId, type });
    }),
    markDispatched: vi.fn(async () => {}),
    recordDispatchFailure: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    getRun: async (id) => {
      const r = runs.find((x) => x.id === id);
      return r ? { ...r, companyName: `${r.symbol} Ltd` } : null;
    },
    findLatestRun: async (symbol) => runs.filter((r) => r.symbol === symbol).at(-1) ?? null,
    listModules: async () => [{ module: "bull_bear", status: "done", payload: { bull: [], bear: [] }, error: null, updatedAt: NOW }],
    listDocuments: async () => [{ id: "d1", docType: "annual_report", periodLabel: "FY26", status: "ready", pages: 210, url: "https://x/ar.pdf" }],
    listPromises: async () => [],
    listStaleQueued: async () => runs.filter((r) => r.status === "queued"),
  };
  return { repo, runs, events };
}

function fakeDispatcher(fail = false): WorkerDispatcher & { dispatchResearch: ReturnType<typeof vi.fn> } {
  return {
    kind: "github",
    dispatchResearch: vi.fn(async () => {
      if (fail) throw new DispatchError("GitHub dispatch returned 401", 401);
    }),
  };
}

function setup(seed: Parameters<typeof fakeRepo>[0] = {}, opts: { runsPerDay?: number; failDispatch?: boolean } = {}) {
  const store = fakeRepo(seed);
  const dispatcher = fakeDispatcher(opts.failDispatch);
  const research = createResearchService({ repo: store.repo, dispatcher, runsPerDay: opts.runsPerDay ?? 5, now: () => NOW, log: silentLog });
  const app = buildTestApp({ research });
  return { ...store, dispatcher, research, app };
}

describe("POST /api/v1/research-runs", () => {
  it("404s for a symbol that is not in companies", async () => {
    const { app, dispatcher } = setup();
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "NOPE" });
    expect(res.status).toBe(404);
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
  });

  it("returns a completed run under 7 days old as cached, without dispatching", async () => {
    const recent = run({ createdAt: new Date(NOW.getTime() - 2 * DAY) });
    const { app, dispatcher } = setup({ runs: [recent] });
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "cdsl" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: recent.id, status: "completed", cached: true });
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
  });

  it("returns the active run instead of starting another", async () => {
    const active = run({ status: "processing_docs", createdAt: NOW });
    const { app, dispatcher, repo } = setup({ runs: [active] });
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "CDSL" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: active.id, status: "processing_docs", cached: false });
    expect(repo.insertQueued).not.toHaveBeenCalled();
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
  });

  it("queues a new run, records an event and dispatches the worker exactly once", async () => {
    const stale = run({ createdAt: new Date(NOW.getTime() - 8 * DAY) });
    const { app, dispatcher, repo, events } = setup({ runs: [stale] });
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "CDSL" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.cached).toBe(false);
    expect(res.body.runId).not.toBe(stale.id);
    expect(dispatcher.dispatchResearch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchResearch).toHaveBeenCalledWith({ symbol: "CDSL", runId: res.body.runId });
    expect(repo.markDispatched).toHaveBeenCalledWith(res.body.runId);
    expect(events).toEqual([{ runId: res.body.runId, type: "run.queued" }]);
  });

  it("returns the winner when another request inserted the active run first", async () => {
    const winner = run({ symbol: "TCS", status: "queued", createdAt: NOW });
    const { app, dispatcher } = setup({ insertConflict: winner });
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "TCS" });
    expect(res.status).toBe(202);
    expect(res.body.runId).toBe(winner.id);
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
  });

  it("enforces the daily limit with 429", async () => {
    const { app, dispatcher } = setup({ createdToday: 5 }, { runsPerDay: 5 });
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "TCS" });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("research_limit_reached");
    expect(dispatcher.dispatchResearch).not.toHaveBeenCalled();
  });

  it("still accepts the run when dispatch fails, leaving it for the retry job", async () => {
    const { app, repo } = setup({}, { failDispatch: true });
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "TCS" });
    expect(res.status).toBe(202);
    expect(repo.recordDispatchFailure).toHaveBeenCalledWith(res.body.runId, expect.stringContaining("401"));
  });
});

describe("GET /api/v1/research-runs/:id", () => {
  it("returns the shared ResearchRun shape with pending placeholders for unstarted modules", async () => {
    const r = run();
    const { app } = setup({ runs: [r] });
    const res = await request(app).get(`/api/v1/research-runs/${r.id}`).set(auth);
    expect(res.status).toBe(200);
    const body = ResearchRunSchema.parse(res.body);
    expect(body.modules.map((m) => [m.key, m.status])).toEqual([
      ["promise_ledger", "pending"],
      ["bull_bear", "done"],
    ]);
    expect(body.documents[0]!.label).toBe("annual report FY26");
  });

  it("404s for an unknown run", async () => {
    const { app } = setup();
    expect((await request(app).get(`/api/v1/research-runs/${randomUUID()}`).set(auth)).status).toBe(404);
  });
});

describe("re-dispatching stale queued runs", () => {
  it("re-dispatches under the attempt cap and fails runs past it", async () => {
    const fresh = run({ status: "queued", symbol: "TCS", dispatchAttempts: 1 });
    const exhausted = run({ status: "queued", symbol: "CDSL", dispatchAttempts: 3 });
    const { research, dispatcher, repo } = setup({ runs: [fresh, exhausted] });
    const result = await research.redispatchStale();
    expect(result).toEqual({ redispatched: 1, failed: 0, givenUp: 1 });
    expect(dispatcher.dispatchResearch).toHaveBeenCalledWith({ symbol: "TCS", runId: fresh.id });
    expect(repo.markFailed).toHaveBeenCalledWith(exhausted.id, expect.stringContaining("3 dispatch attempts"));
  });
});

describe("GitHub workflow dispatcher", () => {
  it("posts workflow_dispatch with the required headers and inputs", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const dispatcher = createGithubDispatcher({ token: "ghp_test", repo: "owner/repo", workflow: "research.yml", fetch: fetchMock as never });
    await dispatcher.dispatchResearch({ symbol: "CDSL", runId: "run-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/actions/workflows/research.yml/dispatches");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer ghp_test",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(JSON.parse(String(init.body))).toEqual({ ref: "main", inputs: { symbol: "CDSL", run_id: "run-1" } });
  });

  it("throws a DispatchError on anything but 204", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
    const dispatcher = createGithubDispatcher({ token: "x", repo: "o/r", workflow: "research.yml", fetch: fetchMock as never });
    await expect(dispatcher.dispatchResearch({ symbol: "TCS", runId: "r" })).rejects.toMatchObject({ name: "DispatchError", status: 401 });
  });
});
