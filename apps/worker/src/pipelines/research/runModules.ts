import { moduleCacheKey, type ModuleRegistry } from "@finn/ai/modules/registry";
import type { ModuleContext, ResearchModulePayload } from "@finn/ai/modules/types";
import { mapWithConcurrency } from "@finn/ai/util/concurrency";
import type { ResearchRepo } from "@finn/db/repositories/research";
import type { ModuleKey } from "@finn/shared/contracts/research";

export interface ModuleOutcome {
  key: ModuleKey;
  status: "done" | "insufficient_sources" | "failed";
  cached: boolean;
  error?: string;
}

const MODULE_CONCURRENCY = 3;

const LABELS: Record<ModuleKey, string> = {
  promise_ledger: "Promise Ledger",
  financial_snapshot: "Financial snapshot",
  cash_quality: "Cash quality",
  bull_bear: "Bull / bear case",
  business_snapshot: "Business snapshot",
};

/**
 * Runs modules with bounded concurrency. Each module's state and events are written as it finishes, so the UI
 * can render modules progressively; a module failure is contained to that module.
 */
export async function runModules(opts: {
  runId: string;
  keys: readonly ModuleKey[];
  registry: ModuleRegistry;
  ctx: ModuleContext;
  repo: ResearchRepo;
  model: string;
  useCache: boolean;
}): Promise<ModuleOutcome[]> {
  const { runId, repo, ctx } = opts;
  const runners = opts.registry.list(opts.keys);
  for (const r of runners) await repo.upsertModule(runId, r.key, "pending");

  return mapWithConcurrency(runners, MODULE_CONCURRENCY, async (runner): Promise<ModuleOutcome> => {
    const key = runner.key;
    const cacheKey = moduleCacheKey(runner, ctx, opts.model);
    await repo.upsertModule(runId, key, "running", { cacheKey });
    await repo.addEvent(runId, "module.started", `${LABELS[key]}: working`, { key });
    const started = Date.now();
    try {
      let result: ResearchModulePayload | null = null;
      let cached = false;
      if (opts.useCache) {
        const hit = await repo.getModuleCache(cacheKey);
        if (hit) {
          cached = true;
          result =
            hit.status === "insufficient_sources"
              ? { status: "insufficient_sources", payload: null, reason: String((hit.payload as { reason?: unknown })?.reason ?? "Insufficient sources") }
              : { status: "done", payload: hit.payload };
        }
      }
      if (!result) {
        result = await runner.run(ctx);
        if (!(result.status === "done" && result.incomplete)) {
          await repo.putModuleCache({
            cacheKey,
            symbol: ctx.symbol,
            module: key,
            status: result.status,
            payload: result.status === "done" ? result.payload : { reason: result.reason },
          });
        }
      }

      if (result.status === "done") {
        await repo.upsertModule(runId, key, "done", { payload: result.payload, cacheKey });
        await repo.addEvent(runId, "module.completed", `${LABELS[key]} ready`, { key, status: "done", cached, ms: Date.now() - started });
        if (result.incomplete) await repo.scheduleModuleRetry({ symbol: ctx.symbol, module: key, runId, reason: result.incomplete });
        else await repo.resolveModuleRetry(ctx.symbol, key);
      } else {
        await repo.resolveModuleRetry(ctx.symbol, key);
        await repo.upsertModule(runId, key, "insufficient_sources", { cacheKey, error: result.reason });
        await repo.addEvent(runId, "module.completed", `${LABELS[key]}: not enough source material`, {
          key,
          status: "insufficient_sources",
          reason: result.reason,
          cached,
        });
      }
      return { key, status: result.status, cached };
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await repo.upsertModule(runId, key, "failed", { error: message.slice(0, 500) });
      await repo.addEvent(runId, "module.failed", `${LABELS[key]} failed`, { key, error: message.slice(0, 300) });
      await repo.scheduleModuleRetry({ symbol: ctx.symbol, module: key, runId, reason: message });
      return { key, status: "failed", cached: false, error: message };
    }
  });
}
