import type { Sql } from "../client";
import type { DocType } from "./documents";

export interface ChunkInput {
  index: number;
  pageStart: number;
  pageEnd: number;
  section: string | null;
  text: string;
  tokenEstimate: number;
}

export interface ChunkWithDocument {
  id: string;
  document_id: string;
  chunk_index: number;
  symbol: string;
  page_start: number;
  page_end: number;
  section: string | null;
  text: string;
  doc_type: DocType;
  period_label: string;
  period_end: Date | null;
  url: string;
}

export interface RankedChunkId {
  id: string;
  score: number;
}

/** Serialises a vector as a pgvector literal; numbers are fixed-precision to keep payloads small. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : 0)).join(",")}]`;
}

export function chunksRepo(sql: Sql) {
  return {
    /** Idempotent: rewrites chunk rows by (document_id, chunk_index), clearing embeddings whose text changed. */
    async replaceForDocument(documentId: string, symbol: string, chunks: ChunkInput[]): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM doc_chunks WHERE document_id = ${documentId} AND chunk_index >= ${chunks.length}`;
        for (let i = 0; i < chunks.length; i += 100) {
          const rows = chunks.slice(i, i + 100).map((c) => ({
            document_id: documentId,
            chunk_index: c.index,
            symbol,
            page_start: c.pageStart,
            page_end: c.pageEnd,
            section: c.section,
            text: c.text,
            token_estimate: c.tokenEstimate,
          }));
          await tx`
            INSERT INTO doc_chunks ${tx(rows, "document_id", "chunk_index", "symbol", "page_start", "page_end", "section", "text", "token_estimate")}
            ON CONFLICT (document_id, chunk_index) DO UPDATE SET
              symbol = EXCLUDED.symbol,
              page_start = EXCLUDED.page_start,
              page_end = EXCLUDED.page_end,
              section = EXCLUDED.section,
              token_estimate = EXCLUDED.token_estimate,
              embedding = CASE WHEN doc_chunks.text = EXCLUDED.text THEN doc_chunks.embedding ELSE NULL END,
              text = EXCLUDED.text`;
        }
      });
    },

    async pendingEmbeddings(documentId: string, model: string): Promise<{ id: string; text: string; section: string | null }[]> {
      return sql<{ id: string; text: string; section: string | null }[]>`
        SELECT id, text, section FROM doc_chunks
        WHERE document_id = ${documentId} AND (embedding IS NULL OR embedding_model IS DISTINCT FROM ${model})
        ORDER BY chunk_index`;
    },

    async setEmbeddings(rows: { id: string; vector: number[] }[], model: string, dims: number): Promise<void> {
      if (rows.length === 0) return;
      const ids = rows.map((r) => r.id);
      const vecs = rows.map((r) => toVectorLiteral(r.vector));
      await sql`
        UPDATE doc_chunks c
        SET embedding = v.e::halfvec, embedding_model = ${model}, embedding_dims = ${dims}
        FROM unnest(${ids}::uuid[], ${vecs}::text[]) AS v(id, e)
        WHERE c.id = v.id`;
    },

    async countForDocument(documentId: string): Promise<{ total: number; embedded: number }> {
      const [row] = await sql<{ total: number; embedded: number }[]>`
        SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM doc_chunks WHERE document_id = ${documentId}`;
      return row ?? { total: 0, embedded: 0 };
    },

    /**
     * Lexical search. Terms are OR-ed so natural questions still match; chunks are ranked first by how many
     * distinct query terms they contain, then by ts_rank_cd squashed into (0,1). Ranking by ts_rank_cd alone
     * lets repetitive tables (one term repeated 50 times) outrank the passage that answers the question.
     */
    async ftsSearch(symbol: string, query: string, limit: number, docTypes?: DocType[]): Promise<RankedChunkId[]> {
      const types = docTypes?.length ? docTypes : null;
      return sql<RankedChunkId[]>`
        WITH q AS (
          SELECT replace(websearch_to_tsquery('english', ${query})::text, ' & ', ' | ')::tsquery AS tsq,
                 tsvector_to_array(to_tsvector('english', ${query})) AS lexemes
        )
        SELECT c.id,
               (cardinality(ARRAY(SELECT unnest(tsvector_to_array(c.tsv)) INTERSECT SELECT unnest(q.lexemes)))
                + ts_rank_cd(c.tsv, q.tsq, 32))::float8 AS score
        FROM doc_chunks c
        JOIN documents d ON d.id = c.document_id
        CROSS JOIN q
        WHERE c.symbol = ${symbol}
          AND d.status = 'ready'
          AND (${types}::text[] IS NULL OR d.doc_type = ANY(${types}::text[]))
          AND c.tsv @@ q.tsq
        ORDER BY score DESC
        LIMIT ${limit}`;
    },

    /** Exact cosine-distance scan (no ANN index at this corpus size). Score is the distance (lower is closer). */
    async vectorSearch(symbol: string, vector: number[], limit: number, docTypes?: DocType[]): Promise<RankedChunkId[]> {
      const types = docTypes?.length ? docTypes : null;
      const literal = toVectorLiteral(vector);
      return sql<RankedChunkId[]>`
        SELECT c.id, (c.embedding <=> ${literal}::halfvec)::float8 AS score
        FROM doc_chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.symbol = ${symbol}
          AND d.status = 'ready'
          AND c.embedding IS NOT NULL
          AND (${types}::text[] IS NULL OR d.doc_type = ANY(${types}::text[]))
        ORDER BY c.embedding <=> ${literal}::halfvec
        LIMIT ${limit}`;
    },

    async getByIds(ids: string[]): Promise<ChunkWithDocument[]> {
      if (ids.length === 0) return [];
      return sql<ChunkWithDocument[]>`
        SELECT c.id, c.document_id, c.chunk_index, c.symbol, c.page_start, c.page_end, c.section, c.text,
               d.doc_type, d.period_label, d.period_end, d.url
        FROM doc_chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id = ANY(${ids}::uuid[])`;
    },

    async listForDocument(documentId: string): Promise<ChunkWithDocument[]> {
      return sql<ChunkWithDocument[]>`
        SELECT c.id, c.document_id, c.chunk_index, c.symbol, c.page_start, c.page_end, c.section, c.text,
               d.doc_type, d.period_label, d.period_end, d.url
        FROM doc_chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.document_id = ${documentId}
        ORDER BY c.chunk_index`;
    },
  };
}

export type ChunksRepo = ReturnType<typeof chunksRepo>;
