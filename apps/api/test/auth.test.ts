import request from "supertest";
import { describe, expect, it } from "vitest";
import { ORIGIN, buildTestApp } from "./helpers";

describe("public API", () => {
  const app = buildTestApp();

  it("serves holdings with no access cookie or header", async () => {
    const res = await request(app).get("/api/v1/holdings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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

  it("returns 404 in the standard error shape for unknown routes", async () => {
    const res = await request(app).get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
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
    await request(app).get("/api/v1/holdings");
    await request(app).get("/api/v1/holdings");
    const res = await request(app).get("/api/v1/holdings");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
  });
});

function buildLimits() {
  const open = { windowMs: 60_000, limit: 10_000 };
  return { global: open, ask: open, research: open, pushTest: open };
}
