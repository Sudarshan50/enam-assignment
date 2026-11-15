import {
  MODULE_KEYS,
  type ModuleKey,
  ModuleKeySchema,
  ModuleStatusSchema,
  PromiseLedgerPayloadSchema,
  type ResearchModule,
  type ResearchRun,
  type RunStatus,
  RunStatusSchema,
} from "@finn/shared";
import type { WorkerDispatcher } from "../adapters/workerDispatcher";
import type { CompanyResearch, CreateResearchRunResponse, PromiseLedger } from "../contracts";
import { notFound, researchLimitReached } from "../http/errors";
import type { Logger } from "../lib/logger";
import { type Clock, DAY, MINUTE, startOfIstDay, systemClock, toIsoRequired } from "../lib/time";

export interface RunRecord {
  id: string;
  symbol: string;
  status: string;
  modules: string[];
  createdAt: Date;
  updatedAt: Date;
  dispatchAttempts: number;
}

export interface ModuleRow {
  module: string;
  status: string;
  payload: unknown;
  error: string | null;
  updatedAt: Date;
}

export interface DocumentRow {
  id: string;
  docType: string;
  periodLabel: string;
  status: string;
  pages: number | null;
  url: string;
}

export interface ResearchRepository {
  findCompany(symbol: string): Promise<{ symbol: string; name: string } | null>;
  findLatestCompleted(symbol: string, since: Date): Promise<RunRecord | null>;
  findActive(symbol: string): Promise<RunRecord | null>;
  countCreatedSince(since: Date): Promise<number>;
  /** Inserts a queued run; null when another active run for the symbol won the race. */
  insertQueued(input: { symbol: string; modules: ModuleKey[]; requestedBy: string | null }): Promise<RunRecord | null>;
  appendEvent(runId: string, type: string, message: string, data?: Record<string, unknown>): Promise<void>;
  markDispatched(runId: string): Promise<void>;
  recordDispatchFailure(runId: string, error: string): Promise<void>;
  markFailed(runId: string, error: string): Promise<void>;
  getRun(id: string): Promise<(RunRecord & { companyName: string | null }) | null>;
  findLatestRun(symbol: string): Promise<RunRecord | null>;
  listModules(runId: string): Promise<ModuleRow[]>;
  listDocuments(symbol: string): Promise<DocumentRow[]>;
  listStaleQueued(createdBefore: Date, limit: number): Promise<RunRecord[]>;
}

export interface CreateRunResult {
  status: 200 | 202;
  body: CreateResearchRunResponse;
}

export interface ResearchService {
  create(input: { symbol: string; modules?: ModuleKey[] }, meta?: { requestedBy?: string }): Promise<CreateRunResult>;
  getRun(id: string): Promise<ResearchRun>;
  companyResearch(symbol: string): Promise<CompanyResearch>;
  redispatchStale(): Promise<{ redispatched: number; failed: number; givenUp: number }>;
}

export const CACHE_TTL_MS = 7 * DAY;
export const REDISPATCH_AFTER_MS = 10 * MINUTE;
export const MAX_DISPATCH_ATTEMPTS = 3;

function runStatus(value: string): RunStatus {
  const parsed = RunStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "failed";
}

export function toModules(run: Pick<RunRecord, "modules" | "updatedAt">, rows: ModuleRow[]): ResearchModule[] {
  const byKey = new Map<ModuleKey, ResearchModule>();
  for (const row of rows) {
    const key = ModuleKeySchema.safeParse(row.module);
    if (!key.success) continue;
    const status = ModuleStatusSchema.safeParse(row.status);
    byKey.set(key.data, {
      key: key.data,
      status: status.success ? status.data : "failed",
      payload: row.payload ?? null,
      error: row.error,
      updatedAt: toIsoRequired(row.updatedAt),
    });
  }
  for (const m of run.modules) {
    const key = ModuleKeySchema.safeParse(m);
    if (key.success && !byKey.has(key.data)) {
      byKey.set(key.data, { key: key.data, status: "pending", payload: null, error: null, updatedAt: toIsoRequired(run.updatedAt) });
    }
  }
  return MODULE_KEYS.flatMap((k) => byKey.get(k) ?? []);
}

/**
 * The ledger is the promise_ledger module's output: it de-duplicates restated promises and scopes to
 * the transcripts the run used, so the top-level field and the module never disagree.
 */
export function ledgerFromModules(modules: ResearchModule[]): PromiseLedger | null {
  const mod = modules.find((m) => m.key === "promise_ledger" && m.status === "done");
  const parsed = PromiseLedgerPayloadSchema.safeParse(mod?.payload);
  if (!parsed.success || parsed.data.promises.length === 0) return null;
  return { summary: parsed.data.summary, promises: parsed.data.promises };
}

export function createResearchService(deps: {
  repo: ResearchRepository;
  dispatcher: WorkerDispatcher;
  runsPerDay: number;
  now?: Clock;
  log: Logger;
}): ResearchService {
  const { repo, dispatcher, log } = deps;
  const now = deps.now ?? systemClock;

  async function dispatch(run: RunRecord): Promise<boolean> {
    try {
      await dispatcher.dispatchResearch({ symbol: run.symbol, runId: run.id });
      if (dispatcher.kind !== "noop") await repo.markDispatched(run.id);
      return true;
    } catch (err) {
      log.warn({ err, runId: run.id }, "research dispatch failed; the dispatch-research job will retry");
      await repo.recordDispatchFailure(run.id, (err as Error).message.slice(0, 500));
      return false;
    }
  }

  async function buildRun(run: RunRecord, companyName: string | null): Promise<ResearchRun> {
    const [modules, documents] = await Promise.all([repo.listModules(run.id), repo.listDocuments(run.symbol)]);
    return {
      id: run.id,
      symbol: run.symbol,
      companyName,
      status: runStatus(run.status),
      createdAt: toIsoRequired(run.createdAt),
      updatedAt: toIsoRequired(run.updatedAt),
      modules: toModules(run, modules),
      documents: documents.map((d) => ({
        id: d.id,
        label: `${d.docType.replace(/_/g, " ")} ${d.periodLabel}`.trim(),
        status: d.status,
        pages: d.pages,
        url: d.url,
      })),
    };
  }

  return {
    async create(input, meta) {
      const company = await repo.findCompany(input.symbol);
      if (!company) throw notFound(`Company ${input.symbol}`);

      const at = now();
      const cached = await repo.findLatestCompleted(company.symbol, new Date(at.getTime() - CACHE_TTL_MS));
      if (cached) return { status: 200, body: { runId: cached.id, status: runStatus(cached.status), cached: true } };

      const active = await repo.findActive(company.symbol);
      if (active) return { status: 202, body: { runId: active.id, status: runStatus(active.status), cached: false } };

      const usedToday = await repo.countCreatedSince(startOfIstDay(at));
      if (usedToday >= deps.runsPerDay) throw researchLimitReached(deps.runsPerDay);

      const modules = input.modules?.length ? [...new Set(input.modules)] : [...MODULE_KEYS];
      const inserted = await repo.insertQueued({ symbol: company.symbol, modules, requestedBy: meta?.requestedBy ?? null });
      if (!inserted) {
        const winner = await repo.findActive(company.symbol);
        if (winner) return { status: 202, body: { runId: winner.id, status: runStatus(winner.status), cached: false } };
        throw new Error("Research run insert conflicted but no active run was found");
      }

      await repo.appendEvent(inserted.id, "run.queued", `Queued research for ${company.name}`, { symbol: company.symbol, modules });
      await dispatch(inserted);
      return { status: 202, body: { runId: inserted.id, status: "queued", cached: false } };
    },

    async getRun(id) {
      const run = await repo.getRun(id);
      if (!run) throw notFound("Research run");
      return buildRun(run, run.companyName);
    },

    async companyResearch(symbol) {
      const company = await repo.findCompany(symbol);
      if (!company) throw notFound(`Company ${symbol}`);
      const latest = await repo.findLatestRun(company.symbol);
      const run = latest ? await buildRun(latest, company.name) : null;
      return {
        symbol: company.symbol,
        companyName: company.name,
        run,
        modules: run?.modules ?? [],
        promiseLedger: ledgerFromModules(run?.modules ?? []),
      };
    },

    async redispatchStale() {
      const stale = await repo.listStaleQueued(new Date(now().getTime() - REDISPATCH_AFTER_MS), 20);
      let redispatched = 0;
      let failed = 0;
      let givenUp = 0;
      for (const run of stale) {
        if (run.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) {
          const reason = `The research worker did not start after ${MAX_DISPATCH_ATTEMPTS} dispatch attempts`;
          await repo.markFailed(run.id, reason);
          await repo.appendEvent(run.id, "run.failed", reason);
          givenUp++;
        } else if (await dispatch(run)) redispatched++;
        else failed++;
      }
      return { redispatched, failed, givenUp };
    },
  };
}
