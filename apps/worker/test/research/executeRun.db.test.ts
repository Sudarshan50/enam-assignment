import { cashQualityModule } from "@finn/ai/modules/cashQuality";
import { financialSnapshotModule } from "@finn/ai/modules/financialSnapshot";
import { ModuleRegistry } from "@finn/ai/modules/registry";
import type { ModuleDocument, ResearchModuleRunner } from "@finn/ai/modules/types";
import { documentsRepo } from "@finn/db/repositories/documents";
import { researchRepo, type ResearchRunRow } from "@finn/db/repositories/research";
import type { ScreenerCompany } from "@finn/sources/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../src/args";
import { executeResearchRun, researchCommand } from "../../src/pipelines/research";
import { cleanupSymbols, connect, fakeContext, fakeEmbeddings, fakePdf, insertCompany, link, screenerCompany, testSymbol, transcriptPage } from "./helpers";

const net = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), requested: [] as string[] }));
const screener = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@finn/sources/screener/company", () => ({ fetchScreenerCompany: screener.fetch }));
vi.mock("@finn/sources/pdf/extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@finn/sources/pdf/extract")>();
  const { decodeFakePdf } = await import("./helpers");
  return { ...actual, extractPdfPages: async (bytes: Uint8Array) => decodeFakePdf(bytes) };
});
vi.mock("@finn/sources/http/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@finn/sources/http/client")>();
  const { fakeFetch } = await import("./helpers");
  const recording: typeof fetch = (input, init) => {
    net.requested.push(String(input));
    return fakeFetch(net.files)(input, init);
  };
  return { ...actual, createHttpClient: (o: Parameters<typeof actual.createHttpClient>[0] = {}) => actual.createHttpClient({ ...o, retries: 0, fetchImpl: recording }) };
});

const SYM = testSymbol("ZTAWRK");
const GHOST = testSymbol("ZTAGHOST");
const BASE = "https://www.bseindia.com/zta-wrk";
const AS_OF = new Date("2026-11-15T06:00:00Z");
const { sql, reachable } = await connect(6);
afterAll(() => sql.end({ timeout: 5 }));

const arPage = (year: string, p: number) => transcriptPage(`annual report ${year}`, p, 12);
net.files.set(`${BASE}/ar26.pdf`, fakePdf([1, 2, 3, 4].map((p) => arPage("FY26", p))));
net.files.set(`${BASE}/ar25.pdf`, fakePdf(["", " ", "Page 3", ""]));
net.files.set(`${BASE}/q2fy27.pdf`, fakePdf([1, 2].map((p) => transcriptPage("q2", p))));
net.files.set(`${BASE}/q1fy27.pdf`, fakePdf([1, 2].map((p) => transcriptPage("q1", p))));
net.files.set(`${BASE}/q4fy26.pdf`, fakePdf([transcriptPage("intimation", 1, 10)]));
net.files.set(`${BASE}/q3fy26.pdf`, fakePdf([1, 2].map((p) => transcriptPage("q3", p))));

const years = ["Mar 2022", "Mar 2023", "Mar 2024", "Mar 2025", "Mar 2026"];
const HISTORY: ScreenerCompany["history"] = [
  {
    statement: "profit_loss",
    columns: [...years, "TTM"],
    rows: [
      { label: "Sales +", values: [900, 1000, 1100, 1265, 1400, 1450] },
      { label: "Operating Profit", values: [150, 180, 200, 278, 300, 310] },
      { label: "Net Profit +", values: [70, 80, 100, 110, 125, 130] },
    ],
  },
  {
    statement: "cash_flow",
    columns: years,
    rows: [
      { label: "Cash from Operating Activity +", values: [50, 60, 70, 80, 95] },
      { label: "Fixed assets purchased", values: [-40, -90, -50, -60, -70] },
    ],
  },
];

const baseLinks = [
  link("annual_report", "Financial Year 2026", `${BASE}/ar26.pdf`),
  link("annual_report", "Financial Year 2025", `${BASE}/ar25.pdf`),
  link("concall_transcript", "2026-11-05", `${BASE}/q2fy27.pdf`),
  link("concall_transcript", "2026-08-10", `${BASE}/q1fy27.pdf`),
  link("concall_transcript", "2026-05-10", `${BASE}/q4fy26.pdf`),
  link("concall_recording", "2026-11-05", `${BASE}/q2fy27.mp3`),
];

/** LLM-backed modules replaced by recording fakes; history modules are the real ones. */
function registry(opts: { failBullBear: boolean }) {
  const seen: Partial<Record<string, ModuleDocument[]>> = {};
  const ran: string[] = [];
  const fake = (key: ResearchModuleRunner["key"], inputs: ResearchModuleRunner["inputs"]): ResearchModuleRunner => ({
    key,
    version: "zta-1",
    inputs,
    async run(ctx) {
      ran.push(key);
      seen[key] = ctx.documents;
      if (key === "bull_bear" && opts.failBullBear) throw new Error("bull/bear model timed out");
      return { status: "done", payload: { key, documents: ctx.documents.length } };
    },
  });
  const reg = new ModuleRegistry()
    .register(fake("promise_ledger", { documents: true, history: false, asOfDay: true }))
    .register(financialSnapshotModule)
    .register(cashQualityModule)
    .register(fake("bull_bear", { documents: true, history: true }))
    .register(fake("business_snapshot", { documents: true, history: false }));
  return { reg, ran, seen };
}

async function claimedRun(symbol: string, worker = "zta-worker"): Promise<ResearchRunRow> {
  const { run } = await researchRepo(sql).createOrGetActive(symbol, [], "zta-test");
  return (await researchRepo(sql).claimById(run.id, worker))!;
}

async function eventsOf(runId: string): Promise<{ type: string; message: string; data: Record<string, unknown> | null }[]> {
  return sql`SELECT type, message, data FROM research_events WHERE run_id = ${runId} ORDER BY id`;
}

describe.skipIf(!reachable)("executeResearchRun end to end (fake network, LLM and embeddings; real database)", () => {
  beforeAll(async () => {
    await cleanupSymbols(sql, [SYM, GHOST]);
    await insertCompany(sql, SYM, "Zeta Works Ltd");
    screener.fetch.mockImplementation(async (_http: unknown, symbol: string) => screenerCompany(symbol, baseLinks, HISTORY));
  });
  afterAll(() => cleanupSymbols(sql, [SYM, GHOST]));

  let firstRunId = "";

  it("first run: processes documents, runs modules, and ends partial when one module fails", async () => {
    const embeddings = fakeEmbeddings();
    const ctx = fakeContext(sql, { embeddings });
    const { reg, seen } = registry({ failBullBear: true });
    const run = await claimedRun(SYM);
    firstRunId = run.id;
    const summary = await executeResearchRun(ctx, run, { workerId: "zta-worker", registry: reg, asOf: AS_OF });

    expect(summary.status).toBe("partial");
    expect(Object.fromEntries(summary.documents.map((d) => [d.label, d.status]))).toEqual({
      "Annual Report FY26": "ready",
      "Annual Report FY25": "scanned",
      "Q2 FY27 concall": "ready",
      "Q1 FY27 concall": "ready",
      "Q4 FY26 concall": "failed",
    });
    expect(net.requested.some((u) => u.endsWith(".mp3"))).toBe(false);
    expect(summary.modules.map((m) => [m.key, m.status])).toEqual([
      ["promise_ledger", "done"],
      ["financial_snapshot", "done"],
      ["cash_quality", "done"],
      ["bull_bear", "failed"],
      ["business_snapshot", "done"],
    ]);
    expect(seen.promise_ledger!.map((d) => d.label).sort()).toEqual(["Annual Report FY26", "Q1 FY27 concall", "Q2 FY27 concall"]);
    expect(seen.promise_ledger!.every((d) => /^[0-9a-f]{64}$/.test(d.sha256 ?? ""))).toBe(true);

    const row = (await researchRepo(sql).get(run.id))!;
    expect(row).toMatchObject({ status: "partial", error: "1 module(s) failed" });
    expect(row.input_hash).toBe(seen.promise_ledger!.map((d) => d.sha256).sort().join(","));
    expect(embeddings.calls.length).toBeGreaterThan(0);
  });

  it("emits events in a coherent order", async () => {
    const evs = await eventsOf(firstRunId);
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("run.completed");
    expect(evs.at(-1)!.message).toBe("Research ready (some modules failed)");
    expect(types.filter((t) => t === "document.discovered")).toHaveLength(5);

    const idx = (pred: (e: (typeof evs)[number]) => boolean) => evs.findIndex(pred);
    for (const label of ["Annual Report FY26", "Q2 FY27 concall", "Q1 FY27 concall"]) {
      const at = (type: string) => idx((e) => e.type === type && e.data?.label === label);
      expect(at("document.discovered")).toBeLessThan(at("document.downloaded"));
      expect(at("document.downloaded")).toBeLessThan(at("document.extracted"));
      expect(at("document.extracted")).toBeLessThan(at("document.embedded"));
    }
    const failed = evs.filter((e) => e.type === "document.failed");
    expect(failed.map((e) => e.data?.status).sort()).toEqual(["failed", "scanned"]);
    expect(failed.find((e) => e.data?.status === "scanned")!.message).toMatch(/scanned PDF; skipped/);

    const firstModule = idx((e) => e.type === "module.started");
    const lastDocument = evs.map((e) => e.type.startsWith("document.")).lastIndexOf(true);
    expect(lastDocument).toBeLessThan(firstModule);
    for (const key of ["promise_ledger", "financial_snapshot", "cash_quality", "bull_bear", "business_snapshot"]) {
      const started = idx((e) => e.type === "module.started" && e.data?.key === key);
      const ended = idx((e) => (e.type === "module.completed" || e.type === "module.failed") && e.data?.key === key);
      expect(started).toBeGreaterThan(0);
      expect(ended).toBeGreaterThan(started);
    }
  });

  it("second run with unchanged inputs: documents are skipped and successful modules come from module_cache", async () => {
    net.requested.length = 0;
    const embeddings = fakeEmbeddings();
    const { reg, ran } = registry({ failBullBear: false });
    const run = await claimedRun(SYM);
    expect(run.id).not.toBe(firstRunId);
    const summary = await executeResearchRun(fakeContext(sql, { embeddings }), run, { workerId: "zta-worker", registry: reg, asOf: AS_OF });

    expect(summary.status).toBe("completed");
    expect(embeddings.calls).toEqual([]);
    expect(Object.fromEntries(summary.documents.map((d) => [d.label, d.status]))).toMatchObject({
      "Annual Report FY26": "skipped",
      "Annual Report FY25": "skipped",
      "Q2 FY27 concall": "skipped",
      "Q1 FY27 concall": "skipped",
      "Q4 FY26 concall": "failed",
    });
    expect(net.requested).toEqual([`${BASE}/q4fy26.pdf`]);
    expect(Object.fromEntries(summary.modules.map((m) => [m.key, m.cached]))).toEqual({
      promise_ledger: true,
      financial_snapshot: true,
      cash_quality: true,
      bull_bear: false,
      business_snapshot: true,
    });
    expect(ran).toEqual(["bull_bear"]);
    const evs = await eventsOf(run.id);
    const cachedDocEvents = evs.filter((e) => e.type === "document.embedded" && e.data?.cached === true);
    expect(cachedDocEvents.map((e) => e.data?.label).sort()).toEqual(["Annual Report FY26", "Q1 FY27 concall", "Q2 FY27 concall"]);
    expect(evs.find((e) => e.data?.label === "Annual Report FY25" && e.type !== "document.discovered")).toMatchObject({
      type: "document.failed",
      message: "Annual Report FY25 is a scanned PDF; skipped (no OCR)",
    });
  });

  it("--no-module-cache recomputes every module; a changed document set invalidates only document-based modules", async () => {
    const all = registry({ failBullBear: false });
    await executeResearchRun(fakeContext(sql), await claimedRun(SYM), { workerId: "zta-worker", registry: all.reg, asOf: AS_OF, noModuleCache: true });
    expect(all.ran.sort()).toEqual(["bull_bear", "business_snapshot", "promise_ledger"]);

    screener.fetch.mockImplementation(async (_http: unknown, symbol: string) =>
      screenerCompany(symbol, [...baseLinks, link("concall_transcript", "2026-02-10", `${BASE}/q3fy26.pdf`)], HISTORY),
    );
    const changed = registry({ failBullBear: false });
    const summary = await executeResearchRun(fakeContext(sql), await claimedRun(SYM), { workerId: "zta-worker", registry: changed.reg, asOf: AS_OF });
    expect(changed.ran.sort()).toEqual(["bull_bear", "business_snapshot", "promise_ledger"]);
    expect(changed.seen.promise_ledger).toHaveLength(4);
    expect(summary.modules.filter((m) => m.cached).map((m) => m.key)).toEqual(["financial_snapshot", "cash_quality"]);
  });

  it("the next calendar day (IST) invalidates only the date-dependent Promise Ledger", async () => {
    const r = registry({ failBullBear: false });
    await executeResearchRun(fakeContext(sql), await claimedRun(SYM), { workerId: "zta-worker", registry: r.reg, asOf: new Date("2026-11-15T18:31:00Z") });
    expect(r.ran).toEqual(["promise_ledger"]);
  });

  it("a symbol that is not in the companies master fails the run cleanly", async () => {
    const run = await claimedRun(GHOST);
    const ctx = fakeContext(sql);
    const summary = await executeResearchRun(ctx, run, { workerId: "zta-worker", registry: registry({ failBullBear: false }).reg });
    expect(summary).toMatchObject({ status: "failed", documents: [], modules: [] });
    expect((await researchRepo(sql).get(run.id))!).toMatchObject({ status: "failed", error: `Unknown symbol ${GHOST}: not in the companies master list` });
    expect((await eventsOf(run.id)).map((e) => e.type)).toEqual(["run.failed"]);
    expect(ctx.lines.some((l) => l.level === "error")).toBe(true);
  });

  it("every module failing makes the run failed, not partial", async () => {
    const reg = new ModuleRegistry().register({
      key: "bull_bear",
      version: "zta-1",
      inputs: { documents: true, history: false },
      run: async () => {
        throw new Error("down");
      },
    });
    const run = await claimedRun(SYM);
    const summary = await executeResearchRun(fakeContext(sql), run, { workerId: "zta-worker", registry: reg, asOf: AS_OF });
    expect(summary.status).toBe("failed");
    expect((await eventsOf(run.id)).at(-1)!.type).toBe("run.failed");
  });

  describe("after another worker re-claims the run (our lease expired)", () => {
    const steal = (runId: string) => sql`UPDATE research_runs SET worker_id = 'zta-thief', heartbeat_at = now() WHERE id = ${runId}`;
    const park = (runId: string) => researchRepo(sql).setStatus(runId, "cancelled");

    it("mid-modules: the stale worker writes no module result, terminal status or closing event", async () => {
      const run = await claimedRun(SYM);
      const reg = new ModuleRegistry()
        .register({
          key: "bull_bear",
          version: "zta-1",
          inputs: { documents: true, history: false },
          async run() {
            await steal(run.id);
            return { status: "done", payload: { stale: true } };
          },
        })
        .register({ key: "business_snapshot", version: "zta-1", inputs: { documents: true, history: false }, run: async () => ({ status: "done", payload: {} }) });
      const ctx = fakeContext(sql);
      const summary = await executeResearchRun(ctx, run, { workerId: "zta-worker", registry: reg, asOf: AS_OF, noModuleCache: true });

      expect(summary.status).toBe("superseded");
      expect((await researchRepo(sql).get(run.id))!).toMatchObject({ status: "synthesizing", worker_id: "zta-thief" });
      const modules = await researchRepo(sql).listModules(run.id);
      expect(modules.find((m) => m.module === "bull_bear")).toMatchObject({ status: "running", payload: null });
      const types = (await eventsOf(run.id)).map((e) => e.type);
      expect(types).not.toContain("run.completed");
      expect(types).not.toContain("run.failed");
      expect(types).not.toContain("module.completed");
      expect(ctx.lines.at(-1)).toMatchObject({ level: "warn", msg: "research run was re-claimed by another worker; stopped without writing to it" });
      await park(run.id);
    });

    it("during discovery: no further events, no documents processed or marked failed", async () => {
      const run = await claimedRun(SYM);
      screener.fetch.mockImplementationOnce(async (_http: unknown, symbol: string) => {
        await steal(run.id);
        return screenerCompany(symbol, baseLinks, HISTORY);
      });
      const before = await documentsRepo(sql).listBySymbol(SYM);
      const summary = await executeResearchRun(fakeContext(sql), run, { workerId: "zta-worker", registry: registry({ failBullBear: false }).reg, asOf: AS_OF });

      expect(summary).toMatchObject({ status: "superseded", documents: [], modules: [] });
      expect((await researchRepo(sql).get(run.id))!).toMatchObject({ status: "processing_docs", worker_id: "zta-thief" });
      expect((await eventsOf(run.id)).map((e) => e.type)).toEqual(["run.started"]);
      const after = await documentsRepo(sql).listBySymbol(SYM);
      expect(after.map((d) => [d.id, d.status])).toEqual(before.map((d) => [d.id, d.status]));
      await park(run.id);
    });

    it("before the failure write: a stale worker's crash does not fail the new owner's run", async () => {
      const run = await claimedRun(GHOST);
      await steal(run.id);
      const summary = await executeResearchRun(fakeContext(sql), run, { workerId: "zta-worker", registry: registry({ failBullBear: false }).reg });
      expect(summary.status).toBe("superseded");
      expect((await researchRepo(sql).get(run.id))!).toMatchObject({ status: "processing_docs", worker_id: "zta-thief", error: null });
      expect(await eventsOf(run.id)).toEqual([]);
      await park(run.id);
    });
  });
});

describe.skipIf(!reachable)("research command", () => {
  const SYMC = testSymbol("ZTACMD");
  beforeAll(async () => {
    await cleanupSymbols(sql, [SYMC]);
    await insertCompany(sql, SYMC);
    screener.fetch.mockImplementation(async (_http: unknown, symbol: string) => screenerCompany(symbol, [], HISTORY));
  });
  afterAll(() => cleanupSymbols(sql, [SYMC]));

  it("researches a symbol end to end with the requested history-only modules", async () => {
    const ctx = fakeContext(sql, { llm: { complete: async () => Promise.reject(new Error("LLM must not be called")) } });
    await researchCommand.run(ctx, { _: [], symbol: SYMC.toLowerCase(), modules: "financial_snapshot, cash_quality" });
    const [run] = await sql<ResearchRunRow[]>`SELECT * FROM research_runs WHERE symbol = ${SYMC}`;
    expect(run).toMatchObject({ status: "completed", modules: ["financial_snapshot", "cash_quality"], requested_by: "cli" });
    const evs = await eventsOf(run!.id);
    expect(evs[0]!.type).toBe("run.queued");
    expect(evs[1]!.type).toBe("run.started");
    const finished = ctx.lines.find((l) => l.msg === "research run finished");
    expect(finished?.obj).toMatchObject({ status: "completed", modules: ["financial_snapshot: done", "cash_quality: done"] });
  });

  it("rejects bad arguments with UsageError", async () => {
    const ctx = fakeContext(sql);
    await expect(researchCommand.run(ctx, { _: [], symbol: SYMC, modules: "bull_bear,astrology" })).rejects.toThrow(UsageError);
    await expect(researchCommand.run(ctx, { _: [], "run-id": "not-a-uuid" })).rejects.toThrow(/must be a UUID/);
    await expect(researchCommand.run(ctx, { _: [], "run-id": "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/does not exist/);
    await expect(researchCommand.run(ctx, { _: [] })).rejects.toThrow(UsageError);
  });

  it("does not touch a finished run or an active run owned by another worker", async () => {
    const [finished] = await sql<ResearchRunRow[]>`SELECT * FROM research_runs WHERE symbol = ${SYMC} AND status = 'completed' LIMIT 1`;
    const ctx = fakeContext(sql);
    await researchCommand.run(ctx, { _: [], "run-id": finished!.id });
    expect(ctx.lines.at(-1)).toMatchObject({ level: "warn", msg: "run is not claimable (finished, or another worker is active)" });

    const busy = await claimedRun(SYMC, "zta-someone-else");
    const ctx2 = fakeContext(sql);
    await researchCommand.run(ctx2, { _: [], symbol: SYMC });
    expect(ctx2.lines.at(-1)).toMatchObject({ level: "warn", msg: "an active run for this symbol is being processed by another worker" });
    expect((await researchRepo(sql).get(busy.id))!.worker_id).toBe("zta-someone-else");
    await researchRepo(sql).setStatus(busy.id, "cancelled");
    expect(await documentsRepo(sql).listBySymbol(SYMC)).toEqual([]);
  });
});
