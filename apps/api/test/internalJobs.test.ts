import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { JobRegistry } from "../src/services/jobs";
import { JOBS_SECRET, TOKEN, buildTestApp } from "./helpers";

function setup() {
  const run = vi.fn(async () => ({ redispatched: 2 }));
  const jobs = new JobRegistry([{ name: "dispatch-research", description: "Re-dispatch stale runs", run }]);
  return { app: buildTestApp({ jobs }), run };
}

describe("POST /api/v1/internal/jobs/:name", () => {
  it("requires the jobs secret as a bearer token", async () => {
    const { app, run } = setup();
    expect((await request(app).post("/api/v1/internal/jobs/dispatch-research")).status).toBe(401);
    expect((await request(app).post("/api/v1/internal/jobs/dispatch-research").set("Authorization", "Bearer wrong")).status).toBe(401);
    expect((await request(app).post("/api/v1/internal/jobs/dispatch-research").set("Authorization", JOBS_SECRET)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not accept the demo token in place of the jobs secret", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/v1/internal/jobs/dispatch-research").set("x-finn-access", TOKEN);
    expect(res.status).toBe(401);
    const bearerDemo = await request(app).post("/api/v1/internal/jobs/dispatch-research").set("Authorization", `Bearer ${TOKEN}`);
    expect(bearerDemo.status).toBe(401);
  });

  it("runs a registered job and returns its result", async () => {
    const { app, run } = setup();
    const res = await request(app).post("/api/v1/internal/jobs/dispatch-research").set("Authorization", `Bearer ${JOBS_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: "dispatch-research", ok: true, result: { redispatched: 2 } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("404s for unknown jobs and lists the registry", async () => {
    const { app } = setup();
    const bearer = { Authorization: `Bearer ${JOBS_SECRET}` };
    expect((await request(app).post("/api/v1/internal/jobs/nope").set(bearer)).status).toBe(404);
    const list = await request(app).get("/api/v1/internal/jobs").set(bearer);
    expect(list.body).toEqual([{ name: "dispatch-research", description: "Re-dispatch stale runs" }]);
  });

  it("rejects duplicate job names at registration", () => {
    const job = { name: "x", description: "", run: async () => ({}) };
    expect(() => new JobRegistry([job, job])).toThrow(/already registered/);
  });
});
