import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { RunStatus } from "@finn/shared";
import { type ResearchEventRow, type ResearchEventsSource, formatEvent, parseLastEventId } from "../src/services/researchEventStream";
import { TOKEN, auth, buildTestApp } from "./helpers";

const RUN = randomUUID();

function event(id: number, type = "module.completed"): ResearchEventRow {
  return { id, runId: RUN, type, message: `event ${id}`, data: { n: id }, createdAt: new Date(Date.UTC(2026, 10, 15, 8, 0, id)) };
}

/** Events source whose status sequence advances on each status check. */
function fakeSource(events: ResearchEventRow[], statuses: (RunStatus | null)[]) {
  let statusCalls = 0;
  let listCalls = 0;
  const source: ResearchEventsSource & { listCalls: () => number; push: (e: ResearchEventRow) => void } = {
    async listAfter(runId, afterId, limit) {
      listCalls++;
      return events.filter((e) => e.runId === runId && e.id > afterId).slice(0, limit);
    },
    async runStatus(runId) {
      if (runId !== RUN) return null;
      const status = statuses[Math.min(statusCalls, statuses.length - 1)] ?? null;
      statusCalls++;
      return status;
    },
    listCalls: () => listCalls,
    push: (e) => events.push(e),
  };
  return source;
}

function ids(body: string): number[] {
  return [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
}

describe("GET /api/v1/research-runs/:id/events (SSE)", () => {
  it("replays only events after Last-Event-ID, then ends on a terminal status", async () => {
    const source = fakeSource([1, 2, 3, 4, 5].map((i) => event(i)), ["completed"]);
    const res = await request(buildTestApp({ researchEvents: source }))
      .get(`/api/v1/research-runs/${RUN}/events`)
      .set(auth)
      .set("Last-Event-ID", "2");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(ids(res.text)).toEqual([3, 4, 5]);
    expect(res.text).toContain("event: module.completed\n");
    expect(res.text).toMatch(/event: end\ndata: \{"status":"completed"\}\n\n$/);
  });

  it("accepts ?lastEventId when the header cannot be set", async () => {
    const source = fakeSource([1, 2, 3, 4, 5].map((i) => event(i)), ["failed"]);
    const res = await request(buildTestApp({ researchEvents: source }))
      .get(`/api/v1/research-runs/${RUN}/events?lastEventId=4`)
      .set(auth);
    expect(ids(res.text)).toEqual([5]);
    expect(res.text).toContain('"status":"failed"');
  });

  it("keeps polling while the run is active and streams events as they arrive", async () => {
    const source = fakeSource([event(1, "run.queued")], ["queued", "processing_docs", "processing_docs", "completed"]);
    const original = source.runStatus.bind(source);
    let checks = 0;
    source.runStatus = async (id) => {
      checks++;
      if (checks === 3) source.push(event(2, "document.embedded"));
      if (checks === 4) source.push(event(3, "run.completed"));
      return original(id);
    };
    const res = await request(buildTestApp({ researchEvents: source })).get(`/api/v1/research-runs/${RUN}/events`).set(auth);
    expect(ids(res.text)).toEqual([1, 2, 3]);
    expect(res.text.indexOf("event: end")).toBeGreaterThan(res.text.indexOf("id: 3"));
  });

  it("returns a JSON 404 for an unknown run before opening the stream", async () => {
    const source = fakeSource([], ["completed"]);
    const res = await request(buildTestApp({ researchEvents: source })).get(`/api/v1/research-runs/${randomUUID()}/events`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("stops polling when the client disconnects", async () => {
    const source = fakeSource([event(1)], ["processing_docs"]);
    const server = buildTestApp({ researchEvents: source }).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          { port, path: `/api/v1/research-runs/${RUN}/events`, headers: { "x-finn-access": TOKEN } },
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", (err) => (err.message.includes("socket hang up") ? resolve() : reject(err)));
      });
      await new Promise((r) => setTimeout(r, 60));
      const after = source.listCalls();
      await new Promise((r) => setTimeout(r, 120));
      expect(source.listCalls()).toBe(after);
    } finally {
      server.close();
    }
  });

  it("ends open streams when the server shuts down", async () => {
    const source = fakeSource([event(1)], ["processing_docs"]);
    const controller = new AbortController();
    const app = buildTestApp({ researchEvents: source }, {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const res = await request(app).get(`/api/v1/research-runs/${RUN}/events`).set(auth);
    expect(ids(res.text)).toEqual([1]);
    expect(res.text).not.toContain("event: end");
  });
});

describe("SSE helpers", () => {
  it("prefers the Last-Event-ID header and ignores junk", () => {
    expect(parseLastEventId("7", 3)).toBe(7);
    expect(parseLastEventId(undefined, 3)).toBe(3);
    expect(parseLastEventId("abc", undefined)).toBe(0);
    expect(parseLastEventId(undefined, undefined)).toBe(0);
  });

  it("formats id, event and JSON data lines", () => {
    const text = formatEvent(event(9, "run.completed"));
    expect(text.startsWith("id: 9\nevent: run.completed\ndata: {")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(text.split("data: ")[1]!)).toMatchObject({ id: 9, runId: RUN, type: "run.completed" });
  });
});
