import type { Sql } from "@finn/db";
import { chunksRepo, type ChunkWithDocument } from "@finn/db/repositories/chunks";
import { documentLabel, documentsRepo, type DocType } from "@finn/db/repositories/documents";
import type { EmbeddingPort, EmbeddingTask } from "@finn/shared/ports";
import { rrfFuse } from "./rrf";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentLabel: string;
  docType: DocType;
  periodLabel: string;
  periodEnd: string | null;
  url: string;
  pageStart: number;
  pageEnd: number;
  section: string | null;
  text: string;
  /** Fused RRF score. */
  score: number;
  ftsRank: number | null;
  vectorDistance: number | null;
  /** Full text of the pages the chunk spans, used to pin a quote to its exact page. */
  pages: { page: number; text: string }[];
}

export interface RetrieveDeps {
  sql: Sql;
  embeddings: EmbeddingPort;
}

export interface RetrieveRequest {
  symbol: string;
  query: string;
  k?: number;
  docKinds?: DocType[];
  task?: Exclude<EmbeddingTask, "document">;
  /** Candidates taken from each of FTS and vector search before fusion. */
  candidates?: number;
}

/** Cosine distance beyond which a vector-only hit is treated as unrelated (calibrated on EmbeddingGemma 2). */
export const WEAK_VECTOR_DISTANCE = 0.55;

const RRF_K = 60;

function toIso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

async function hydrate(sql: Sql, ids: string[], meta: Map<string, { score: number; fts: number | null; vec: number | null }>): Promise<RetrievedChunk[]> {
  const rows = await chunksRepo(sql).getByIds(ids);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is ChunkWithDocument => !!r);
  const pageRows = await documentsRepo(sql).pagesFor(
    ordered.map((r) => ({ documentId: r.document_id, pages: Array.from({ length: r.page_end - r.page_start + 1 }, (_, i) => r.page_start + i) })),
  );
  const pagesByDoc = new Map<string, { page: number; text: string }[]>();
  for (const p of pageRows) {
    const list = pagesByDoc.get(p.document_id) ?? [];
    list.push({ page: p.page, text: p.text });
    pagesByDoc.set(p.document_id, list);
  }
  return ordered.map((r) => {
    const m = meta.get(r.id);
    return {
      chunkId: r.id,
      documentId: r.document_id,
      documentLabel: documentLabel(r),
      docType: r.doc_type,
      periodLabel: r.period_label,
      periodEnd: toIso(r.period_end),
      url: r.url,
      pageStart: r.page_start,
      pageEnd: r.page_end,
      section: r.section,
      text: r.text,
      score: m?.score ?? 0,
      ftsRank: m?.fts ?? null,
      vectorDistance: m?.vec ?? null,
      pages: (pagesByDoc.get(r.document_id) ?? []).filter((p) => p.page >= r.page_start && p.page <= r.page_end).sort((a, b) => a.page - b.page),
    };
  });
}

/** Hybrid retrieval: FTS + exact vector search, fused with RRF, always filtered to one symbol. */
export async function retrieve(deps: RetrieveDeps, req: RetrieveRequest): Promise<RetrievedChunk[]> {
  const repo = chunksRepo(deps.sql);
  const candidates = req.candidates ?? 40;
  const [fts, vector] = await Promise.all([
    repo.ftsSearch(req.symbol, req.query, candidates, req.docKinds),
    deps.embeddings.embedQuery(req.query, req.task ?? "search_query").then((v) => repo.vectorSearch(req.symbol, v, candidates, req.docKinds)),
  ]);
  const fused = rrfFuse([fts.map((r) => r.id), vector.map((r) => r.id)], RRF_K).slice(0, req.k ?? 8);
  const ftsScore = new Map(fts.map((r) => [r.id, r.score] as const));
  const vecScore = new Map(vector.map((r) => [r.id, r.score] as const));
  const meta = new Map(fused.map((f) => [f.id, { score: f.score, fts: ftsScore.get(f.id) ?? null, vec: vecScore.get(f.id) ?? null }] as const));
  return hydrate(deps.sql, fused.map((f) => f.id), meta);
}

/**
 * Runs several queries and fuses their rankings again with RRF, so a module can gather evidence on several
 * themes (growth, risks, margins...) without one theme crowding out the rest.
 */
export async function retrieveMulti(
  deps: RetrieveDeps,
  req: Omit<RetrieveRequest, "query" | "k"> & { queries: string[]; perQuery?: number; k: number },
): Promise<RetrievedChunk[]> {
  const perQuery = req.perQuery ?? 8;
  const lists = await Promise.all(req.queries.map((query) => retrieve(deps, { ...req, query, k: perQuery })));
  const fused = rrfFuse(lists.map((l) => l.map((c) => c.chunkId)), RRF_K).slice(0, req.k);
  const byId = new Map<string, RetrievedChunk>();
  for (const list of lists) for (const c of list) if (!byId.has(c.chunkId)) byId.set(c.chunkId, c);
  return fused.map((f) => ({ ...byId.get(f.id)!, score: f.score }));
}

/** Nothing relevant: no chunks, or no lexical hit and even the closest vector is far away. */
export function isWeakRetrieval(chunks: RetrievedChunk[]): boolean {
  if (chunks.length === 0) return true;
  const anyLexical = chunks.some((c) => c.ftsRank !== null && c.ftsRank > 0);
  const bestDistance = Math.min(...chunks.map((c) => c.vectorDistance ?? Number.POSITIVE_INFINITY));
  return !anyLexical && bestDistance > WEAK_VECTOR_DISTANCE;
}
