import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { createApp } from "../src/app";
import { loadConfig, toAppConfig } from "../src/config";
import type { AppServices } from "../src/deps";
import { HttpError, badRequest } from "../src/http/errors";
import { createLogger } from "../src/lib/logger";
import { safeEqual } from "../src/middleware/auth";
import { errorHandler, toErrorResponse } from "../src/middleware/errors";
import { createAskService } from "../src/services/askService";
import { JobRegistry } from "../src/services/jobs";
import { JOBS_SECRET, TOKEN, auth, buildTestApp, testConfig } from "./helpers";

/** Rate limits exactly as the API runs with default env. */
const defaultLimits = toAppConfig(loadConfig({ DATABASE_URL: "postgres://x", DEMO_ACCESS_TOKEN: TOKEN, JOBS_SECRET })).rateLimits;

const sameLength = (s: string) => s.slice(0, -1) + (s.endsWith("x") ? "y" : "x");

describe("public routes", () => {
  const app = buildTestApp();

  it("serves holdings and unknown-route 404s with no access cookie", async () => {
    expect((await request(app).get("/api/v1/holdings")).status).toBe(200);
    expect((await request(app).get("/healthz")).status).toBe(200);
    expect((await request(app).get("/api/v1/healthz")).status).toBe(200);
    expect((await request(app).get("/api/v1/does-not-exist")).status).toBe(404);
  });

  it("compares secrets in constant time regardless of length", () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(safeEqual(sameLength(TOKEN), TOKEN)).toBe(false);
    expect(safeEqual(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(safeEqual("", TOKEN)).toBe(false);
  });
});

describe("internal jobs accept only Bearer JOBS_SECRET", () => {
  const run = vi.fn(async () => ({ done: 1 }));
  const app = buildTestApp({ jobs: new JobRegistry([{ name: "noop-job", description: "d", run }]) });
  const call = (headers: Record<string, string>) => request(app).post("/api/v1/internal/jobs/noop-job").set(headers);

  it.each([
    ["demo token header", { "x-finn-access": TOKEN }],
    ["demo token cookie", { Cookie: `finn_access=${TOKEN}` }],
    ["demo token as bearer", { Authorization: `Bearer ${TOKEN}` }],
    ["secret without scheme", { Authorization: JOBS_SECRET }],
    ["secret with Basic scheme", { Authorization: `Basic ${JOBS_SECRET}` }],
    ["same-length wrong secret", { Authorization: `Bearer ${sameLength(JOBS_SECRET)}` }],
    ["empty bearer", { Authorization: "Bearer " }],
  ])("rejects %s", async (_label, headers) => {
    expect((await call(headers as Record<string, string>)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts the secret with any-case scheme", async () => {
    expect((await call({ Authorization: `Bearer ${JOBS_SECRET}` })).status).toBe(200);
    expect((await call({ Authorization: `bearer ${JOBS_SECRET}` })).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("validates the job name", async () => {
    const res = await request(app).post("/api/v1/internal/jobs/Bad_Name").set("Authorization", `Bearer ${JOBS_SECRET}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("name");
  });
});

describe("request validation", () => {
  const app = buildTestApp();
  const id = randomUUID();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "k", auth: "a" } };
  const rule = { type: "price_move", scope: { kind: "portfolio" }, direction: "up", thresholdPct: 5 };

  const cases: [string, string, string, unknown, string[]][] = [
    ["POST", "/api/v1/interactions", "empty seqId", { seqId: "", action: "open" }, ["seqId"]],
    ["POST", "/api/v1/interactions", "unknown action", { seqId: "1", action: "like" }, ["action"]],
    ["POST", "/api/v1/research-runs", "bad symbol", { symbol: "bad sym!" }, ["symbol"]],
    ["POST", "/api/v1/research-runs", "unknown module", { symbol: "TCS", modules: ["astrology"] }, ["modules.0"]],
    ["POST", "/api/v1/ask", "missing question", { symbol: "TCS" }, ["question"]],
    ["POST", "/api/v1/ask", "question too long", { symbol: "TCS", question: "x".repeat(501) }, ["question"]],
    ["POST", "/api/v1/alert-rules/preview", "text too short", { text: "ab" }, ["text"]],
    ["POST", "/api/v1/alert-rules", "empty name", { name: "", definition: rule }, ["name"]],
    ["POST", "/api/v1/alert-rules", "threshold out of range", { name: "x", definition: { ...rule, thresholdPct: 0.1 } }, ["definition.thresholdPct"]],
    ["POST", "/api/v1/alert-rules", "unknown rule type", { name: "x", definition: { ...rule, type: "moon_phase" } }, ["definition.type"]],
    ["PATCH", `/api/v1/alert-rules/${id}`, "nothing to update", {}, [""]],
    ["PATCH", `/api/v1/alert-rules/${id}`, "negative threshold", { threshold: -1 }, ["threshold"]],
    ["PATCH", `/api/v1/alert-rules/${id}`, "blank name", { name: "  " }, ["name"]],
    ["POST", "/api/v1/push-subscriptions", "bad endpoint and keys", { endpoint: "not a url", keys: {} }, ["endpoint", "keys.p256dh", "keys.auth"]],
    ["DELETE", "/api/v1/push-subscriptions", "bad endpoint", { endpoint: "nope" }, ["endpoint"]],
    ["POST", "/api/v1/push-subscriptions", "an endpoint on an arbitrary host", { ...sub, endpoint: "https://169.254.169.254/latest/meta-data" }, ["endpoint"]],
    ["POST", "/api/v1/push-subscriptions", "a plain-http push host", { ...sub, endpoint: "http://fcm.googleapis.com/fcm/send/x" }, ["endpoint"]],
    ["POST", "/api/v1/push-subscriptions", "a look-alike host", { ...sub, endpoint: "https://fcm.googleapis.com.evil.example/x" }, ["endpoint"]],
    ["POST", "/api/v1/push-subscriptions", "a push host on another port", { ...sub, endpoint: "https://fcm.googleapis.com:8443/x" }, ["endpoint"]],
    ["POST", "/api/v1/push/test", "a missing endpoint", {}, ["endpoint"]],
    ["POST", "/api/v1/push/test", "an endpoint on an arbitrary host", { endpoint: "https://internal.example/x" }, ["endpoint"]],
    ["PUT", "/api/v1/prefs", "nothing to update", {}, [""]],
    ["PUT", "/api/v1/prefs", "unknown window", { defaultWindow: "1y" }, ["defaultWindow"]],
    ["PUT", "/api/v1/prefs", "bad quiet hours", { quietHours: { enabled: true, start: "25:00", end: "7" } }, ["quietHours.start", "quietHours.end"]],
    ["PUT", "/api/v1/prefs", "weight out of range", { categoryWeights: { dividend: 2 } }, ["categoryWeights.dividend"]],
  ];

  it.each(cases)("%s %s rejects %s with 400 validation_error and detail paths", async (method, path, _label, body, paths) => {
    const res = await request(app)[method.toLowerCase() as "post"](path).set(auth).send(body as object);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(paths));
    for (const d of res.body.error.details) expect(d).toEqual({ path: expect.any(String), message: expect.any(String) });
  });

  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://android.googleapis.com/gcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QAbc",
    "https://api.push.apple.com/3/device/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://db5p.notify.windows.com/w/?token=abc",
  ])("accepts a subscription on a known push service: %s", async (endpoint) => {
    const subscribe = vi.fn(async () => {});
    const app = buildTestApp({ push: { publicKey: vi.fn(), subscribe, unsubscribe: vi.fn(), sendTest: vi.fn() } });
    const res = await request(app).post("/api/v1/push-subscriptions").set(auth).send({ ...sub, endpoint });
    expect(res.status).toBe(201);
    expect(subscribe).toHaveBeenCalledWith({ ...sub, endpoint });
  });

  it("puts the first issue in the message, without a path prefix for whole-body refinements", async () => {
    const patch = await request(app).patch(`/api/v1/alert-rules/${id}`).set(auth).send({});
    expect(patch.body.error.message).toBe("Nothing to update");
    const field = await request(app).post("/api/v1/ask").set(auth).send({});
    expect(field.body.error.message).toMatch(/^symbol: /);
  });

  it.each([
    ["GET", "/api/v1/companies/bad%20sym!/financials", "symbol"],
    ["GET", `/api/v1/companies/${"A".repeat(21)}/research`, "symbol"],
    ["GET", "/api/v1/research-runs/not-a-uuid", "id"],
    ["PATCH", "/api/v1/alert-rules/123", "id"],
    ["DELETE", "/api/v1/alert-rules/123", "id"],
    ["POST", "/api/v1/alerts/123/read", "id"],
    ["GET", `/api/v1/announcements/${"9".repeat(65)}`, "seqId"],
    ["GET", "/api/v1/alerts?limit=0", "limit"],
    ["GET", "/api/v1/alerts?limit=101", "limit"],
    ["GET", "/api/v1/companies/search?q=", "q"],
    ["GET", "/api/v1/digest?window=1y", "window"],
  ])("%s %s rejects a malformed %s", async (method, path, param) => {
    const res = await request(app)[method.toLowerCase() as "get"](path).set(auth).send(method === "PATCH" ? { enabled: true } : undefined);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(param);
  });

  it.each(["/api/v1/interactions", "/api/v1/alert-rules/preview", "/api/v1/alert-rules", "/api/v1/push-subscriptions"])(
    "POST %s with a body over 32kb gets 413 payload_too_large",
    async (path) => {
      const res = await request(app).post(path).set(auth).send({ text: "x".repeat(33 * 1024) });
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: { code: "payload_too_large", message: "Request body is too large" } });
    },
  );

  it("lets a body just under 32kb through to validation", async () => {
    const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: "x".repeat(31 * 1024) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("also caps PUT /prefs at 32kb", async () => {
    const res = await request(app).put("/api/v1/prefs").set(auth).send({ categoryWeights: {}, pad: "x".repeat(40 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("rate limits with the default configuration", () => {
  const okAsk = createAskService({ engine: { answer: async () => ({ answer: [], insufficientSources: true }) }, companyExists: async () => true });
  const question = { symbol: "TCS", question: "What did management say about margins?" };

  it("allows 6 asks a minute and answers the 7th with 429 rate_limited and RateLimit headers", async () => {
    const app = buildTestApp({ ask: okAsk }, { rateLimits: defaultLimits });
    for (let i = 1; i <= 6; i++) {
      const res = await request(app).post("/api/v1/ask").set(auth).send(question);
      expect(res.status, `ask #${i}`).toBe(200);
      expect(res.headers["ratelimit-policy"]).toContain('"ask"; q=6; w=60');
      expect(res.headers["ratelimit"]).toContain(`"ask"; r=${6 - i}; t=`);
    }
    const res = await request(app).post("/api/v1/ask").set(auth).send(question);
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({ code: "rate_limited", message: "You're asking faster than FINN can read. Try again in a minute." });
    expect(res.headers["ratelimit"]).toContain('"ask"; r=0; t=');
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
    // Other endpoints are only under the global limit.
    expect((await request(app).get("/api/v1/holdings").set(auth)).status).toBe(200);
  });

  it("does not count asks refused by validation against the budget of the LLM", async () => {
    const answer = vi.fn(async () => ({ answer: [], insufficientSources: true }));
    const app = buildTestApp({ ask: createAskService({ engine: { answer }, companyExists: async () => true }) }, { rateLimits: defaultLimits });
    await request(app).post("/api/v1/ask").set(auth).send({ symbol: "TCS" });
    expect(answer).not.toHaveBeenCalled();
  });

  it("allows 10 research requests a minute", async () => {
    const create = vi.fn(async () => ({ status: 202 as const, body: { runId: "r", status: "queued" as const, cached: false } }));
    const research = { create, getRun: vi.fn(), companyResearch: vi.fn(), redispatchStale: vi.fn() };
    const app = buildTestApp({ research }, { rateLimits: defaultLimits });
    for (let i = 0; i < 10; i++) expect((await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "TCS" })).status).toBe(202);
    const res = await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "TCS" });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe("Too many research requests. Try again in a minute.");
    expect(create).toHaveBeenCalledTimes(10);
  });

  it("allows 3 test pushes a minute", async () => {
    const sendTest = vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0 }));
    const push = { publicKey: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), sendTest };
    const app = buildTestApp({ push }, { rateLimits: defaultLimits });
    const body = { endpoint: "https://fcm.googleapis.com/fcm/send/x" };
    for (let i = 0; i < 3; i++) expect((await request(app).post("/api/v1/push/test").set(auth).send(body)).status).toBe(200);
    const res = await request(app).post("/api/v1/push/test").set(auth).send(body);
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({ code: "rate_limited", message: "Too many test notifications. Try again in a minute." });
    expect(sendTest).toHaveBeenCalledTimes(3);
    expect(sendTest).toHaveBeenCalledWith(body.endpoint);
  });

  it("applies the global limit of 120 a minute across /api/v1 but never to /healthz", async () => {
    const app = buildTestApp({}, { rateLimits: defaultLimits });
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) statuses.push((await request(app).get("/api/v1/holdings").set(auth)).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
    expect((await request(app).get("/healthz")).status).toBe(200);
  });
});

describe("errors", () => {
  it("answers unknown routes outside /api/v1 with the JSON 404 shape and the request id", async () => {
    const res = await request(buildTestApp()).post("/nope/deeper").set("x-request-id", "req-12345678");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ error: { code: "not_found", message: "No route for POST /nope/deeper" } });
    expect(res.headers["x-request-id"]).toBe("req-12345678");
  });

  it("hides the stack and message of unexpected errors in production", async () => {
    const boom = new Error("password authentication failed for user finn");
    const app = buildTestApp({ holdings: { list: async () => Promise.reject(boom) } }, { isProduction: true });
    const res = await request(app).get("/api/v1/holdings").set(auth);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal_error", message: "Something went wrong on our side" } });
    expect(res.text).not.toMatch(/password|stack|at .*\.ts/);
  });

  it("shows response-contract issues in development only", async () => {
    const services: Partial<AppServices> = { holdings: { list: async () => [{ symbol: "TCS" }] as never } };
    const dev = await request(buildTestApp(services)).get("/api/v1/holdings").set(auth);
    expect(dev.body.error.code).toBe("response_contract");
    expect(dev.body.error.details.length).toBeGreaterThan(0);
    const prod = await request(buildTestApp(services, { isProduction: true })).get("/api/v1/holdings").set(auth);
    expect(prod.status).toBe(500);
    expect(prod.body).toEqual({ error: { code: "response_contract", message: "Response failed its schema" } });
  });

  it("passes HttpError details through and maps duck-typed ZodErrors from another zod copy", () => {
    expect(toErrorResponse(badRequest("bad", { field: "x" }), false)).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "bad", details: { field: "x" } } },
    });
    const foreign = Object.assign(new Error("zod"), { name: "ZodError", issues: [] });
    expect(toErrorResponse(foreign, false)).toEqual({ status: 400, body: { error: { code: "validation_error", message: "Invalid request", details: [] } } });
    expect(toErrorResponse(null, true).status).toBe(500);
    expect(toErrorResponse(new HttpError(418, "teapot", "short and stout"), false).body.error).toEqual({ code: "teapot", message: "short and stout" });
  });

  it("only ends the response when headers were already sent (e.g. mid-stream)", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const res = { headersSent: true, end: vi.fn(), status: vi.fn(), json: vi.fn() };
    errorHandler(logger, false)(new Error("late"), {} as never, res as never, () => {});
    expect(res.end).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "request failed");
  });
});

describe("request ids", () => {
  const app = buildTestApp();

  it("echoes a sane upstream id, including on errors", async () => {
    for (const path of ["/healthz", "/api/v1/holdings", "/missing"]) {
      const res = await request(app).get(path).set("x-request-id", "Render.abc_123-XYZ");
      expect(res.headers["x-request-id"]).toBe("Render.abc_123-XYZ");
    }
  });

  it.each(["short", "has spaces in it", "x".repeat(65), "semi;colon;id"])("replaces an unusable upstream id (%s) with a UUID", async (incoming) => {
    const res = await request(app).get("/healthz").set("x-request-id", incoming);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints a fresh id per request when none is sent", async () => {
    const a = (await request(app).get("/healthz")).headers["x-request-id"];
    const b = (await request(app).get("/healthz")).headers["x-request-id"];
    expect(a).not.toBe(b);
  });
});

describe("log redaction", () => {
  function capturedApp(isProduction = false) {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger("info");
    // Swap pino's destination for an in-memory one; redaction is configured by createLogger and applied before the write.
    (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = { write: (s: string) => lines.push(JSON.parse(s)) };
    const services: Partial<AppServices> = {
      holdings: { list: async () => [] },
      engine: { stats: async () => Promise.reject(new Error("db exploded")) },
      jobs: new JobRegistry([{ name: "noop", description: "d", run: async () => ({}) }]),
    };
    const app = createApp({ config: testConfig({ isProduction }), logger, services: { ...defaultServices(), ...services } });
    return { app, lines, raw: () => JSON.stringify(lines) };
  }

  it("never writes the access cookie, the access header, the bearer secret or the Set-Cookie value", async () => {
    const { app, lines, raw } = capturedApp();
    await request(app).get("/api/v1/holdings").set("Cookie", `finn_access=${TOKEN}; other=1`);
    await request(app).get("/api/v1/holdings").set("x-finn-access", TOKEN);
    await request(app).get("/api/v1/holdings").set("x-finn-access", sameLength(TOKEN));
    await request(app).post("/api/v1/internal/jobs/noop").set("Authorization", `Bearer ${JOBS_SECRET}`);
    await request(app).get("/api/v1/engine").set("x-finn-access", TOKEN);

    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(raw()).not.toContain(TOKEN);
    expect(raw()).not.toContain(JOBS_SECRET);
    expect(raw()).not.toContain(sameLength(TOKEN));
    const headers = lines.map((l) => (l.req as { headers?: Record<string, unknown> } | undefined)?.headers ?? {});
    expect(headers.some((h) => h.cookie === "[redacted]")).toBe(true);
    expect(headers.some((h) => h["x-finn-access"] === "[redacted]")).toBe(true);
    expect(headers.some((h) => h.authorization === "[redacted]")).toBe(true);
  });

  it("logs the request id, 4xx as warn, 5xx as error with the error, and skips /healthz", async () => {
    const { app, lines } = capturedApp();
    await request(app).get("/api/v1/holdings").set("x-request-id", "trace-0001");
    await request(app).get("/api/v1/no-such");
    await request(app).get("/api/v1/engine");
    await request(app).get("/healthz");

    const completed = lines.filter((l) => l.msg === "request completed" || l.msg === "request errored");
    const byUrl = (url: string) => completed.filter((l) => (l.req as { url: string }).url === url);
    expect(byUrl("/api/v1/holdings").map((l) => l.level)).toEqual([30]);
    expect(byUrl("/api/v1/no-such").map((l) => l.level)).toEqual([40]);
    expect((byUrl("/api/v1/holdings")[0]!.req as { id: string }).id).toBe("trace-0001");
    expect(byUrl("/api/v1/engine")[0]!.level).toBe(50);
    expect(lines.some((l) => l.msg === "request failed" && (l.err as { message: string }).message === "db exploded")).toBe(true);
    expect(byUrl("/healthz")).toEqual([]);
    expect(lines.every((l) => l.service === "finn-api" && typeof l.time === "string")).toBe(true);
  });
});

function defaultServices(): AppServices {
  const stub = new Proxy({}, { get: () => () => Promise.reject(new Error("not stubbed")) }) as never;
  return {
    health: { check: async () => ({ ok: true, db: "up", latencyMs: 1, uptimeS: 1 }) },
    digest: stub,
    announcements: stub,
    interactions: stub,
    holdings: { list: async () => [] },
    companies: stub,
    research: stub,
    researchEvents: stub,
    ask: stub,
    llmBudget: { remaining: async () => 1 },
    alertRules: stub,
    alerts: stub,
    push: stub,
    prefs: stub,
    engine: stub,
    jobs: new JobRegistry(),
  };
}
