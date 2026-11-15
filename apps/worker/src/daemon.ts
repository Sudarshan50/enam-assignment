import { closeDb } from "@finn/db";
import { buildRegistry, loadResearchCommands } from "./commands";
import { createLogger, createWorkerContext } from "./container";
import type { CommandArgs } from "./context";
import { DEFAULT_JOBS, dueJobs } from "./daemon/schedule";

/**
 * Long-running worker for single-host deployments: runs the ingest/EOD schedule and drains the
 * research queue in the same process. Jobs run one at a time so they never overlap.
 */
const TICK_MS = 30_000;

async function main(): Promise<void> {
  const log = createLogger(process.env);
  const research = await loadResearchCommands();
  if (research.error) log.error({ error: research.error.message }, "research commands unavailable");
  const registry = buildRegistry(research.commands);
  const ctx = createWorkerContext(process.env);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "daemon stopping");
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const researchWorker = registry.get("research-worker");
  const researchLoop = researchWorker
    ? (async () => {
        for (;;) {
          try {
            await researchWorker.run(ctx, { _: [] });
          } catch (err) {
            log.error({ error: err instanceof Error ? (err.stack ?? err.message) : String(err) }, "research worker crashed; restarting");
          }
          if (stopping) return;
          await new Promise((r) => setTimeout(r, 5_000));
        }
      })()
    : Promise.resolve();

  const lastStarted = new Map<string, number>();
  log.info({ jobs: DEFAULT_JOBS.map((j) => j.name) }, "daemon started");
  while (!stopping) {
    for (const job of dueJobs(DEFAULT_JOBS, lastStarted, new Date())) {
      if (stopping) break;
      const cmd = registry.get(job.command);
      if (!cmd) continue;
      lastStarted.set(job.name, Date.now());
      const started = Date.now();
      try {
        await cmd.run(ctx, { _: [], ...job.args } as CommandArgs);
        log.info({ job: job.name, ms: Date.now() - started }, "scheduled job completed");
      } catch (err) {
        log.error({ job: job.name, ms: Date.now() - started, error: err instanceof Error ? (err.stack ?? err.message) : String(err) }, "scheduled job failed");
      }
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  await Promise.race([researchLoop, new Promise((r) => setTimeout(r, 5_000))]);
  await closeDb().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  createLogger(process.env).error({ error: err instanceof Error ? (err.stack ?? err.message) : String(err) }, "daemon crashed");
  process.exit(1);
});
