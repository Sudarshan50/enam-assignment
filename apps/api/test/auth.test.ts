import request from "supertest";
import { describe, expect, it } from "vitest";
import { ORIGIN, TOKEN, buildTestApp } from "./helpers";

describe("demo token gate", () => {
  const app = buildTestApp();

  it("rejects a request with no token", async () => {
    const res = await request(app).get("/api/v1/holdings");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
  });

  it("rejects a wrong header and a wrong cookie", async () => {
    expect((await request(app).get("/api/v1/holdings").set("x-finn-access", "nope")).status).toBe(401);
    expect((await request(app).get("/api/v1/holdings").set("Cookie", "finn_access=nope")).status).toBe(401);
    expect((await request(app).get("/api/v1/holdings").set("x-finn-access", `${TOKEN}x`)).status).toBe(401);
  });

  it("accepts the token as a header or as the finn_access cookie", async () => {
    const viaHeader = await request(app).get("/api/v1/holdings").set("x-finn-access", TOKEN);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body).toEqual([]);
    const viaCookie = await request(app).get("/api/v1/holdings").set("Cookie", `finn_access=${TOKEN}`);
    expect(viaCookie.status).toBe(200);
  });

  it("accepts a valid cookie even when a stale header is also sent", async () => {
    const res = await request(app).get("/api/v1/holdings").set("x-finn-access", "old").set("Cookie", `finn_access=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("leaves health checks open", async () => {
    const root = await request(app).get("/healthz");
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({ ok: true, db: "up" });
    expect((await request(app).get("/api/v1/healthz")).status).toBe(200);
  });

  it("returns 503 from /healthz when the database is down", async () => {
    const down = buildTestApp({ health: { check: async () => ({ ok: false, db: "down", latencyMs: null, uptimeS: 1 }) } });
    const res = await request(down).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body.db).toBe("down");
  });

  it("returns 404 in the standard error shape for unknown routes once authenticated", async () => {
    const res = await request(app).get("/api/v1/nope").set("x-finn-access", TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("POST /api/v1/session", () => {
  it("rejects a wrong token", async () => {
    const res = await request(buildTestApp()).post("/api/v1/session").send({ token: "wrong" });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("sets an httpOnly, SameSite=Lax, 30-day cookie that then authenticates", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/api/v1/session").send({ token: TOKEN });
    expect(res.status).toBe(200);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("finn_access=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Secure");

    const agent = request.agent(app);
    await agent.post("/api/v1/session").send({ token: TOKEN });
    expect((await agent.get("/api/v1/holdings")).status).toBe(200);
  });

  it("marks the cookie Secure in production", async () => {
    const res = await request(buildTestApp({}, { isProduction: true })).post("/api/v1/session").send({ token: TOKEN });
    expect(String(res.headers["set-cookie"])).toContain("Secure");
  });
});

describe("CORS and headers", () => {
  const app = buildTestApp();

  it("allows the configured origin with credentials", async () => {
    const res = await request(app).options("/api/v1/digest").set("Origin", ORIGIN).set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not allow other origins", async () => {
    const res = await request(app).get("/healthz").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sets a request id and security headers", async () => {
    const res = await request(app).get("/healthz").set("x-request-id", "abc12345-upstream");
    expect(res.headers["x-request-id"]).toBe("abc12345-upstream");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("rate limiting", () => {
  it("returns 429 in the standard error shape past the global limit", async () => {
    const app = buildTestApp({}, { rateLimits: { ...buildLimits(), global: { windowMs: 60_000, limit: 2 } } });
    await request(app).get("/api/v1/holdings").set("x-finn-access", TOKEN);
    await request(app).get("/api/v1/holdings").set("x-finn-access", TOKEN);
    const res = await request(app).get("/api/v1/holdings").set("x-finn-access", TOKEN);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
  });
});

function buildLimits() {
  const open = { windowMs: 60_000, limit: 10_000 };
  return { global: open, session: open, ask: open, research: open };
}
