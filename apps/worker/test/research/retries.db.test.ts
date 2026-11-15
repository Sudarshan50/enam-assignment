import { BudgetExceededError, LlmValidationError } from "@finn/ai/llm/errors";
import { ModuleRegistry } from "@finn/ai/modules/registry";
import type { ResearchModulePayload } from "@finn/ai/modules/types";
import { MODULE_RETRY_BACKOFF_MS, researchRepo } from "@finn/db/repositories/research";
import type { ModuleKey } from "@finn/shared/contracts/research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retryDueModules } from "../../src/pipelines/research/retryModules";
import { cleanupSymbols, connect, fakeContext, insertCompany, testSymbol } from "./helpers";

const S = {
  CLAIM: testSymbol("ZTARTCLAIM"),
  FIX: testSymbol("ZTARTFIX"),
  DEAD: testSymbol("ZTARTDEAD"),
  PART: testSymbol("ZTARTPART"),
  DROP: testSymbol("ZTARTDROP"),
};
const SYMBOLS = Object.values(S);
const { sql, reachable } = await connect(4);
const MIN = 60_000;
const T0 = new Date("2026-11-15T06:00:00Z");

describe.skipIf(!reachable)("module retries", () => {
  const repo = researchRepo(sql);
  beforeAll(async () => {
    await cleanupSymbols(sql, SYMBOLS);
    for (const s of SYMBOLS) await insertCompany(sql, s);
  });
  afterAll(async () => {
    await cleanupSymbols(sql, SYMBOLS);
    await sql.end({ timeout: 5 });
  });

  /** A finished run whose ledger failed (or came back incomplete), with its retry scheduled at T0. */
  async function finishedRun(symbol: string, ledger: { status: "failed" | "done"; payload?: unknown }, runStatus: "partial" | "completed"): Promise<string> {
    const { run } = await repo.createOrGetActive(symbol, ["promise_ledger", "financial_snapshot"], null);
    await repo.upsertModule(run.id, "financial_snapshot", "done", { payload: { ok: true } });
    await repo.upsertModule(run.id, "promise_ledger", ledger.status, ledger.status === "done" ? { payload: ledger.payload } : { error: "LlmValidationError: invalid JSON" });
    await repo.setStatus(run.id, runStatus);
    await repo.scheduleModuleRetry({ symbol, module: "promise_ledger", runId: run.id, reason: "first try fell short" }, T0);
    return run.id;
  }

  function ledgerRegistry(run: () => Promise<ResearchModulePayload>): { reg: ModuleRegistry; calls: () => number } {
    let n = 0;
    const reg = new ModuleRegistry();
    reg.register({
      key: "promise_ledger" as ModuleKey,
      version: "zta-retry-1",
      inputs: { documents: true, history: false },
      async run() {
        n++;
        return run();
      },
    });
    return { reg, calls: () => n };
  }

  const ledgerRow = async (runId: string) => (await repo.listModules(runId)).find((m) => m.module === "promise_ledger");

  describe("repository", () => {
    it("claims a due retry once, leases it, and leaves it alone while the symbol has an active run", async () => {
      const { run } = await repo.createOrGetActive(S.CLAIM, ["promise_ledger"], null);
      await repo.setStatus(run.id, "completed");
      await repo.scheduleModuleRetry({ symbol: S.CLAIM, module: "promise_ledger", runId: run.id, reason: "cut off" }, T0);

      expect(await repo.claimDueModuleRetries(5, new Date(T0.getTime() + 4 * MIN), [S.CLAIM])).toEqual([]);
      const due = new Date(T0.getTime() + MODULE_RETRY_BACKOFF_MS[0]!);
      const [claimed, ...rest] = await repo.claimDueModuleRetries(5, due, [S.CLAIM]);
      expect(rest).toEqual([]);
      expect(claimed).toMatchObject({ symbol: S.CLAIM, module: "promise_ledger", run_id: run.id, status: "pending", attempts: 0, reason: "cut off" });
      expect(claimed!.next_attempt_at.getTime()).toBe(due.getTime() + 15 * MIN);
      expect(await repo.claimDueModuleRetries(5, due, [S.CLAIM])).toEqual([]);

      const later = new Date(due.getTime() + 16 * MIN);
      const { run: active } = await repo.createOrGetActive(S.CLAIM, ["promise_ledger"], null);
      expect(await repo.claimDueModuleRetries(5, later, [S.CLAIM])).toEqual([]);
      await repo.setStatus(active.id, "cancelled");
      expect(await repo.claimDueModuleRetries(5, later, [S.CLAIM])).toHaveLength(1);
      expect(await repo.claimDueModuleRetries(5, later, [])).toEqual([]);
    });

    it("records failed attempts, dead-letters on request, and a fresh schedule starts over", async () => {
      const { run } = await repo.createOrGetActive(S.CLAIM, ["promise_ledger"], null);
      await repo.setStatus(run.id, "completed");
      await repo.scheduleModuleRetry({ symbol: S.CLAIM, module: "promise_ledger", runId: run.id, reason: "cut off" }, T0);
      const next = new Date(T0.getTime() + 60 * MIN);
      await repo.recordModuleRetryFailure({ symbol: S.CLAIM, module: "promise_ledger", attempts: 2, reason: "still cut off", nextAttemptAt: next });
      expect(await repo.getModuleRetry(S.CLAIM, "promise_ledger")).toMatchObject({ status: "pending", attempts: 2, reason: "still cut off", next_attempt_at: next });

      await repo.recordModuleRetryFailure({ symbol: S.CLAIM, module: "promise_ledger", attempts: 5, reason: "gave up", nextAttemptAt: null });
      expect(await repo.getModuleRetry(S.CLAIM, "promise_ledger")).toMatchObject({ status: "dead", attempts: 5, next_attempt_at: next });
      expect(await repo.claimDueModuleRetries(5, new Date(T0.getTime() + 24 * 60 * MIN), [S.CLAIM])).toEqual([]);

      await repo.scheduleModuleRetry({ symbol: S.CLAIM, module: "promise_ledger", runId: run.id, reason: "new run fell short" }, T0);
      expect(await repo.getModuleRetry(S.CLAIM, "promise_ledger")).toMatchObject({ status: "pending", attempts: 0 });
      await repo.resolveModuleRetry(S.CLAIM, "promise_ledger");
      expect((await repo.getModuleRetry(S.CLAIM, "promise_ledger"))?.status).toBe("resolved");
    });
  });

  describe("retryDueModules", () => {
    const at = (ms: number) => () => new Date(T0.getTime() + ms);

    it("writes a complete retry into the run, caches it, resolves the retry and completes the partial run", async () => {
      const runId = await finishedRun(S.FIX, { status: "failed" }, "partial");
      const { reg } = ledgerRegistry(async () => ({ status: "done", payload: { fixed: true } }));
      const out = await retryDueModules(fakeContext(sql), { registry: reg, symbols: [S.FIX], now: at(6 * MIN) });

      expect(out).toEqual([{ symbol: S.FIX, module: "promise_ledger", runId, result: "resolved", attempts: 1 }]);
      expect(await ledgerRow(runId)).toMatchObject({ status: "done", payload: { fixed: true }, error: null });
      expect((await repo.get(runId))?.status).toBe("completed");
      expect((await repo.getModuleRetry(S.FIX, "promise_ledger"))?.status).toBe("resolved");
      const [cached] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM module_cache WHERE symbol = ${S.FIX} AND module = 'promise_ledger'`;
      expect(cached!.n).toBe(1);
      const [ev] = await sql<{ data: Record<string, unknown> }[]>`SELECT data FROM research_events WHERE run_id = ${runId} AND type = 'module.completed'`;
      expect(ev!.data).toMatchObject({ key: "promise_ledger", status: "done", retry: 1 });
    });

    it("keeps what the run shows when a retry fails, backs off, and dead-letters after the last attempt", async () => {
      const runId = await finishedRun(S.DEAD, { status: "done", payload: { partial: true } }, "completed");
      const { reg, calls } = ledgerRegistry(async () => {
        throw new LlmValidationError("guidance_extract: invalid JSON", "guidance_extract");
      });
      const ctx = fakeContext(sql);
      let now = T0.getTime() + MODULE_RETRY_BACKOFF_MS[0]!;
      for (let attempt = 1; attempt <= MODULE_RETRY_BACKOFF_MS.length; attempt++) {
        const [o] = await retryDueModules(ctx, { registry: reg, symbols: [S.DEAD], now: () => new Date(now) });
        const last = attempt === MODULE_RETRY_BACKOFF_MS.length;
        expect(o).toMatchObject({ result: last ? "dead" : "retrying", attempts: attempt, error: "LlmValidationError: guidance_extract: invalid JSON" });
        const row = await repo.getModuleRetry(S.DEAD, "promise_ledger");
        expect(row).toMatchObject({ status: last ? "dead" : "pending", attempts: attempt });
        if (!last) {
          expect(row!.next_attempt_at.getTime()).toBe(now + MODULE_RETRY_BACKOFF_MS[attempt]!);
          expect(await retryDueModules(ctx, { registry: reg, symbols: [S.DEAD], now: () => new Date(now + MODULE_RETRY_BACKOFF_MS[attempt]! - 1) })).toEqual([]);
        }
        now += MODULE_RETRY_BACKOFF_MS[attempt] ?? 0;
      }
      expect(calls()).toBe(MODULE_RETRY_BACKOFF_MS.length);
      expect(await ledgerRow(runId)).toMatchObject({ status: "done", payload: { partial: true } });
      expect(await retryDueModules(ctx, { registry: reg, symbols: [S.DEAD], now: () => new Date(now + 24 * 60 * MIN) })).toEqual([]);
      expect(ctx.lines.some((l) => l.level === "error" && l.msg === "module retry dead-lettered after its last attempt")).toBe(true);
    });

    it("shows an incomplete retry over a failure but keeps retrying, and a spent budget waits for midnight without using an attempt", async () => {
      const runId = await finishedRun(S.PART, { status: "failed" }, "partial");
      let reply: () => Promise<ResearchModulePayload> = async () => ({ status: "done", payload: { partial: true }, incomplete: "Could not read Q1 FY27 concall: cut off" });
      const { reg } = ledgerRegistry(() => reply());
      const [o] = await retryDueModules(fakeContext(sql), { registry: reg, symbols: [S.PART], now: at(6 * MIN) });
      expect(o).toMatchObject({ result: "retrying", attempts: 1, error: "Could not read Q1 FY27 concall: cut off" });
      expect(await ledgerRow(runId)).toMatchObject({ status: "done", payload: { partial: true } });
      expect((await repo.getModuleRetry(S.PART, "promise_ledger"))?.next_attempt_at.getTime()).toBe(T0.getTime() + 6 * MIN + MODULE_RETRY_BACKOFF_MS[1]!);
      const [cached] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM module_cache WHERE symbol = ${S.PART}`;
      expect(cached!.n).toBe(0);

      reply = async () => {
        throw new BudgetExceededError(500, 500);
      };
      const [b] = await retryDueModules(fakeContext(sql), { registry: reg, symbols: [S.PART], now: at(6 * MIN + MODULE_RETRY_BACKOFF_MS[1]!) });
      expect(b).toMatchObject({ result: "retrying", attempts: 1 });
      // T0 is 11:30 IST on 15 Nov; the budget resets at midnight IST, and the retry goes 5 minutes after it.
      expect((await repo.getModuleRetry(S.PART, "promise_ledger"))?.next_attempt_at.toISOString()).toBe("2026-11-15T18:35:00.000Z");
    });

    it("drops a retry for a module that no longer exists", async () => {
      const { run } = await repo.createOrGetActive(S.DROP, ["promise_ledger"], null);
      await repo.setStatus(run.id, "completed");
      await repo.scheduleModuleRetry({ symbol: S.DROP, module: "retired_module", runId: run.id, reason: "x" }, T0);
      const { reg, calls } = ledgerRegistry(async () => ({ status: "done", payload: {} }));
      const [o] = await retryDueModules(fakeContext(sql), { registry: reg, symbols: [S.DROP], now: at(6 * MIN) });
      expect(o).toMatchObject({ result: "dropped", module: "retired_module" });
      expect(calls()).toBe(0);
      expect((await repo.getModuleRetry(S.DROP, "retired_module"))?.status).toBe("resolved");
    });
  });
});
