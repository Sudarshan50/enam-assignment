import type { ModuleKey } from "@finn/shared/contracts/research";
import { istDateString } from "@finn/shared/format";
import { hashParts } from "../util/hash";
import { bullBearModule } from "./bullBear";
import { businessSnapshotModule } from "./businessSnapshot";
import { cashQualityModule } from "./cashQuality";
import { financialSnapshotModule } from "./financialSnapshot";
import { promiseLedgerModule } from "./promiseLedger";
import type { ModuleContext, ResearchModuleRunner } from "./types";

export class ModuleRegistry {
  private readonly runners = new Map<ModuleKey, ResearchModuleRunner>();

  register(runner: ResearchModuleRunner): this {
    this.runners.set(runner.key, runner);
    return this;
  }

  get(key: ModuleKey): ResearchModuleRunner | undefined {
    return this.runners.get(key);
  }

  list(keys?: readonly ModuleKey[]): ResearchModuleRunner[] {
    return keys ? keys.map((k) => this.runners.get(k)).filter((r): r is ResearchModuleRunner => !!r) : [...this.runners.values()];
  }
}

/** Modules in display priority order: the Promise Ledger is the signature module. */
export function createDefaultModuleRegistry(): ModuleRegistry {
  return new ModuleRegistry()
    .register(promiseLedgerModule)
    .register(financialSnapshotModule)
    .register(cashQualityModule)
    .register(bullBearModule)
    .register(businessSnapshotModule);
}

/**
 * Module cache key: module version + model + the exact inputs it reads (document set by content hash, history
 * tables, and the IST day for date-dependent verdicts). Unchanged inputs mean the payload can be reused.
 */
export function moduleCacheKey(runner: ResearchModuleRunner, ctx: Pick<ModuleContext, "symbol" | "documents" | "history" | "asOf">, model: string): string {
  const docs = runner.inputs.documents
    ? ctx.documents
        .map((d) => `${d.id}:${d.sha256 ?? ""}`)
        .sort()
        .join(",")
    : "";
  const history = runner.inputs.history ? hashParts(ctx.history) : "";
  const day = runner.inputs.asOfDay ? istDateString(ctx.asOf) : "";
  return hashParts("module", runner.key, runner.version, model, ctx.symbol, docs, history, day);
}
