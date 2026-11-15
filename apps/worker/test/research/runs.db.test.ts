import type { Sql } from "@finn/db";
import { ModuleRegistry } from "@finn/ai/modules/registry";
import type { ModuleContext, ResearchModulePayload, ResearchModuleRunner } from "@finn/ai/modules/types";
import { researchRepo, type ResearchRunRow } from "@finn/db/repositories/research";
import type { ModuleKey } from "@finn/shared/contracts/research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runModules } from "../../src/pipelines/research/runModules";
import { cleanupSymbols, connect, fakeEmbeddings, fakeLlm, TAG, testSymbol } from "./helpers";

const S = {
  RUN: testSymbol("ZTARUN"),
  RUNC: testSymbol("ZTARUNC"),
  RUNI: testSymbol("ZTARUNI"),
  CLM: testSymbol("ZTACLM"),
  CLMA: testSymbol("ZTACLMA"),
  CLMB: testSymbol("ZTACLMB"),
  RMOD: testSymbol("ZTARMOD"),
};
const SYMBOLS = Object.values(S);
const { sql, reachable } = await connect(6);

async function events(runId: string): Promise<{ type: string; data: Record<string, unknown> | null }[]> {
  return sql`SELECT type, data FROM research_events WHERE run_id = ${runId} ORDER BY id`;
}

/** Parks a run so no worker (ours or another tester's) can claim it. */
async function park(id: string): Promise<void> {
  await researchRepo(sql).setStatus(id, "cancelled");
}

describe.skipIf(!reachable)("research runs repository", () => {
  const repo = researchRepo(sql);
  beforeAll(() => cleanupSymbols(sql, SYMBOLS));
  afterAll(async () => {
    await cleanupSymbols(sql, SYMBOLS);
    await sql.end({ timeout: 5 });
  });

  describe("createOrGetActive and the one-active-run-per-symbol index", () => {
    it("reuses the active run for a symbol, and creates a fresh one once it finishes", async () => {
      const a = await repo.createOrGetActive(S.RUN, ["bull_bear"], "zta-test");
      expect(a).toMatchObject({ created: true, run: { status: "queued", modules: ["bull_bear"], requested_by: "zta-test" } });
      const b = await repo.createOrGetActive(S.RUN, ["cash_quality"], "zta-other");
      expect(b.created).toBe(false);
      expect(b.run.id).toBe(a.run.id);
      expect(b.run.modules).toEqual(["bull_bear"]);

      await repo.setStatus(a.run.id, "completed");
      const c = await repo.createOrGetActive(S.RUN, [], null);
      expect(c.created).toBe(true);
      expect(c.run.id).not.toBe(a.run.id);
      await park(c.run.id);
    });

    it("concurrent requests for one symbol create exactly one run", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => repo.createOrGetActive(S.RUNC, [], "zta-test")));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
      const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM research_runs WHERE symbol = ${S.RUNC}`;
      expect(count!.n).toBe(1);
      await park(results[0]!.run.id);
    });

    it("the partial unique index rejects a second active row but allows any number of finished ones", async () => {
      const { run } = await repo.createOrGetActive(S.RUNI, [], null);
      await expect(sql`INSERT INTO research_runs (symbol, modules, status) VALUES (${S.RUNI}, '{}', 'synthesizing')`).rejects.toMatchObject({ code: "23505" });
      await sql`INSERT INTO research_runs (symbol, modules, status) VALUES (${S.RUNI}, '{}', 'completed'), (${S.RUNI}, '{}', 'failed')`;
      await park(run.id);
    });
  });

  describe("claiming", () => {
    it("two workers racing for the same run: exactly one wins", async () => {
      const { run } = await repo.createOrGetActive(S.CLM, [], null);
      const claims = await Promise.all(["zta-w1", "zta-w2", "zta-w3"].map((w) => repo.claimById(run.id, w)));
      const winners = claims.filter((c): c is ResearchRunRow => c !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ status: "processing_docs" });
      expect(winners[0]!.claimed_at).toBeInstanceOf(Date);

      expect(await repo.claimById(run.id, "zta-late")).toBeNull();
      await park(run.id);
    });

    it("re-claims a run whose worker stopped heartbeating; the old worker's heartbeat no longer lands", async () => {
      const { run } = await repo.createOrGetActive(S.CLM, [], null);
      await repo.claimById(run.id, "zta-old");
      await sql`UPDATE research_runs SET heartbeat_at = now() - interval '299 seconds' WHERE id = ${run.id}`;
      expect(await repo.claimById(run.id, "zta-new")).toBeNull();
      await sql`UPDATE research_runs SET heartbeat_at = now() - interval '301 seconds' WHERE id = ${run.id}`;
      expect(await repo.claimById(run.id, "zta-new")).toMatchObject({ worker_id: "zta-new" });

      await sql`UPDATE research_runs SET heartbeat_at = '2000-01-01' WHERE id = ${run.id}`;
      await repo.heartbeat(run.id, "zta-old");
      expect((await repo.get(run.id))!.heartbeat_at!.getUTCFullYear()).toBe(2000);
      await repo.heartbeat(run.id, "zta-new");
      expect((await repo.get(run.id))!.heartbeat_at!.getUTCFullYear()).toBeGreaterThan(2000);

      await repo.setStatus(run.id, "completed");
      expect(await repo.claimById(run.id, "zta-new")).toBeNull();
    });

    it("after a re-claim, the old worker's status, module and event writes no longer land; the new owner's do", async () => {
      const { run } = await repo.createOrGetActive(S.CLM, [], null);
      await repo.claimById(run.id, "zta-old");
      await sql`UPDATE research_runs SET heartbeat_at = now() - interval '301 seconds' WHERE id = ${run.id}`;
      expect(await repo.claimById(run.id, "zta-new")).toMatchObject({ worker_id: "zta-new" });

      expect(await repo.heartbeat(run.id, "zta-old")).toBe(false);
      expect(await repo.setStatusAsOwner(run.id, "zta-old", "completed", {}, { type: "run.completed", message: "stale" })).toBe(false);
      expect(await repo.upsertModuleAsOwner(run.id, "zta-old", "bull_bear", "done", { payload: { stale: true } })).toBe(false);
      expect(await repo.addEventAsOwner(run.id, "zta-old", "module.completed", "stale")).toBe(false);
      expect((await repo.get(run.id))!).toMatchObject({ status: "processing_docs", worker_id: "zta-new" });
      expect(await repo.listModules(run.id)).toEqual([]);
      expect(await events(run.id)).toEqual([]);

      expect(await repo.heartbeat(run.id, "zta-new")).toBe(true);
      expect(await repo.upsertModuleAsOwner(run.id, "zta-new", "bull_bear", "done", { payload: { v: 1 }, cacheKey: "k" })).toBe(true);
      expect(await repo.addEventAsOwner(run.id, "zta-new", "module.completed", "ok", { key: "bull_bear" })).toBe(true);
      expect(await repo.setStatusAsOwner(run.id, "zta-new", "completed", {}, { type: "run.completed", message: "done", data: { status: "completed" } })).toBe(true);
      expect((await repo.get(run.id))!.status).toBe("completed");
      expect(await repo.listModules(run.id)).toMatchObject([{ module: "bull_bear", status: "done", payload: { v: 1 } }]);
      expect(await events(run.id)).toEqual([
        { type: "module.completed", data: { key: "bull_bear" } },
        { type: "run.completed", data: { status: "completed" } },
      ]);

      // A finished run takes no further owner status writes, even from its own worker.
      expect(await repo.setStatusAsOwner(run.id, "zta-new", "failed", { error: "late" }, { type: "run.failed", message: "late" })).toBe(false);
      expect((await repo.get(run.id))!).toMatchObject({ status: "completed", error: null });
      expect(await events(run.id)).toHaveLength(2);
    });

    it("claimNext with SKIP LOCKED: two concurrent claimers never get the same run, and neither blocks", async () => {
      // Oldest possible created_at so these are the queue head; claims happen in transactions that are rolled
      // back, so no other run in the shared queue is ever modified.
      const [a, b] = await sql<{ id: string }[]>`
        INSERT INTO research_runs (symbol, modules, created_at) VALUES
          (${S.CLMA}, '{}', '1990-01-01T00:00:00Z'), (${S.CLMB}, '{}', '1990-01-02T00:00:00Z')
        RETURNING id`;
      const c1 = await sql.reserve();
      const c2 = await sql.reserve();
      try {
        await c1`BEGIN`;
        await c2`BEGIN`;
        await c2`SET LOCAL lock_timeout = '3s'`;
        const first = await researchRepo(c1 as unknown as Sql).claimNext("zta-w1");
        const second = await researchRepo(c2 as unknown as Sql).claimNext("zta-w2");
        // Another copy of this suite may hold its own 1990 rows, so assert the invariant rather than exact ids.
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(second!.id).not.toBe(first!.id);
        expect([first!.created_at.getUTCFullYear(), second!.created_at.getUTCFullYear()]).toEqual([1990, 1990]);
        expect(second!.worker_id).toBe("zta-w2");
      } finally {
        await c1`ROLLBACK`.catch(() => {});
        await c2`ROLLBACK`.catch(() => {});
        c1.release();
        c2.release();
        await sql`DELETE FROM research_runs WHERE id IN (${a!.id}, ${b!.id})`;
      }
    });
  });

  describe("events, module rows and the module cache", () => {
    it("events keep insertion order and accept null data", async () => {
      const { run } = await repo.createOrGetActive(S.RUN, [], null);
      await repo.addEvent(run.id, "run.started", "s", { n: 1 });
      await repo.addEvent(run.id, "module.started", "m");
      await repo.addEvent(run.id, "run.completed", "c", { nested: { ok: true } });
      expect(await events(run.id)).toEqual([
        { type: "run.started", data: { n: 1 } },
        { type: "module.started", data: null },
        { type: "run.completed", data: { nested: { ok: true } } },
      ]);
      await park(run.id);
    });

    it("upsertModule keeps the last payload and cache key when a later update omits them", async () => {
      const { run } = await repo.createOrGetActive(S.RUN, [], null);
      await repo.upsertModule(run.id, "bull_bear", "pending");
      await repo.upsertModule(run.id, "bull_bear", "done", { payload: { v: 1 }, cacheKey: "k1" });
      await repo.upsertModule(run.id, "bull_bear", "failed", { error: "boom" });
      const [row] = await repo.listModules(run.id);
      expect(row).toMatchObject({ module: "bull_bear", status: "failed", payload: { v: 1 }, error: "boom" });
      const [mod] = await sql<{ cache_key: string }[]>`SELECT cache_key FROM research_modules WHERE run_id = ${run.id}`;
      expect(mod!.cache_key).toBe("k1");
      await park(run.id);
    });

    it("module cache entries are overwritten by key", async () => {
      await repo.putModuleCache({ cacheKey: `zta-key-1-${TAG}`, symbol: S.RUN, module: "bull_bear", status: "done", payload: { a: 1 } });
      await repo.putModuleCache({ cacheKey: `zta-key-1-${TAG}`, symbol: S.RUN, module: "bull_bear", status: "insufficient_sources", payload: { reason: "r" } });
      expect(await repo.getModuleCache(`zta-key-1-${TAG}`)).toEqual({
        cache_key: `zta-key-1-${TAG}`,
        symbol: S.RUN,
        module: "bull_bear",
        status: "insufficient_sources",
        payload: { reason: "r" },
      });
      expect(await repo.getModuleCache(`zta-key-missing-${TAG}`)).toBeNull();
    });
  });

  describe("runModules", () => {
    const KEYS: ModuleKey[] = ["promise_ledger", "financial_snapshot", "cash_quality", "bull_bear", "business_snapshot"];

    function registry(behaviour: Partial<Record<ModuleKey, () => Promise<ResearchModulePayload>>>) {
      const calls: ModuleKey[] = [];
      let active = 0;
      let peak = 0;
      const reg = new ModuleRegistry();
      for (const key of KEYS) {
        const runner: ResearchModuleRunner = {
          key,
          version: "zta-1",
          inputs: { documents: false, history: false },
          async run() {
            calls.push(key);
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 25));
            active--;
            return (behaviour[key] ?? (async () => ({ status: "done" as const, payload: { key } })))();
          },
        };
        reg.register(runner);
      }
      return { reg, calls, peak: () => peak };
    }

    const ctx = (runId: string): ModuleContext => ({
      symbol: S.RMOD,
      companyName: "Zeta Modules Ltd",
      runId,
      sql,
      llm: fakeLlm({}),
      embeddings: fakeEmbeddings(),
      documents: [],
      history: {},
      asOf: new Date("2026-11-15T06:00:00Z"),
    });

    async function newRun(): Promise<string> {
      const { run } = await repo.createOrGetActive(S.RMOD, [], null);
      return run.id;
    }

    const behaviour = {
      bull_bear: async () => {
        throw new TypeError("model returned garbage");
      },
      cash_quality: async () => ({ status: "insufficient_sources" as const, payload: null, reason: "Fewer than 3 years of cash flows" }),
    };

    it("runs at most 3 modules at once and contains a failure to its module", async () => {
      const runId = await newRun();
      const { reg, calls, peak } = registry(behaviour);
      const out = await runModules({ runId, keys: KEYS, registry: reg, ctx: ctx(runId), repo, model: "zta-model", useCache: true });

      expect(peak()).toBe(3);
      expect(calls.sort()).toEqual([...KEYS].sort());
      expect(out.map((o) => [o.key, o.status, o.cached])).toEqual([
        ["promise_ledger", "done", false],
        ["financial_snapshot", "done", false],
        ["cash_quality", "insufficient_sources", false],
        ["bull_bear", "failed", false],
        ["business_snapshot", "done", false],
      ]);
      expect(out.find((o) => o.key === "bull_bear")!.error).toBe("TypeError: model returned garbage");

      const rows = Object.fromEntries((await repo.listModules(runId)).map((r) => [r.module, r]));
      expect(rows.bull_bear).toMatchObject({ status: "failed", error: "TypeError: model returned garbage", payload: null });
      expect(rows.cash_quality).toMatchObject({ status: "insufficient_sources", error: "Fewer than 3 years of cash flows" });
      expect(rows.promise_ledger).toMatchObject({ status: "done", payload: { key: "promise_ledger" } });

      const evs = await events(runId);
      for (const key of KEYS) {
        const started = evs.findIndex((e) => e.type === "module.started" && e.data?.key === key);
        const ended = evs.findIndex((e) => (e.type === "module.completed" || e.type === "module.failed") && e.data?.key === key);
        expect(started).toBeGreaterThanOrEqual(0);
        expect(ended).toBeGreaterThan(started);
      }
      await park(runId);
    });

    it("serves unchanged modules from module_cache (including insufficient_sources) but never caches failures", async () => {
      const runId = await newRun();
      const { reg, calls } = registry(behaviour);
      const out = await runModules({ runId, keys: KEYS, registry: reg, ctx: ctx(runId), repo, model: "zta-model", useCache: true });
      expect(calls).toEqual(["bull_bear"]);
      expect(out.filter((o) => o.cached).map((o) => o.key)).toEqual(["promise_ledger", "financial_snapshot", "cash_quality", "business_snapshot"]);
      expect(out.find((o) => o.key === "cash_quality")).toMatchObject({ status: "insufficient_sources", cached: true });
      const rows = Object.fromEntries((await repo.listModules(runId)).map((r) => [r.module, r]));
      expect(rows.cash_quality!.error).toBe("Fewer than 3 years of cash flows");
      const completed = (await events(runId)).filter((e) => e.type === "module.completed");
      expect(completed.every((e) => e.data?.cached === true)).toBe(true);
      await park(runId);
    });

    it("shows a result marked not cacheable but computes it again on the next run", async () => {
      const incomplete = { promise_ledger: async () => ({ status: "done" as const, payload: { key: "promise_ledger", partial: true }, cacheable: false as const }) };
      const keys: ModuleKey[] = ["promise_ledger", "financial_snapshot"];
      for (const expected of [["financial_snapshot", "promise_ledger"], ["promise_ledger"]]) {
        const runId = await newRun();
        const { reg, calls } = registry(incomplete);
        const out = await runModules({ runId, keys, registry: reg, ctx: ctx(runId), repo, model: "zta-model-incomplete", useCache: true });
        expect(calls.sort()).toEqual(expected);
        expect(out.find((o) => o.key === "promise_ledger")).toMatchObject({ status: "done", cached: false });
        const rows = Object.fromEntries((await repo.listModules(runId)).map((r) => [r.module, r]));
        expect(rows.promise_ledger).toMatchObject({ status: "done", payload: { key: "promise_ledger", partial: true } });
        await park(runId);
      }
    });

    it("re-runs everything when the cache is bypassed or the model changes", async () => {
      for (const [model, useCache] of [
        ["zta-model", false],
        ["zta-model-2", true],
      ] as const) {
        const runId = await newRun();
        const { reg, calls } = registry({});
        const out = await runModules({ runId, keys: ["promise_ledger", "bull_bear"], registry: reg, ctx: ctx(runId), repo, model, useCache });
        expect(calls.sort()).toEqual(["bull_bear", "promise_ledger"]);
        expect(out.every((o) => !o.cached && o.status === "done")).toBe(true);
        await park(runId);
      }
    });
  });
});
