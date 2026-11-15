import { ResearchEventSchema, ResearchRunSchema, type ResearchEvent } from "@finn/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const T0 = new Date("2026-11-15T08:00:00.000Z");

async function load() {
  vi.resetModules();
  return import("@/mocks/runs");
}

function advance(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("mock run simulator", () => {
  it("emits a well-formed, strictly ordered lifecycle for a cold run", async () => {
    const runs = await load();
    const { runId, status } = runs.startMockRun("ASTRAL");
    expect(status).toBe("queued");
    expect(runs.mockRunEventsSince(runId, 0).map((e) => e.type)).toEqual(["run.queued"]);

    advance(60_000);
    const events = runs.mockRunEventsSince(runId, 0);
    events.forEach((e) => ResearchEventSchema.parse(e));

    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    const times = events.map((e) => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.queued");
    expect(types[1]).toBe("run.started");
    expect(types.at(-1)).toBe("run.completed");
    expect(types.indexOf("document.embedded")).toBeLessThan(types.indexOf("module.started"));

    const moduleEvents = (key: string) => events.filter((e) => (e.data as { module?: string } | null)?.module === key);
    for (const key of ["promise_ledger", "financial_snapshot", "cash_quality", "business_snapshot", "bull_bear"]) {
      expect(moduleEvents(key).map((e) => e.type)).toEqual(["module.started", "module.completed"]);
    }
  });

  it("returns only events after lastId (resume) and nothing for unknown runs", async () => {
    const runs = await load();
    const { runId } = runs.startMockRun("TCS");
    advance(3_000);
    const first = runs.mockRunEventsSince(runId, 0);
    const lastId = first.at(-1)!.id;
    advance(60_000);
    const rest = runs.mockRunEventsSince(runId, lastId);
    expect(rest[0]!.id).toBe(lastId + 1);
    expect([...first, ...rest].map((e: ResearchEvent) => e.id)).toEqual(runs.mockRunEventsSince(runId, 0).map((e) => e.id));
    expect(runs.mockRunEventsSince("nope", 0)).toEqual([]);
  });

  it("walks run status queued → processing_docs → synthesizing → partial for symbols without fixtures", async () => {
    const runs = await load();
    const { runId } = runs.startMockRun("ASTRAL");
    const seen = new Set<string>();
    for (let t = 0; t < 30_000; t += 250) {
      const run = ResearchRunSchema.parse(runs.getMockRun(runId));
      seen.add(run.status);
      advance(250);
    }
    expect([...seen]).toEqual(["queued", "processing_docs", "synthesizing", "partial"]);
    const final = runs.getMockRun(runId)!;
    expect(final.modules.every((m) => m.status === "insufficient_sources")).toBe(true);
  });

  it("serves the pre-warmed CDSL run as cached and complete", async () => {
    const runs = await load();
    const res = runs.startMockRun("CDSL");
    expect(res).toMatchObject({ status: "completed", cached: true });
    const run = runs.getMockRun(res.runId)!;
    expect(run.modules.every((m) => m.status === "done")).toBe(true);
    expect(runs.mockRunEventsSince(res.runId, 0).at(-1)?.type).toBe("run.completed");
  });

  it("joins an in-flight run instead of starting a second one", async () => {
    const runs = await load();
    const a = runs.startMockRun("DIXON");
    advance(2_000);
    const b = runs.startMockRun("DIXON");
    expect(b.runId).toBe(a.runId);
    expect(b.cached).toBe(false);
  });
});
