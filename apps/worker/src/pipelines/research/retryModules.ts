import { istMidnight } from "@finn/ai/llm/client";
import { createDefaultModuleRegistry, moduleCacheKey, type ModuleRegistry } from "@finn/ai/modules/registry";
import type { ModuleContext } from "@finn/ai/modules/types";
import { documentsRepo } from "@finn/db/repositories/documents";
import { MODULE_RETRY_BACKOFF_MS, researchRepo, type ModuleRetryRow } from "@finn/db/repositories/research";
import { ModuleKeySchema } from "@finn/shared/contracts/research";
import type { WorkerContext } from "../../context";
import { loadModuleInputs } from "./moduleInputs";

export interface RetryOutcome {
  symbol: string;
  module: string;
  runId: string;
  /** resolved: a complete result was written; retrying / dead: the attempt fell short; dropped: nothing left to retry. */
  result: "resolved" | "retrying" | "dead" | "dropped";
  attempts: number;
  error?: string;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Re-runs modules that failed or came back incomplete. A failed attempt never replaces what the run already shows;
 * after the last backoff step the retry is dead-lettered.
 */
export async function retryDueModules(
  ctx: WorkerContext,
  opts: { registry?: ModuleRegistry; limit?: number; symbols?: readonly string[]; now?: () => Date } = {},
): Promise<RetryOutcome[]> {
  const repo = researchRepo(ctx.sql);
  const registry = opts.registry ?? createDefaultModuleRegistry();
  const now = opts.now ?? (() => new Date());
  const model = ctx.env.LLM_MODEL ?? "unknown";
  const due = await repo.claimDueModuleRetries(opts.limit ?? 3, now(), opts.symbols);
  const outcomes: RetryOutcome[] = [];

  for (const row of due) outcomes.push(await retryOne(row));
  return outcomes;

  async function shortfall(row: ModuleRetryRow, error: string, budgetSpent: boolean): Promise<RetryOutcome> {
    // A spent daily budget says nothing about the module, so it waits for the reset without using an attempt.
    const attempts = budgetSpent ? row.attempts : row.attempts + 1;
    const nextAttemptAt = budgetSpent
      ? new Date(istMidnight(now()).getTime() + DAY_MS + MODULE_RETRY_BACKOFF_MS[0]!)
      : attempts < MODULE_RETRY_BACKOFF_MS.length
        ? new Date(now().getTime() + MODULE_RETRY_BACKOFF_MS[attempts]!)
        : null;
    await repo.recordModuleRetryFailure({ symbol: row.symbol, module: row.module, attempts, reason: error, nextAttemptAt });
    const outcome = { symbol: row.symbol, module: row.module, runId: row.run_id, attempts, error };
    if (!nextAttemptAt) {
      ctx.log.error({ ...outcome }, "module retry dead-lettered after its last attempt");
      return { ...outcome, result: "dead" };
    }
    ctx.log.warn({ ...outcome, nextAttemptAt }, "module retry fell short; will try again");
    return { ...outcome, result: "retrying" };
  }

  /** Re-derives a finished run's status from its modules, by the same rule executeRun uses. */
  async function settleRunStatus(run: { id: string; status: string }): Promise<void> {
    if (run.status !== "partial" && run.status !== "failed") return;
    const modules = await repo.listModules(run.id);
    const failed = modules.filter((m) => m.status === "failed").length;
    const status = failed === 0 ? "completed" : failed === modules.length ? "failed" : "partial";
    if (status !== run.status) await repo.setStatus(run.id, status, { error: failed ? `${failed} module(s) failed` : null });
  }

  async function retryOne(row: ModuleRetryRow): Promise<RetryOutcome> {
    const key = ModuleKeySchema.safeParse(row.module);
    const runner = key.success ? registry.get(key.data) : undefined;
    const run = await repo.get(row.run_id);
    const companyName = await documentsRepo(ctx.sql).companyName(row.symbol);
    if (!key.success || !runner || !run || !companyName) {
      await repo.resolveModuleRetry(row.symbol, row.module);
      return { symbol: row.symbol, module: row.module, runId: row.run_id, result: "dropped", attempts: row.attempts };
    }

    const { documents, history } = await loadModuleInputs(ctx, row.symbol);
    const moduleCtx: ModuleContext = {
      symbol: row.symbol,
      companyName,
      runId: run.id,
      sql: ctx.sql,
      llm: ctx.llm,
      embeddings: ctx.embeddings,
      documents,
      history,
      asOf: now(),
      log: (message, data) => ctx.log.info({ runId: run.id, retry: row.module, ...data }, message),
    };
    const cacheKey = moduleCacheKey(runner, moduleCtx, model);
    const attempt = row.attempts + 1;

    let result;
    try {
      result = await runner.run(moduleCtx);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return shortfall(row, message, (err as { name?: string } | null)?.name === "BudgetExceededError");
    }

    if (result.status === "done") {
      await repo.upsertModule(run.id, key.data, "done", { payload: result.payload, cacheKey, error: null });
    } else {
      await repo.upsertModule(run.id, key.data, "insufficient_sources", { cacheKey, error: result.reason });
    }
    await repo.addEvent(run.id, "module.completed", `${runner.key} rebuilt on retry attempt ${attempt}`, { key: key.data, status: result.status, retry: attempt });
    await settleRunStatus(run);
    if (result.status === "done" && result.incomplete) return shortfall(row, result.incomplete, false);

    await repo.putModuleCache({
      cacheKey,
      symbol: row.symbol,
      module: key.data,
      status: result.status,
      payload: result.status === "done" ? result.payload : { reason: result.reason },
    });
    await repo.resolveModuleRetry(row.symbol, row.module);
    ctx.log.info({ symbol: row.symbol, module: row.module, runId: run.id, attempt }, "module retry succeeded");
    return { symbol: row.symbol, module: row.module, runId: run.id, result: "resolved", attempts: attempt };
  }
}
