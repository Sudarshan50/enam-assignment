import postgres from "postgres";
import type { Sql } from "@finn/db";
import { toVectorLiteral } from "@finn/db/repositories/chunks";
import type { DocType } from "@finn/db/repositories/documents";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://finn:finn@localhost:54329/finn";

export async function connect(max = 3): Promise<{ sql: Sql; reachable: boolean }> {
  const sql = postgres(DATABASE_URL, { max, prepare: false, onnotice: () => {}, connect_timeout: 3, types: { bigint: postgres.BigInt } });
  const reachable = await sql`SELECT 1`.then(
    () => true,
    () => false,
  );
  return { sql, reachable };
}

export interface FixtureChunk {
  text: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string | null;
  embedding?: number[] | null;
}

export interface FixtureDocument {
  docType: DocType;
  periodLabel: string;
  periodEnd: string | null;
  url?: string;
  status?: string;
  sha256?: string | null;
  pages?: { page: number; text: string }[];
  chunks: FixtureChunk[];
}

export interface InsertedDocument {
  id: string;
  chunkIds: string[];
}

/** Only synthetic ZTA* symbols may be touched by these tests. */
export function assertTestSymbol(symbol: string): void {
  if (!/^ZTA[A-Z0-9]*$/.test(symbol)) throw new Error(`refusing to touch non-test symbol ${symbol}`);
}

/** Per-process suffix so concurrent runs of this suite (e.g. a full-repo run elsewhere) never clean up each other's rows. */
export const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

export function testSymbol(base: string): string {
  const s = `${base}${TAG}`;
  assertTestSymbol(s);
  return s;
}

export async function insertCompany(sql: Sql, symbol: string, name = `${symbol} Test Industries Ltd`): Promise<void> {
  assertTestSymbol(symbol);
  await sql`INSERT INTO companies (symbol, name, statement_family, sector) VALUES (${symbol}, ${name}, 'industrial', 'Test') ON CONFLICT (symbol) DO NOTHING`;
}

let urlSeq = 0;

export async function insertDocument(sql: Sql, symbol: string, doc: FixtureDocument): Promise<InsertedDocument> {
  assertTestSymbol(symbol);
  const url = doc.url ?? `https://www.bseindia.com/zta-test/${symbol}/${doc.docType}-${doc.periodLabel.replace(/\s+/g, "_")}-${++urlSeq}.pdf`;
  const pageCount = doc.pages?.length ?? Math.max(1, ...doc.chunks.map((c) => c.pageEnd ?? 1));
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO documents (symbol, doc_type, period_label, period_end, url, status, sha256, pages)
    VALUES (${symbol}, ${doc.docType}, ${doc.periodLabel}, ${doc.periodEnd}, ${url}, ${doc.status ?? "ready"}, ${doc.sha256 ?? `sha-${url}`}, ${pageCount})
    RETURNING id`;
  const id = row!.id;
  for (const p of doc.pages ?? []) await sql`INSERT INTO document_pages (document_id, page, text) VALUES (${id}, ${p.page}, ${p.text})`;
  const chunkIds: string[] = [];
  for (const [i, c] of doc.chunks.entries()) {
    const embedding = c.embedding ? toVectorLiteral(c.embedding) : null;
    const [chunk] = await sql<{ id: string }[]>`
      INSERT INTO doc_chunks (document_id, chunk_index, symbol, page_start, page_end, section, text, token_estimate, embedding, embedding_model, embedding_dims)
      VALUES (${id}, ${i}, ${symbol}, ${c.pageStart ?? 1}, ${c.pageEnd ?? c.pageStart ?? 1}, ${c.section ?? null}, ${c.text}, ${Math.ceil(c.text.length / 4)},
              ${embedding}::halfvec, ${embedding ? "fake-embed" : null}, ${embedding ? 768 : null})
      RETURNING id`;
    chunkIds.push(chunk!.id);
  }
  return { id, chunkIds };
}

/** Removes every row a test created for these symbols (documents, chunks, pages, guidance cascade from companies). */
export async function cleanupSymbols(sql: Sql, symbols: string[]): Promise<void> {
  symbols.forEach(assertTestSymbol);
  await sql`DELETE FROM research_runs WHERE symbol = ANY(${symbols})`;
  await sql`DELETE FROM module_cache WHERE symbol = ANY(${symbols})`;
  await sql`DELETE FROM companies WHERE symbol = ANY(${symbols})`;
}
