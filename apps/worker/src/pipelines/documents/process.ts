import { chunkPages } from "@finn/ai/chunking/chunker";
import { chunksRepo } from "@finn/db/repositories/chunks";
import { documentLabel, documentsRepo, type DocumentRow } from "@finn/db/repositories/documents";
import type { HttpClient } from "@finn/sources/http/client";
import { extractPdfPages, looksScanned } from "@finn/sources/pdf/extract";
import type { WorkerContext } from "../../context";
import { downloadPdf } from "./download";

export const PARSER_VERSION = 1;
const MAX_PAGES: Record<string, number> = { annual_report: 350, transcript: 80 };
const EMBED_GROUP = 64;
/** NSE files audio-recording intimations under the same "Earning_Call" name as transcripts; real calls run 30k+ chars. */
const MIN_TRANSCRIPT_CHARS = 5000;

export interface DocumentProgress {
  onDownloaded?(doc: DocumentRow, info: { bytes: number }): Promise<void>;
  onExtracted?(doc: DocumentRow, info: { pages: number; chunks: number }): Promise<void>;
  onEmbedded?(doc: DocumentRow, info: { chunks: number; embedded: number }): Promise<void>;
  /** Called between slow steps so long documents keep the run's heartbeat fresh. */
  tick?(): Promise<void>;
}

export interface ProcessResult {
  status: "ready" | "scanned" | "failed" | "skipped";
  pages: number;
  chunks: number;
  error?: string;
}

/**
 * Takes one document from discovered to ready: download (allowlisted), extract, chunk, embed. Each step writes
 * its state, and chunk rows are keyed by (document_id, chunk_index), so a crashed run resumes safely.
 */
export async function processDocument(
  ctx: WorkerContext,
  http: HttpClient,
  doc: DocumentRow,
  companyName: string,
  progress: DocumentProgress = {},
): Promise<ProcessResult> {
  const docs = documentsRepo(ctx.sql);
  const chunks = chunksRepo(ctx.sql);
  const label = documentLabel(doc);

  if (doc.status === "scanned") return { status: "skipped", pages: doc.pages ?? 0, chunks: 0 };
  if (doc.status === "ready") {
    const count = await chunks.countForDocument(doc.id);
    if (count.total > 0 && count.embedded === count.total) return { status: "skipped", pages: doc.pages ?? 0, chunks: count.total };
  }

  try {
    let pageCount = doc.pages ?? 0;
    let chunkCount = 0;
    const needsText = !["chunked", "embedded", "ready"].includes(doc.status) || (await chunks.countForDocument(doc.id)).total === 0;

    if (needsText) {
      const { bytes, sha256 } = await downloadPdf(http, doc.url);
      await docs.setStatus(doc.id, "downloaded", { sha256 });
      await progress.onDownloaded?.(doc, { bytes: bytes.byteLength });
      await progress.tick?.();

      const pages = await extractPdfPages(bytes, { maxPages: MAX_PAGES[doc.doc_type] ?? 200 });
      pageCount = pages.length;
      if (looksScanned(pages)) {
        await docs.setStatus(doc.id, "scanned", { pages: pages.length, textQuality: 0, error: "Scanned PDF: too little extractable text (OCR not supported)" });
        return { status: "scanned", pages: pages.length, chunks: 0 };
      }
      const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
      if (doc.doc_type === "transcript" && totalChars < MIN_TRANSCRIPT_CHARS) {
        throw new Error(`Not a transcript: only ${totalChars} characters (likely an audio-recording intimation letter)`);
      }
      const avgChars = pages.reduce((n, p) => n + p.text.length, 0) / Math.max(1, pages.length);
      await docs.savePages(doc.id, pages);
      await docs.setStatus(doc.id, "extracted", { pages: pages.length, textQuality: Math.min(1, avgChars / 2500) });

      const textChunks = chunkPages(pages);
      await chunks.replaceForDocument(doc.id, doc.symbol, textChunks);
      chunkCount = textChunks.length;
      await docs.setStatus(doc.id, "chunked");
      await progress.onExtracted?.(doc, { pages: pages.length, chunks: chunkCount });
      await progress.tick?.();
    }

    const pending = await chunks.pendingEmbeddings(doc.id, ctx.embeddings.model);
    for (let i = 0; i < pending.length; i += EMBED_GROUP) {
      const group = pending.slice(i, i + EMBED_GROUP);
      const vectors = await ctx.embeddings.embedDocuments(
        group.map((c) => ({ text: c.text, title: `${companyName} ${label}${c.section ? ` - ${c.section}` : ""}` })),
      );
      await chunks.setEmbeddings(group.map((c, j) => ({ id: c.id, vector: vectors[j]! })), ctx.embeddings.model, ctx.embeddings.dims);
      await progress.tick?.();
    }
    const counts = await chunks.countForDocument(doc.id);
    chunkCount = counts.total;
    await docs.setStatus(doc.id, "embedded");
    await progress.onEmbedded?.(doc, { chunks: counts.total, embedded: counts.embedded });
    await docs.setStatus(doc.id, "ready", { pages: pageCount || undefined });
    return { status: "ready", pages: pageCount, chunks: chunkCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await docs.setStatus(doc.id, "failed", { error: message.slice(0, 500) });
    return { status: "failed", pages: 0, chunks: 0, error: message };
  }
}
