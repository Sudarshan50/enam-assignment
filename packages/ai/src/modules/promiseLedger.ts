import { chunksRepo } from "@finn/db/repositories/chunks";
import { documentsRepo } from "@finn/db/repositories/documents";
import { guidanceRepo, type GuidanceItemRow } from "@finn/db/repositories/guidance";
import { PromiseLedgerPayloadSchema, type GuidanceMetric, type PromiseItem } from "@finn/shared/contracts/research";
import type { z } from "zod";
import { normaliseForMatch, type SourceChunk } from "../citations/validator";
import { createHistoryActuals } from "../ledger/actuals";
import { extractGuidance } from "../ledger/extract";
import { matchGuidance, summariseLedger, type LedgerItem } from "../ledger/match";
import { EXTRACTOR_VERSION } from "../prompts/guidance";
import { mapWithConcurrency } from "../util/concurrency";
import { insufficient, type ModuleDocument, type ResearchModuleRunner } from "./types";

type Payload = z.infer<typeof PromiseLedgerPayloadSchema>;

export const MAX_TRANSCRIPTS = 8;

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Chunk index first, then the quote's offset in the chunk; chunks are far shorter than this. */
const CHUNK_STRIDE = 1_000_000;

function toLedgerItem(r: GuidanceItemRow, chunkById: ReadonlyMap<string, { index: number; text: string }>): LedgerItem {
  const chunk = r.chunk_id ? chunkById.get(r.chunk_id) : undefined;
  return {
    id: r.id,
    metric: r.metric as GuidanceMetric,
    statementType: r.statement_type,
    low: r.low === null ? null : Number(r.low),
    high: r.high === null ? null : Number(r.high),
    unit: r.unit,
    horizonLabel: r.horizon_label,
    scope: r.scope,
    segment: r.segment,
    quote: r.quote,
    saidIn: r.said_in,
    saidOn: iso(r.said_on),
    documentId: r.document_id,
    withdrawn: r.withdrawn,
    position: chunk ? chunk.index * CHUNK_STRIDE + Math.max(0, normaliseForMatch(chunk.text).indexOf(normaliseForMatch(r.quote))) : undefined,
  };
}

export const promiseLedgerModule: ResearchModuleRunner = {
  key: "promise_ledger",
  version: `4+extract${EXTRACTOR_VERSION}`,
  inputs: { documents: true, history: true, asOfDay: true },
  async run(ctx) {
    const transcripts = ctx.documents
      .filter((d): d is ModuleDocument & { periodEnd: string } => d.docType === "transcript" && d.periodEnd !== null)
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
      .slice(0, MAX_TRANSCRIPTS);
    if (transcripts.length === 0) return insufficient("No earnings-call transcripts could be processed for this company.");

    const chunks = chunksRepo(ctx.sql);
    const docs = documentsRepo(ctx.sql);
    const guidance = guidanceRepo(ctx.sql);
    const chunkById = new Map<string, { index: number; text: string }>();

    await mapWithConcurrency(transcripts, 4, async (t) => {
      const [rows, pages] = await Promise.all([chunks.listForDocument(t.id), docs.pages(t.id)]);
      for (const c of rows) chunkById.set(c.id, { index: c.chunk_index, text: c.text });
      const sourceChunks: SourceChunk[] = rows.map((c) => ({
        chunkId: c.id,
        documentId: t.id,
        documentLabel: t.label,
        url: t.url,
        pageStart: c.page_start,
        pageEnd: c.page_end,
        text: c.text,
        pages: pages.filter((p) => p.page >= c.page_start && p.page <= c.page_end),
      }));
      const { items, stats } = await extractGuidance(
        { llm: ctx.llm },
        { documentId: t.id, symbol: ctx.symbol, companyName: ctx.companyName, label: t.label, callDate: t.periodEnd, chunks: sourceChunks },
      );
      await guidance.replaceForDocument(t.id, items);
      ctx.log?.("guidance extracted", { document: t.label, proposed: stats.proposed, kept: stats.kept, rejected: stats.rejected.length });
    });

    const transcriptIds = new Set(transcripts.map((t) => t.id));
    const rows = (await guidance.listBySymbol(ctx.symbol)).filter((r) => transcriptIds.has(r.document_id));
    const rowById = new Map(rows.map((r) => [r.id, r] as const));
    const entries = matchGuidance({
      items: rows.map((r) => toLedgerItem(r, chunkById)),
      transcripts: transcripts.map((t) => ({ documentId: t.id, label: t.label, callDate: t.periodEnd })),
      actuals: createHistoryActuals(ctx.history),
      asOf: ctx.asOf,
    });

    await guidance.upsertChecks(
      entries.flatMap((e) =>
        e.memberIds.map((guidanceId) => ({
          guidanceId,
          actual: e.actual,
          actualPeriod: e.actualPeriod,
          actualSource: e.actualSource,
          verdict: e.verdict,
          explanation: e.explanation,
        })),
      ),
    );

    const docById = new Map(transcripts.map((t) => [t.id, t] as const));
    const promises: PromiseItem[] = entries.map((e) => {
      const rep = e.representative;
      const row = rowById.get(rep.id);
      const doc = docById.get(rep.documentId);
      return {
        id: rep.id,
        metric: rep.metric,
        statementType: rep.statementType,
        low: rep.low,
        high: rep.high,
        unit: rep.unit,
        horizonLabel: rep.horizonLabel,
        horizonEnd: iso(row?.horizon_end ?? null),
        saidIn: rep.saidIn,
        speaker: row?.speaker ?? null,
        quote: rep.quote,
        citation: {
          chunkId: row?.chunk_id ?? "",
          documentId: rep.documentId,
          documentLabel: doc?.label ?? rep.saidIn,
          page: row?.page ?? null,
          quote: rep.quote,
          url: doc?.url ?? null,
        },
        actual: e.actual,
        actualPeriod: e.actualPeriod,
        actualSource: e.actualSource,
        verdict: e.verdict,
        explanation: e.explanation,
      };
    });

    const s = summariseLedger(entries);
    const payload: Payload = {
      summary: { elapsed: s.elapsed, delivered: s.delivered, missed: s.missed, pending: s.pending, quietlyDropped: s.quietlyDropped },
      promises,
      transcriptsUsed: transcripts.map((t) => t.label),
    };
    return { status: "done", payload: PromiseLedgerPayloadSchema.parse(payload) };
  },
};
