import { hostname } from "node:os";
import { sleep } from "@finn/ai/util/concurrency";
import { researchRepo, type ResearchRunRow } from "@finn/db/repositories/research";
import { MODULE_KEYS, ModuleKeySchema, type ModuleKey } from "@finn/shared/contracts/research";
import { argFlag, argInt, argString, requireString, UsageError } from "../../args";
import type { Command, CommandArgs, WorkerContext } from "../../context";
import { executeResearchRun, type RunSummary } from "./executeRun";
import { retryDueModules } from "./retryModules";

const IDLE_POLL_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function workerId(): string {
  return `${hostname()}:${process.pid}`;
}

function parseModules(args: CommandArgs): ModuleKey[] {
  const raw = argString(args, "modules");
  if (!raw) return [...MODULE_KEYS];
  return raw.split(",").map((s) => {
    const parsed = ModuleKeySchema.safeParse(s.trim());
    if (!parsed.success) throw new UsageError(`Unknown module "${s}" (expected one of ${MODULE_KEYS.join(", ")})`);
    return parsed.data;
  });
}

function logSummary(ctx: WorkerContext, s: RunSummary): void {
  ctx.log.info(
    {
      runId: s.runId,
      symbol: s.symbol,
      status: s.status,
      documents: s.documents.map((d) => `${d.label}: ${d.status} (${d.pages}p, ${d.chunks} chunks)`),
      modules: s.modules.map((m) => `${m.key}: ${m.status}${m.cached ? " (cached)" : ""}${m.error ? ` - ${m.error}` : ""}`),
    },
    "research run finished",
  );
}

export const researchCommand: Command = {
  name: "research",
  description: "Research one company end to end: --symbol X [--run-id UUID] [--modules a,b] [--no-cache]",
  async run(ctx, args) {
    const repo = researchRepo(ctx.sql);
    const id = workerId();
    const runId = argString(args, "run-id");
    const noModuleCache = args.cache === false || argFlag(args, "no-module-cache");
    let run: ResearchRunRow | null;

    if (runId) {
      if (!UUID.test(runId)) throw new UsageError("--run-id must be a UUID");
      run = await repo.claimById(runId, id);
      if (!run) {
        const existing = await repo.get(runId);
        if (!existing) throw new UsageError(`Research run ${runId} does not exist`);
        ctx.log.warn({ runId, status: existing.status, workerId: existing.worker_id }, "run is not claimable (finished, or another worker is active)");
        return;
      }
    } else {
      const symbol = requireString(args, "symbol").toUpperCase();
      const { run: active, created } = await researchRepo(ctx.sql).createOrGetActive(symbol, parseModules(args), "cli");
      if (created) await repo.addEvent(active.id, "run.queued", `Queued research for ${symbol}`, { symbol });
      run = await repo.claimById(active.id, id);
      if (!run) {
        ctx.log.warn({ runId: active.id, status: active.status, workerId: active.worker_id }, "an active run for this symbol is being processed by another worker");
        return;
      }
    }
    logSummary(ctx, await executeResearchRun(ctx, run, { workerId: id, noModuleCache }));
  },
};

export const researchWorkerCommand: Command = {
  name: "research-worker",
  description: "Claim and process queued research runs (--once drains the queue and exits)",
  async run(ctx, args) {
    const repo = researchRepo(ctx.sql);
    const id = workerId();
    const once = argFlag(args, "once");
    let processed = 0;
    for (;;) {
      const run = await repo.claimNext(id);
      if (run) {
        ctx.log.info({ runId: run.id, symbol: run.symbol, workerId: id }, "claimed research run");
        logSummary(ctx, await executeResearchRun(ctx, run, { workerId: id }));
        processed++;
        continue;
      }
      if (once) break;
      await sleep(IDLE_POLL_MS);
    }
    ctx.log.info({ processed }, "research worker idle; exiting");
  },
};

export const moduleRetriesCommand: Command = {
  name: "module-retries",
  description: "Re-run research modules that failed or came back incomplete and are due a retry (--limit N, default 3; --symbol X)",
  async run(ctx, args) {
    const symbol = argString(args, "symbol")?.toUpperCase();
    const outcomes = await retryDueModules(ctx, { limit: argInt(args, "limit", 3), ...(symbol ? { symbols: [symbol] } : {}) });
    ctx.log.info({ retried: outcomes.map((o) => `${o.symbol}/${o.module}: ${o.result} (attempt ${o.attempts})`) }, "module retries finished");
  },
};

export const researchCommands: Command[] = [researchCommand, researchWorkerCommand, moduleRetriesCommand];

export { executeResearchRun, type RunSummary } from "./executeRun";
