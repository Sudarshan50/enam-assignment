import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@finn/db";
import { ResearchEventSchema } from "@finn/shared";
import type { SseOptions } from "../src/services/researchEventStream";
import { TOKEN, auth } from "./helpers";
import { buildDbApp, cleanupPrefix, dbReachable, expectParse } from "./support/db";

const dbUp = await dbReachable();
const P = "ZTPS";

interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: () => string;
  waitFor: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
  ended: Promise<string>;
  close: () => void;
}

/** A raw EventSource-like client over a real socket, so chunks are observed as the server flushes them. */
function openStream(port: number, path: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path, headers: { "x-finn-access": TOKEN, accept: "text/event-stream", ...headers } }, (res) => {
      let buffer = "";
      const waiters = new Set<() => void>();
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (const w of waiters) w();
      });
      const ended = new Promise<string>((done) => {
        res.on("end", () => done(buffer));
        res.on("close", () => done(buffer));
      });
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => buffer,
        ended,
        close: () => req.destroy(),
        waitFor: (predicate, timeoutMs = 3000) =>
          new Promise((ok, fail) => {
            const check = () => {
              if (!predicate(buffer)) return;
              waiters.delete(check);
              clearTimeout(timer);
              ok(buffer);
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`timed out waiting for stream; got:\n${buffer}`));
            }, timeoutMs);
            waiters.add(check);
            check();
          }),
      });
    });
    req.on("error", (err) => (err.message.includes("socket hang up") || (err as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(err)));
  });
}

const ids = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
const dataLines = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => /^id: /m.test(block))
    .map((block) => JSON.parse(block.split("data: ")[1]!) as unknown);

describe.skipIf(!dbUp)("research run events over SSE (real HTTP server, local database)", async () => {
  if (!dbUp) return it.skip("needs the local database", () => {});
  const sql = getDb();
  const servers: http.Server[] = [];

  async function serve(sse: Partial<SseOptions> = {}, extra: Parameters<typeof buildDbApp>[1] = {}) {
    const built = await buildDbApp(sql, {
      ...extra,
      config: { sse: { pollMs: 20, heartbeatMs: 10_000, maxDurationMs: 10_000, retryMs: 1500, ...sse } },
    });
    const server = built.app.listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    return { ...built, port: (server.address() as AddressInfo).port };
  }

  async function createRun(status: string, eventTypes: string[] = []) {
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO research_runs (symbol, status, modules) VALUES (${`${P}${randomUUID().slice(0, 8).toUpperCase()}`}, ${status}, ARRAY['bull_bear'])
      RETURNING id`;
    const eventIds: number[] = [];
    for (const type of eventTypes) eventIds.push(await addEvent(run!.id, type));
    return { runId: run!.id, eventIds };
  }

  async function addEvent(runId: string, type: string) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO research_events (run_id, type, message, data) VALUES (${runId}, ${type}, ${`step ${type}`}, ${sql.json({ step: type })})
      RETURNING id::text`;
    return Number(row!.id);
  }

  beforeAll(async () => {
    await cleanupPrefix(sql, P);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    await cleanupPrefix(sql, P);
    await closeDb();
  });

  it("replays after Last-Event-ID, streams rows inserted while connected, then ends with `event: end`", async () => {
    const { port } = await serve();
    const { runId, eventIds } = await createRun("processing_docs", ["run.queued", "run.started", "document.discovered"]);
    const stream = await openStream(port, `/api/v1/research-runs/${runId}/events`, { "last-event-id": String(eventIds[0]) });

    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    expect(stream.headers["connection"]).toBe("keep-alive");

    await stream.waitFor((t) => ids(t).includes(eventIds[2]!));
    expect(stream.text().startsWith("retry: 1500\n\n")).toBe(true);
    expect(ids(stream.text())).toEqual([eventIds[1], eventIds[2]]);

    const live = await addEvent(runId, "document.embedded");
    await stream.waitFor((t) => ids(t).includes(live));
    expect(stream.text()).not.toContain("event: end");

    const last = await addEvent(runId, "run.completed");
    await sql`UPDATE research_runs SET status = 'completed' WHERE id = ${runId}`;
    const text = await stream.ended;
    expect(ids(text)).toEqual([eventIds[1], eventIds[2], live, last]);
    expect(text).toMatch(/event: end\ndata: \{"status":"completed"\}\n\n$/);
    // The web parses every event payload with ResearchEventSchema.
    for (const payload of dataLines(text)) expectParse(ResearchEventSchema, payload, "event payload");
    expect(dataLines(text)[0]).toMatchObject({ id: eventIds[1], runId, type: "run.started", message: "step run.started", data: { step: "run.started" } });
  });

  it("accepts ?lastEventId (EventSource cannot set headers on first connect), and the header wins when both are sent", async () => {
    const { port } = await serve();
    const { runId, eventIds } = await createRun("failed", ["run.queued", "run.started", "run.failed"]);

    const viaQuery = await openStream(port, `/api/v1/research-runs/${runId}/events?lastEventId=${eventIds[1]}`);
    const text = await viaQuery.ended;
    expect(ids(text)).toEqual([eventIds[2]]);
    expect(text).toContain('event: end\ndata: {"status":"failed"}');

    const both = await openStream(port, `/api/v1/research-runs/${runId}/events?lastEventId=${eventIds[1]}`, { "last-event-id": String(eventIds[0]) });
    expect(ids(await both.ended)).toEqual([eventIds[1], eventIds[2]]);

    const fromStart = await openStream(port, `/api/v1/research-runs/${runId}/events`, { "last-event-id": "garbage" });
    expect(ids(await fromStart.ended)).toEqual(eventIds);
  });

  it.each(["partial", "cancelled", "completed"])("ends immediately for a run already %s", async (status) => {
    const { port } = await serve();
    const { runId } = await createRun(status, ["run.queued"]);
    const text = await (await openStream(port, `/api/v1/research-runs/${runId}/events`)).ended;
    expect(text).toContain(`event: end\ndata: {"status":"${status}"}`);
  });

  it("sends heartbeat comments while the run is active", async () => {
    const { port } = await serve({ heartbeatMs: 30 });
    const { runId } = await createRun("synthesizing", ["run.queued"]);
    const stream = await openStream(port, `/api/v1/research-runs/${runId}/events`);
    await stream.waitFor((t) => (t.match(/^: ping$/gm) ?? []).length >= 2);
    stream.close();
  });

  it("clears its heartbeat interval and stops polling when the client disconnects", async () => {
    const HEARTBEAT = 4321;
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    let polls = 0;
    const { port, repo } = await serve(
      { heartbeatMs: HEARTBEAT, pollMs: 15 },
      {
        services: {
          researchEvents: {
            listAfter: (...args) => {
              polls++;
              return repo.listAfter(...args);
            },
            runStatus: (id) => repo.runStatus(id),
          },
        },
      },
    );
    const { runId } = await createRun("processing_docs", ["run.queued"]);
    const stream = await openStream(port, `/api/v1/research-runs/${runId}/events`);
    await stream.waitFor((t) => ids(t).length === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(polls).toBeGreaterThan(1);

    const heartbeatCall = setSpy.mock.calls.findIndex((c) => c[1] === HEARTBEAT);
    expect(heartbeatCall).toBeGreaterThanOrEqual(0);
    const handle = setSpy.mock.results[heartbeatCall]!.value;
    expect(clearSpy.mock.calls.some((c) => c[0] === handle)).toBe(false);

    stream.close();
    await vi.waitFor(() => expect(clearSpy.mock.calls.some((c) => c[0] === handle)).toBe(true), { timeout: 2000, interval: 10 });
    const after = polls;
    await new Promise((r) => setTimeout(r, 80));
    expect(polls).toBe(after);
  });

  it("ends the stream after maxDurationMs without an end event, so EventSource reconnects", async () => {
    const { port } = await serve({ maxDurationMs: 120 });
    const { runId, eventIds } = await createRun("queued", ["run.queued"]);
    const started = Date.now();
    const text = await (await openStream(port, `/api/v1/research-runs/${runId}/events`)).ended;
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(ids(text)).toEqual(eventIds);
    expect(text).not.toContain("event: end");
  });

  it("emits a warning event when a poll fails and keeps going", async () => {
    let failOnce = true;
    const { port, repo } = await serve(
      {},
      {
        services: {
          researchEvents: {
            listAfter: (...args) => {
              if (failOnce) {
                failOnce = false;
                return Promise.reject(new Error("connection reset"));
              }
              return repo.listAfter(...args);
            },
            runStatus: (id) => repo.runStatus(id),
          },
        },
      },
    );
    const { runId, eventIds } = await createRun("processing_docs", ["run.queued"]);
    const stream = await openStream(port, `/api/v1/research-runs/${runId}/events`);
    await stream.waitFor((t) => ids(t).includes(eventIds[0]!));
    expect(stream.text()).toContain('event: warning\ndata: {"message":"Progress updates are delayed; retrying."}');
    await sql`UPDATE research_runs SET status = 'completed' WHERE id = ${runId}`;
    expect(await stream.ended).toContain("event: end");
  });

  it("answers JSON errors before opening a stream: 404 unknown run, 400 bad id or lastEventId, 401 without token", async () => {
    const { app } = await serve();
    const { runId } = await createRun("queued");
    const missing = await request(app).get(`/api/v1/research-runs/${randomUUID()}/events`).set(auth);
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/json");
    expect(missing.body.error.code).toBe("not_found");
    const badId = await request(app).get("/api/v1/research-runs/123/events").set(auth);
    expect(badId.status).toBe(400);
    expect(badId.body.error.details[0].path).toBe("id");
    const badCursor = await request(app).get(`/api/v1/research-runs/${runId}/events?lastEventId=-1`).set(auth);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.details[0].path).toBe("lastEventId");
    expect((await request(app).get(`/api/v1/research-runs/${runId}/events`)).status).toBe(401);
  });
});
