import { tablesFromRows } from "@finn/ai/financials/history";
import { createDefaultModuleRegistry, type ModuleRegistry } from "@finn/ai/modules/registry";
import type { ModuleDocument } from "@finn/ai/modules/types";
import { mapWithConcurrency } from "@finn/ai/util/concurrency";
import { documentLabel, documentsRepo } from "@finn/db/repositories/documents";
import { historyRepo } from "@finn/db/repositories/history";
import { researchRepo, type ResearchRunRow } from "@finn/db/repositories/research";
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
  status: "completed" | "partial" | "failed";
  documents: { label: string; status: string; pages: number; chunks: number; error?: string }[];
  modules: ModuleOutcome[];
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Executes a claimed run end to end: documents, then modules; always leaves the run in a terminal state. */
export async function executeResearchRun(ctx: WorkerContext, run: ResearchRunRow, opts: RunOptions): Promise<RunSummary> {
  const repo = researchRepo(ctx.sql);
  const docsRepo = documentsRepo(ctx.sql);
  const symbol = run.symbol;
  const registry = opts.registry ?? createDefaultModuleRegistry();
  const keys: ModuleKey[] = (run.modules.length ? run.modules : [...MODULE_KEYS]).filter((k): k is ModuleKey => ModuleKeySchema.safeParse(k).success);
  const summary: RunSummary = { runId: run.id, symbol, status: "failed", documents: [], modules: [] };

  const heartbeat = setInterval(() => {
    repo.heartbeat(run.id, opts.workerId).catch((err) => ctx.log.warn({ runId: run.id, error: String(err) }, "heartbeat failed"));
  }, HEARTBEAT_MS);
  const tick = () => repo.heartbeat(run.id, opts.workerId);

  try {
    const companyName = await docsRepo.companyName(symbol);
    if (!companyName) throw new Error(`Unknown symbol ${symbol}: not in the companies master list`);
    await repo.addEvent(run.id, "run.started", `Researching ${companyName}`, { symbol, workerId: opts.workerId });

    // 1. Documents
    const discovery = await discoverDocuments(ctx, symbol);
    for (const d of discovery.documents) {
      await repo.addEvent(run.id, "document.discovered", `Found ${documentLabel(d)}`, { documentId: d.id, label: documentLabel(d), url: d.url, docType: d.doc_type });
    }
    if (discovery.error) {
      await repo.addEvent(run.id, "document.failed", "Could not reach the document index; using documents already processed", { error: discovery.error.slice(0, 300) });
    }
    ctx.log.info({ runId: run.id, symbol, documents: discovery.documents.length, historyTables: discovery.historyTables }, "documents discovered");

    const http = createDocumentDownloader(discovery.documents.map((d) => d.url));
    const results = await mapWithConcurrency(discovery.documents, DOC_CONCURRENCY, async (doc) => {
      const label = documentLabel(doc);
      const r = await processDocument(ctx, http, doc, companyName, {
        onDownloaded: (_d, info) => repo.addEvent(run.id, "document.downloaded", `Downloaded ${label}`, { documentId: doc.id, label, bytes: info.bytes }),
        onExtracted: (_d, info) =>
          repo.addEvent(run.id, "document.extracted", `Reading ${label}, ${info.pages} pages`, { documentId: doc.id, label, pages: info.pages, chunks: info.chunks }),
        onEmbedded: (_d, info) => repo.addEvent(run.id, "document.embedded", `Indexed ${label}`, { documentId: doc.id, label, chunks: info.chunks }),
        tick,
      });
      if (r.status === "failed" || r.status === "scanned") {
        const msg = r.status === "scanned" ? `${label} is a scanned PDF; skipped (no OCR)` : `Could not process ${label}`;
        await repo.addEvent(run.id, "document.failed", msg, { documentId: doc.id, label, status: r.status, error: r.error?.slice(0, 300) ?? null });
      } else if (r.status === "skipped") {
        await repo.addEvent(run.id, "document.embedded", `${label} already indexed`, { documentId: doc.id, label, chunks: r.chunks, cached: true });
      }
      ctx.log.info({ runId: run.id, document: label, status: r.status, pages: r.pages, chunks: r.chunks, error: r.error }, "document processed");
      return { label, status: r.status, pages: r.pages, chunks: r.chunks, error: r.error };
    });
    summary.documents = results;

    // 2. Modules
    await repo.setStatus(run.id, "synthesizing");
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
      repo,
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
    summary.status = failed === 0 ? "completed" : failed === summary.modules.length ? "failed" : "partial";
    const inputHash = documents.map((d) => d.sha256 ?? d.id).sort().join(",");
    await repo.setStatus(run.id, summary.status, { inputHash, error: failed ? `${failed} module(s) failed` : null });
    if (summary.status === "failed") await repo.addEvent(run.id, "run.failed", "Research failed: every module failed", { modules: summary.modules });
    else await repo.addEvent(run.id, "run.completed", summary.status === "partial" ? "Research ready (some modules failed)" : "Research ready", { status: summary.status, modules: summary.modules });
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ runId: run.id, symbol, error: message }, "research run failed");
    await repo.setStatus(run.id, "failed", { error: message.slice(0, 500) });
    await repo.addEvent(run.id, "run.failed", "Research failed", { error: message.slice(0, 300) });
    summary.status = "failed";
    return summary;
  } finally {
    clearInterval(heartbeat);
  }
}
