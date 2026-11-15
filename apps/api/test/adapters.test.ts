import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { Sql } from "@finn/db";
import { BudgetExceededError, LlmUnavailableError } from "@finn/ai/llm/client";
import { answerQuestion } from "@finn/ai/ask/answer";
import { WebPushError, sendNotification } from "web-push";
import { loadAskEngine, loadRuleParser, loadWeightLearner } from "../src/adapters/agentModules";
import { createWebPushSender } from "../src/adapters/webPush";
import { createGithubDispatcher, createNoopDispatcher } from "../src/adapters/workerDispatcher";
import { loadConfig, toAppConfig } from "../src/config";
import { buildContainer } from "../src/container";
import { HttpError } from "../src/http/errors";
import { REDACT_PATHS, silentLogger } from "../src/lib/logger";
import { JOBS_SECRET } from "./helpers";

vi.mock("@finn/ai/ask/answer", () => ({ answerQuestion: vi.fn() }));
vi.mock("web-push", () => {
  class WebPushError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  }
  return { WebPushError, sendNotification: vi.fn() };
});

const BASE_ENV = { DATABASE_URL: "postgres://finn:finn@localhost:54329/finn", JOBS_SECRET };
const fakeSql = {} as Sql;
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

beforeEach(() => {
  vi.mocked(answerQuestion).mockReset();
  vi.mocked(sendNotification).mockReset();
});

describe("Ask engine adapter (@finn/ai, no network)", () => {
  const withCredentials = loadConfig({
    ...BASE_ENV,
    LLM_API_KEY: "sk-test",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_API_TOKEN: "cf-token",
  });
  const req = { symbol: "TCS", question: "Margin guidance?" };

  it("passes answers through from answerQuestion with the wired llm and embedding clients", async () => {
    const answer = { answer: [], insufficientSources: true };
    vi.mocked(answerQuestion).mockResolvedValue(answer);
    const engine = await loadAskEngine(withCredentials, fakeSql, log());
    expect(await engine.answer(req)).toBe(answer);
    const [deps, passed] = vi.mocked(answerQuestion).mock.calls[0]!;
    expect(passed).toEqual(req);
    expect(deps).toMatchObject({ sql: fakeSql, llm: expect.any(Object), embeddings: expect.any(Object) });
  });

  it("maps BudgetExceededError to 429 llm_budget_exhausted and LlmUnavailableError to 503 llm_unavailable", async () => {
    const engine = await loadAskEngine(withCredentials, fakeSql, log());
    vi.mocked(answerQuestion).mockRejectedValueOnce(new BudgetExceededError(2000, 2000));
    await expect(engine.answer(req)).rejects.toMatchObject({ status: 429, code: "llm_budget_exhausted" });
    vi.mocked(answerQuestion).mockRejectedValueOnce(new LlmUnavailableError());
    await expect(engine.answer(req)).rejects.toMatchObject({ status: 503, code: "llm_unavailable" });
    const other = new Error("retrieval failed");
    vi.mocked(answerQuestion).mockRejectedValueOnce(other);
    await expect(engine.answer(req)).rejects.toBe(other);
  });

  it.each([["LLM_API_KEY"], ["CLOUDFLARE_ACCOUNT_ID"], ["CLOUDFLARE_API_TOKEN"]])("disables Ask with 503 ask_unavailable when %s is missing", async (missing) => {
    const env: Record<string, string> = { ...BASE_ENV, LLM_API_KEY: "sk", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" };
    delete env[missing];
    const logger = log();
    const engine = await loadAskEngine(loadConfig(env), fakeSql, logger);
    await expect(engine.answer(req)).rejects.toMatchObject({ status: 503, code: "ask_unavailable" });
    await expect(engine.answer(req)).rejects.toBeInstanceOf(HttpError);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Ask disabled"));
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});

describe("domain adapters (@finn/domain)", () => {
  it("parses rule text against known symbols and explains it", async () => {
    const parser = await loadRuleParser(log());
    const def = parser.parse("alert me if TCS falls more than 4%", { isKnownSymbol: (s) => s === "TCS" });
    expect(def).toEqual({ type: "price_move", scope: { kind: "symbols", symbols: ["TCS"] }, direction: "down", thresholdPct: 4 });
    expect(parser.explain(def!)).toEqual(expect.any(String));
    expect(parser.explain(def!).length).toBeGreaterThan(0);
  });

  it("learns weights inside USER_WEIGHT_RANGE", async () => {
    const learner = await loadWeightLearner(log());
    expect(learner.adjust(1, "pin")).toBe(1.1);
    expect(learner.adjust(1.6, "pin")).toBe(1.6);
    expect(learner.adjust(0.4, "dismiss")).toBe(0.4);
  });
});

describe("web-push sender", () => {
  const vapid = { subject: "mailto:a@b.c", publicKey: "BPK", privateKey: "priv" };
  const sub = { endpoint: "https://push.example/1", p256dh: "p256", auth: "auth" };

  it("sends the JSON payload with VAPID details, a TTL and a timeout", async () => {
    vi.mocked(sendNotification).mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    expect(await createWebPushSender(vapid).send(sub, { title: "FINN" })).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledWith({ endpoint: sub.endpoint, keys: { p256dh: "p256", auth: "auth" } }, '{"title":"FINN"}', {
      vapidDetails: vapid,
      TTL: 3600,
      timeout: 10_000,
    });
  });

  it.each([
    [404, true],
    [410, true],
    [429, false],
    [500, false],
  ])("treats a %s from the push service as gone=%s", async (status, gone) => {
    vi.mocked(sendNotification).mockRejectedValue(new (WebPushError as unknown as new (m: string, s: number) => Error)("push failed", status));
    expect(await createWebPushSender(vapid).send(sub, {})).toEqual({ ok: false, gone, error: `${status}: push failed` });
  });

  it("reports network errors without a status and truncates long messages", async () => {
    vi.mocked(sendNotification).mockRejectedValue(new Error("x".repeat(500)));
    const result = await createWebPushSender(vapid).send(sub, {});
    expect(result).toMatchObject({ ok: false, gone: false });
    expect((result as { error: string }).error.startsWith("network: xxx")).toBe(true);
    expect((result as { error: string }).error).toHaveLength(300);
    vi.mocked(sendNotification).mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    expect(await createWebPushSender(vapid).send(sub, {})).toMatchObject({ gone: true });
  });
});

describe("worker dispatchers", () => {
  it("wraps network failures in a DispatchError with no status, and sends the configured ref", async () => {
    const failing = createGithubDispatcher({ token: "t", repo: "o/r", workflow: "research.yml", fetch: (async () => Promise.reject(new Error("ECONNRESET"))) as never });
    await expect(failing.dispatchResearch({ symbol: "TCS", runId: "r" })).rejects.toMatchObject({
      name: "DispatchError",
      status: null,
      message: "GitHub dispatch request failed: ECONNRESET",
    });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await createGithubDispatcher({ token: "t", repo: "o/r", workflow: "deep research.yml", ref: "release", fetch: fetchMock as never }).dispatchResearch({ symbol: "TCS", runId: "r" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/actions/workflows/deep%20research.yml/dispatches");
    expect(JSON.parse(String(init.body)).ref).toBe("release");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps a 4xx/5xx message even when the error body cannot be read", async () => {
    const res = { status: 500, text: () => Promise.reject(new Error("stream broke")) };
    const dispatcher = createGithubDispatcher({ token: "t", repo: "o/r", workflow: "w", fetch: (async () => res) as never });
    await expect(dispatcher.dispatchResearch({ symbol: "TCS", runId: "r" })).rejects.toMatchObject({ status: 500, message: "GitHub dispatch returned 500: " });
  });

  it("the no-op dispatcher only logs", async () => {
    const logger = log();
    const d = createNoopDispatcher(logger);
    expect(d.kind).toBe("noop");
    await d.dispatchResearch({ symbol: "TCS", runId: "r" });
    expect(logger.warn).toHaveBeenCalledWith({ symbol: "TCS", runId: "r" }, expect.any(String));
  });
});

describe("configuration", () => {
  it("applies defaults for a minimal environment", () => {
    const config = loadConfig(BASE_ENV);
    expect(config).toMatchObject({
      NODE_ENV: "development",
      PORT: 4000,
      RESEARCH_RUNS_PER_DAY: 40,
      ASK_RATE_LIMIT_PER_MIN: 6,
      RATE_LIMIT_PER_MIN: 120,
      LLM_DAILY_CALL_BUDGET: 2000,
      GITHUB_REPO: "Sudarshan50/enam-assignment",
    });
    expect(config.LLM_API_KEY).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, LLM_API_KEY: "   " }).LLM_API_KEY).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, LLM_API_KEY: " sk-1 " }).LLM_API_KEY).toBe("sk-1");
  });

  it("lists every invalid variable without echoing secret values", () => {
    const attempt = () => loadConfig({ DATABASE_URL: "", JOBS_SECRET: "x", PORT: "70000", GITHUB_REPO: "not a repo" });
    expect(attempt).toThrow(/^Invalid API environment:/);
    let message = "";
    try {
      attempt();
    } catch (err) {
      message = (err as Error).message;
    }
    for (const key of ["DATABASE_URL", "JOBS_SECRET", "PORT", "GITHUB_REPO"]) expect(message).toContain(`  ${key}:`);
  });

  it("derives the app config: origins, trust proxy, validation mode, limits", () => {
    const app = toAppConfig(loadConfig({ ...BASE_ENV, CORS_ORIGIN: "https://finn.app/, http://localhost:3000 ,", TRUST_PROXY: "2", ASK_RATE_LIMIT_PER_MIN: "3" }));
    expect(app.corsOrigins).toEqual(["https://finn.app", "http://localhost:3000"]);
    expect(app.trustProxy).toBe(2);
    expect(app.jsonLimit).toBe("32kb");
    expect(app.isProduction).toBe(false);
    expect(app.responseValidation).toBe("warn");
    expect(app.rateLimits).toEqual({
      global: { windowMs: 60_000, limit: 120 },
      ask: { windowMs: 60_000, limit: 3 },
      research: { windowMs: 60_000, limit: 10 },
    });
    expect(toAppConfig(loadConfig({ ...BASE_ENV, TRUST_PROXY: "true" })).trustProxy).toBe(true);
    expect(toAppConfig(loadConfig({ ...BASE_ENV, TRUST_PROXY: "false" })).trustProxy).toBe(false);
    expect(toAppConfig(loadConfig({ ...BASE_ENV, TRUST_PROXY: "loopback" })).trustProxy).toBe("loopback");
    expect(toAppConfig(loadConfig({ ...BASE_ENV, NODE_ENV: "production" }))).toMatchObject({ isProduction: true, responseValidation: "off" });
    expect(toAppConfig(loadConfig({ ...BASE_ENV, NODE_ENV: "test" })).responseValidation).toBe("strict");
    expect(toAppConfig(loadConfig({ ...BASE_ENV, NODE_ENV: "production", RESPONSE_VALIDATION: "warn" })).responseValidation).toBe("warn");
  });

  it("redacts the cookie, authorization, access header and Set-Cookie", () => {
    expect(REDACT_PATHS).toEqual(["req.headers.cookie", "req.headers.authorization", 'req.headers["x-finn-access"]', 'res.headers["set-cookie"]']);
    expect(() => silentLogger.info("x")).not.toThrow();
  });
});

describe("container wiring", () => {
  it("picks the GitHub dispatcher and web-push sender when their secrets are set, and closes its own pool", async () => {
    const lines: Record<string, unknown>[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const config = loadConfig({
      ...BASE_ENV,
      NODE_ENV: "test",
      GITHUB_DISPATCH_TOKEN: "ghp_x",
      VAPID_PUBLIC_KEY: "BPK",
      VAPID_PRIVATE_KEY: "priv",
    });
    // No `sql` option: the container creates the shared pool lazily and must close it.
    const container = await buildContainer(config, { logger: pino({ level: "info" }, sink) });
    await new Promise((r) => setImmediate(r));
    expect(lines.find((l) => l.msg === "container ready")).toMatchObject({ dispatcher: "github", push: true, responseValidation: "strict" });
    expect(container.deps.services.push.publicKey()).toEqual({ enabled: true, publicKey: "BPK" });
    expect(container.deps.services.jobs.list().map((j) => j.name)).toEqual(["dispatch-research", "prune-llm-cache"]);
    await container.close();
  });

  it("falls back to the no-op dispatcher and no push without those secrets", async () => {
    const lines: Record<string, unknown>[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const container = await buildContainer(loadConfig({ ...BASE_ENV, NODE_ENV: "test" }), { logger: pino({ level: "info" }, sink), sql: fakeSql });
    await new Promise((r) => setImmediate(r));
    expect(lines.find((l) => l.msg === "container ready")).toMatchObject({ dispatcher: "noop", push: false });
    expect(container.deps.services.push.publicKey().enabled).toBe(false);
    await container.close();
  });
});
