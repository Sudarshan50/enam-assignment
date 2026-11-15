import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { z } from "zod";
import { closeDb, getDb } from "@finn/db";
import { DigestResponseSchema, HoldingSchema } from "@finn/shared";
import { seedDemoData } from "../scripts/demo-data";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { buildContainer } from "../src/container";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://finn:finn@localhost:54329/finn";
const TOKEN = "integration-token-123";

async function reachable(): Promise<boolean> {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) return false; // demo data only ever goes to a local DB
  try {
    const sql = getDb({ url: DATABASE_URL, max: 2 });
    await Promise.race([sql`SELECT 1 FROM holdings LIMIT 1`, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]);
    return true;
  } catch {
    await closeDb().catch(() => {});
    return false;
  }
}

const dbUp = await reachable();

describe.skipIf(!dbUp)("API against the local database (demo data)", async () => {
  const sql = getDb({ url: DATABASE_URL, max: 2 });
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL, DEMO_ACCESS_TOKEN: TOKEN, JOBS_SECRET: "integration-jobs", LOG_LEVEL: "silent" });
  const logger = pino({ level: "silent" });
  const container = dbUp ? await buildContainer(config, { logger, sql }) : null;
  const app = container ? createApp(container.deps) : null;

  afterAll(async () => {
    await closeDb();
  });

  it("seeds demo data idempotently", async () => {
    const first = await seedDemoData(sql);
    const second = await seedDemoData(sql);
    expect(second.announcements).toBe(first.announcements);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM announcements WHERE seq_id LIKE 'DEMO-%'`;
    expect(row!.n).toBe(first.announcements);
  });

  it("GET /api/v1/digest returns demo cluster heads with linked children", async () => {
    const res = await request(app!).get("/api/v1/digest?window=7d").set("x-finn-access", TOKEN);
    expect(res.status).toBe(200);
    const digest = DigestResponseSchema.parse(res.body);
    const tcs = digest.act.find((i) => i.id === "DEMO-TCS-RESULTS");
    expect(tcs?.card?.kind).toBe("results");
    expect(tcs?.linked.map((l) => l.seqId).sort()).toEqual(["DEMO-TCS-RESULTS-AD", "DEMO-TCS-RESULTS-XBRL"]);
    const allIds = [...digest.act, ...digest.know, ...digest.noise].map((i) => i.id);
    expect(allIds).not.toContain("DEMO-TCS-RESULTS-AD");
    expect(allIds).toContain("DEMO-POLYCAB-CAPEX");
    expect(digest.counts.act).toBe(digest.act.length);
  });

  it("GET /api/v1/holdings returns all holdings with prices and sparklines", async () => {
    const res = await request(app!).get("/api/v1/holdings").set("x-finn-access", TOKEN);
    expect(res.status).toBe(200);
    const holdings = z.array(HoldingSchema).parse(res.body);
    expect(holdings.length).toBeGreaterThanOrEqual(18);
    const trent = holdings.find((h) => h.symbol === "TRENT");
    expect(trent?.sparkline).toHaveLength(30);
    expect(trent?.close).not.toBeNull();
    expect(trent?.volumeVsAvg).not.toBeNull();
    const tcs = holdings.find((h) => h.symbol === "TCS");
    expect(tcs?.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it("serves the demo research run and the CDSL research page", async () => {
    const { runId } = await seedDemoData(sql);
    const run = await request(app!).get(`/api/v1/research-runs/${runId}`).set("x-finn-access", TOKEN);
    expect(run.status).toBe(200);
    expect(run.body.status).toBe("completed");
    expect(run.body.modules.filter((m: { status: string }) => m.status === "done")).toHaveLength(4);

    const page = await request(app!).get("/api/v1/companies/CDSL/research").set("x-finn-access", TOKEN);
    expect(page.status).toBe(200);
    expect(["completed", "partial"]).toContain(page.body.run.status);
    expect(page.body.promiseLedger.summary.pending).toBeGreaterThanOrEqual(3);
  });
});
