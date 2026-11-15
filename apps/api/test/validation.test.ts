import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { auth, buildTestApp } from "./helpers";

describe("input validation", () => {
  const app = buildTestApp();

  it("rejects an unknown digest window", async () => {
    const res = await request(app).get("/api/v1/digest?window=1y").set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("window");
    expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "window" })]));
  });

  it("rejects an unknown interaction action", async () => {
    const res = await request(app).post("/api/v1/interactions").set(auth).send({ seqId: "1", action: "like" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects malformed symbols and run ids", async () => {
    expect((await request(app).post("/api/v1/research-runs").set(auth).send({ symbol: "not a symbol!" })).status).toBe(400);
    expect((await request(app).get("/api/v1/research-runs/not-a-uuid").set(auth)).status).toBe(400);
    expect((await request(app).get("/api/v1/companies/bad%20sym!/financials").set(auth)).status).toBe(400);
  });

  it("rejects an alert rule outside the allowed threshold range", async () => {
    const res = await request(app)
      .post("/api/v1/alert-rules")
      .set(auth)
      .send({ name: "Huge", definition: { type: "price_move", scope: { kind: "portfolio" }, direction: "up", thresholdPct: 50 } });
    expect(res.status).toBe(400);
  });

  it("rejects preference weights outside USER_WEIGHT_RANGE", async () => {
    const res = await request(app).put("/api/v1/prefs").set(auth).send({ categoryWeights: { dividend: 3 } });
    expect(res.status).toBe(400);
    const empty = await request(app).put("/api/v1/prefs").set(auth).send({});
    expect(empty.status).toBe(400);
  });

  it("rejects ask questions that are too short", async () => {
    const res = await request(app).post("/api/v1/ask").set(auth).send({ symbol: "TCS", question: "?" });
    expect(res.status).toBe(400);
  });

  it("maps invalid JSON to 400 and oversized bodies to 413", async () => {
    const bad = await request(app).post("/api/v1/interactions").set(auth).set("Content-Type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_json");

    const big = await request(app)
      .post("/api/v1/alert-rules/preview")
      .set(auth)
      .send({ text: "x".repeat(40 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("payload_too_large");
  });
});

describe("response contracts", () => {
  it("turns a response that breaks its shared schema into a 500 in strict mode", async () => {
    const app = buildTestApp({ holdings: { list: async () => [{ symbol: "TCS" }] as never } });
    const res = await request(app).get("/api/v1/holdings").set(auth);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("response_contract");
  });

  it("sends the body anyway in warn mode", async () => {
    const app = buildTestApp({ holdings: { list: async () => [{ symbol: "TCS" }] as never } }, { responseValidation: "warn" });
    const res = await request(app).get("/api/v1/holdings").set(auth);
    expect(res.status).toBe(200);
  });

  it("hides internals of unexpected errors", async () => {
    const list = vi.fn(async () => {
      throw new Error("relation \"secret_table\" does not exist");
    });
    const res = await request(buildTestApp({ holdings: { list } })).get("/api/v1/holdings").set(auth);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal_error", message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toContain("secret_table");
  });
});
