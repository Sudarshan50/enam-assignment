import type { Command } from "./context";
import { alertsCommand } from "./pipelines/alerts";
import { backfillPricesCommand, eodCommand } from "./pipelines/eod";
import { ingestCommand } from "./pipelines/ingest";
import { masterListCommand } from "./pipelines/masterList";
import { resultsBackfillCommand, resultsCommand } from "./pipelines/results";

export const coreCommands: readonly Command[] = [
  ingestCommand,
  resultsCommand,
  resultsBackfillCommand,
  eodCommand,
  backfillPricesCommand,
  alertsCommand,
  masterListCommand,
];

/**
 * Research commands are loaded on demand so a broken or missing research module can't take down
 * the scheduled ingest/EOD jobs. The load error is reported when a research command is requested.
 */
export async function loadResearchCommands(): Promise<{ commands: readonly Command[]; error: Error | null }> {
  try {
    const mod = await import("./pipelines/research");
    return { commands: mod.researchCommands, error: null };
  } catch (err) {
    return { commands: [], error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export function buildRegistry(extra: readonly Command[] = []): Map<string, Command> {
  const registry = new Map<string, Command>();
  for (const cmd of [...coreCommands, ...extra]) {
    if (registry.has(cmd.name)) throw new Error(`Duplicate worker command: ${cmd.name}`);
    registry.set(cmd.name, cmd);
  }
  return registry;
}

export function usage(registry: Map<string, Command>): string {
  const width = Math.max(...[...registry.keys()].map((k) => k.length));
  const lines = [...registry.values()].map((c) => `  ${c.name.padEnd(width)}  ${c.description}`);
  return `Usage: npm run worker -- <command> [--key value] [--flag]\n\nCommands:\n${lines.join("\n")}`;
}
