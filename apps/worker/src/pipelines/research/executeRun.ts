import { tablesFromRows } from "@finn/ai/financials/history";
import { createDefaultModuleRegistry, type ModuleRegistry } from "@finn/ai/modules/registry";
import type { ModuleDocument } from "@finn/ai/modules/types";
import { mapWithConcurrency } from "@finn/ai/util/concurrency";
import { documentLabel, documentsRepo } from "@finn/db/repositories/documents";
import { historyRepo } from "@finn/db/repositories/history";
import { researchRepo, type ResearchRepo, type ResearchRunRow } from "@finn/db/repositories/research";
import { MODULE_KEYS, ModuleKeySchema, type ModuleKey } from "@finn/shared/contracts/research";
import type { WorkerContext } from "../../context";
import { createDocumentDownloader, discoverDocuments, processDocument } from "../documents";
import { runModules, type ModuleOutcome } from "./runModules";

const HEARTBEAT_MS = 30_000;
const DOC_CONCURRENCY = 2;

export interface RunOptions {
  workerId: string;
  registry?: ModuleRegistry;
  /** Skip module_cache lookups (payloads are still written back). */
  noModuleCache?: boolean;
  asOf?: Date;
}

export interface RunSummary {
  runId: string;
  symbol: string;
  /** "superseded": another worker re-claimed the run after our lease expired, so we stopped writing to it. */
  status: "completed" | "partial" | "failed" | "superseded";
  documents: { label: string; status: string; pages: number; chunks: number; error?: string }[];
  modules: ModuleOutcome[];
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Research run ${runId} was re-claimed by another worker`);
    this.name = "LeaseLostError";
  }
}

/**
 * Executes a claimed run end to end: documents, then modules; always leaves the run in a terminal state, unless
 * another worker re-claims it (our heartbeat lapsed), in which case every run write stops landing and we bail out.
 */
export async function executeResearchRun(ctx: WorkerContext, run: ResearchRunRow, opts: RunOptions): Promise<RunSummary> {
  const repo = researchRepo(ctx.sql);
  const docsRepo = documentsRepo(ctx.sql);
  const symbol = run.symbol;
  const registry = opts.registry ?? createDefaultModuleRegistry();
  const keys: ModuleKey[] = (run.modules.length ? run.modules : [...MODULE_KEYS]).filter((k): k is ModuleKey => ModuleKeySchema.safeParse(k).success);
  const summary: RunSummary = { runId: run.id, symbol, status: "failed", documents: [], modules: [] };

  let leaseLost = false;
  const owned = (landed: boolean) => {
    if (!landed) leaseLost = true;
  };
  const assertLease = () => {
    if (leaseLost) throw new LeaseLostError(run.id);
  };
  // Never throws: document callbacks run inside processDocument, which would record a throw as a document failure.
  const event = async (type: string, message: string, data: Record<string, unknown>) => {
    if (!leaseLost) owned(await repo.addEventAsOwner(run.id, opts.workerId, type, message, data));
  };
  const setStatus = async (status: Parameters<ResearchRepo["setStatus"]>[1], patch?: Parameters<ResearchRepo["setStatus"]>[2], closing?: Parameters<ResearchRepo["setStatusAsOwner"]>[4]) => {
    owned(await repo.setStatusAsOwner(run.id, opts.workerId, status, patch, closing));
    assertLease();
  };
  // runModules writes through this; throwing once the lease is gone keeps further modules from starting.
  const moduleRepo: ResearchRepo = {
    ...repo,
    async upsertModule(runId, module, status, patch) {
      assertLease();
      owned(await repo.upsertModuleAsOwner(runId, opts.workerId, module, status, patch));
      assertLease();
    },
    async addEvent(runId, type, message, data) {
      assertLease();
      owned(await repo.addEventAsOwner(runId, opts.workerId, type, message, data));
    },
  };

  const heartbeat = setInterval(() => {
    repo
      .heartbeat(run.id, opts.workerId)
      .then(owned)
      .catch((err) => ctx.log.warn({ runId: run.id, error: String(err) }, "heartbeat failed"));
  }, HEARTBEAT_MS);
  const tick = async () => owned(await repo.heartbeat(run.id, opts.workerId));

  try {
    const companyName = await docsRepo.companyName(symbol);
    if (!companyName) throw new Error(`Unknown symbol ${symbol}: not in the companies master list`);
    await event("run.started", `Researching ${companyName}`, { symbol, workerId: opts.workerId });

    const discovery = await discoverDocuments(ctx, symbol);
    for (const d of discovery.documents) {
      await event("document.discovered", `Found ${documentLabel(d)}`, { documentId: d.id, label: documentLabel(d), url: d.url, docType: d.doc_type });
    }
    if (discovery.error) {
      await event("document.failed", "Could not reach the document index; using documents already processed", { error: discovery.error.slice(0, 300) });
    }
    ctx.log.info({ runId: run.id, symbol, documents: discovery.documents.length, historyTables: discovery.historyTables }, "documents discovered");

    const http = createDocumentDownloader(discovery.documents.map((d) => d.url));
    const results = await mapWithConcurrency(discovery.documents, DOC_CONCURRENCY, async (doc) => {
      assertLease();
      const label = documentLabel(doc);
      const r = await processDocument(ctx, http, doc, companyName, {
        onDownloaded: (_d, info) => event("document.downloaded", `Downloaded ${label}`, { documentId: doc.id, label, bytes: info.bytes }),
        onExtracted: (_d, info) => event("document.extracted", `Reading ${label}, ${info.pages} pages`, { documentId: doc.id, label, pages: info.pages, chunks: info.chunks }),
        onEmbedded: (_d, info) => event("document.embedded", `Indexed ${label}`, { documentId: doc.id, label, chunks: info.chunks }),
        tick,
      });
      const scanned = r.status === "scanned" || (r.status === "skipped" && doc.status === "scanned");
      if (r.status === "failed" || scanned) {
        const msg = scanned ? `${label} is a scanned PDF; skipped (no OCR)` : `Could not process ${label}`;
        await event("document.failed", msg, { documentId: doc.id, label, status: scanned ? "scanned" : r.status, error: r.error?.slice(0, 300) ?? null });
      } else if (r.status === "skipped") {
        await event("document.embedded", `${label} already indexed`, { documentId: doc.id, label, chunks: r.chunks, cached: true });
      }
      ctx.log.info({ runId: run.id, document: label, status: r.status, pages: r.pages, chunks: r.chunks, error: r.error }, "document processed");
      return { label, status: r.status, pages: r.pages, chunks: r.chunks, error: r.error };
    });
    summary.documents = results;

    await setStatus("synthesizing");
    const ready = await docsRepo.listReady(symbol, ["annual_report", "transcript"]);
    const documents: ModuleDocument[] = ready.map((d) => ({
      id: d.id,
      docType: d.doc_type,
      label: documentLabel(d),
      periodLabel: d.period_label,
      periodEnd: iso(d.period_end),
      url: d.url,
      sha256: d.sha256,
      pages: d.pages,
    }));
    const history = tablesFromRows(await historyRepo(ctx.sql).listForSymbol(symbol));
    summary.modules = await runModules({
      runId: run.id,
      keys,
      registry,
      repo: moduleRepo,
      model: ctx.env.LLM_MODEL ?? "unknown",
      useCache: !opts.noModuleCache,
      ctx: {
        symbol,
        companyName,
        runId: run.id,
        sql: ctx.sql,
        llm: ctx.llm,
        embeddings: ctx.embeddings,
        documents,
        history,
        asOf: opts.asOf ?? new Date(),
        log: (message, data) => ctx.log.info({ runId: run.id, ...data }, message),
      },
    });

    const failed = summary.modules.filter((m) => m.status === "failed").length;
    const status = failed === 0 ? "completed" : failed === summary.modules.length ? "failed" : "partial";
    const inputHash = documents.map((d) => d.sha256 ?? d.id).sort().join(",");
    await setStatus(
      status,
      { inputHash, error: failed ? `${failed} module(s) failed` : null },
      status === "failed"
        ? { type: "run.failed", message: "Research failed: every module failed", data: { modules: summary.modules } }
        : { type: "run.completed", message: status === "partial" ? "Research ready (some modules failed)" : "Research ready", data: { status, modules: summary.modules } },
    );
    summary.status = status;
    return summary;
  } catch (err) {
    if (err instanceof LeaseLostError || leaseLost) {
      ctx.log.warn({ runId: run.id, symbol, workerId: opts.workerId }, "research run was re-claimed by another worker; stopped without writing to it");
      summary.status = "superseded";
      return summary;
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ runId: run.id, symbol, error: message }, "research run failed");
    const landed = await repo.setStatusAsOwner(run.id, opts.workerId, "failed", { error: message.slice(0, 500) }, {
      type: "run.failed",
      message: "Research failed",
      data: { error: message.slice(0, 300) },
    });
    summary.status = landed ? "failed" : "superseded";
    return summary;
  } finally {
    clearInterval(heartbeat);
  }
}
