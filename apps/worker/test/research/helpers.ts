import postgres from "postgres";
import type { Sql } from "@finn/db";
import type { EmbedDocumentInput, EmbeddingPort, LlmPort, StructuredCompletionRequest } from "@finn/shared/ports";
import type { HttpClient } from "@finn/sources/http/client";
import type { PdfPage, ScreenerCompany, ScreenerDocumentLink } from "@finn/sources/types";
import type { WorkerContext } from "../../src/context";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://finn:finn@localhost:54329/finn";

export async function connect(max = 4): Promise<{ sql: Sql; reachable: boolean }> {
  const sql = postgres(DATABASE_URL, { max, prepare: false, onnotice: () => {}, connect_timeout: 3, types: { bigint: postgres.BigInt } });
  const reachable = await sql`SELECT 1`.then(
    () => true,
    () => false,
  );
  return { sql, reachable };
}

/** Per-process suffix so concurrent runs of this suite (e.g. a full-repo run elsewhere) never clean up each other's rows. */
export const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

export function testSymbol(base: string): string {
  const s = `${base}${TAG}`;
  assertTestSymbols([s]);
  return s;
}

function assertTestSymbols(symbols: string[]): void {
  for (const s of symbols) if (!/^ZTA[A-Z0-9]*$/.test(s)) throw new Error(`refusing to touch non-test symbol ${s}`);
}

export async function insertCompany(sql: Sql, symbol: string, name = `${symbol} Test Industries Ltd`): Promise<void> {
  assertTestSymbols([symbol]);
  await sql`INSERT INTO companies (symbol, name, statement_family, sector) VALUES (${symbol}, ${name}, 'industrial', 'Test') ON CONFLICT (symbol) DO NOTHING`;
}

export async function cleanupSymbols(sql: Sql, symbols: string[]): Promise<void> {
  assertTestSymbols(symbols);
  await sql`DELETE FROM research_runs WHERE symbol = ANY(${symbols})`;
  await sql`DELETE FROM module_cache WHERE symbol = ANY(${symbols})`;
  await sql`DELETE FROM companies WHERE symbol = ANY(${symbols})`;
}

/** Fake "PDF": the magic header followed by the page texts as JSON; the mocked extractor decodes it. */
export function fakePdf(pages: string[]): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${JSON.stringify(pages)}`);
}

export function decodeFakePdf(bytes: Uint8Array): PdfPage[] {
  const text = new TextDecoder().decode(bytes);
  const pages = JSON.parse(text.slice(text.indexOf("\n") + 1)) as string[];
  return pages.map((t, i) => ({ page: i + 1, text: t }));
}

const TOPICS = ["dealer additions", "pricing actions", "capacity ramp-up", "export orders", "working capital", "brand spends", "raw material costs", "plant utilisation"];

/** Transcript-like page text with enough characters to pass the transcript-size check. */
export function transcriptPage(tag: string, page: number, sentences = 30, extra = ""): string {
  const body = Array.from(
    { length: sentences },
    (_, i) => `${tag} p${page} line ${i}: management discussed ${TOPICS[(i + page) % TOPICS.length]} and ${TOPICS[(i * 3 + page) % TOPICS.length]} with analysts.`,
  );
  return [extra, ...body].filter(Boolean).join("\n");
}

export function fakeHttp(files: Map<string, Uint8Array>): HttpClient & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    isAllowed: () => true,
    async getBuffer(url) {
      requested.push(url);
      const f = files.get(url);
      if (!f) throw new Error(`HTTP 404 for ${url}`);
      return f;
    },
    async getJson() {
      throw new Error("not used");
    },
    async getText() {
      throw new Error("not used");
    },
  };
}

/** A fetch double serving the given files, for clients built with createHttpClient. */
export function fakeFetch(files: Map<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const f = files.get(url);
    if (!f) return new Response("missing", { status: 404 });
    return new Response(f, { status: 200, headers: { "content-length": String(f.byteLength) } });
  }) as typeof fetch;
}

export function fakeEmbeddings(model = "zta-fake-embed"): EmbeddingPort & { calls: EmbedDocumentInput[][] } {
  const calls: EmbedDocumentInput[][] = [];
  const vec = (seed: number) => Array.from({ length: 768 }, (_, i) => (i === seed % 768 ? 1 : 0));
  return {
    model,
    dims: 768,
    calls,
    async embedDocuments(inputs) {
      calls.push(inputs);
      return inputs.map((_, i) => vec(i + 1));
    },
    async embedQuery() {
      return vec(1);
    },
  };
}

export type Responder = (req: StructuredCompletionRequest<unknown>) => unknown;

export function fakeLlm(routes: Record<string, Responder>): LlmPort & { calls: StructuredCompletionRequest<unknown>[] } {
  const calls: StructuredCompletionRequest<unknown>[] = [];
  return {
    calls,
    async complete<T>(req: StructuredCompletionRequest<T>): Promise<T> {
      calls.push(req as StructuredCompletionRequest<unknown>);
      const fn = routes[req.task] ?? routes["*"];
      if (!fn) throw new Error(`fakeLlm: no route for ${req.task}`);
      return req.parse(fn(req as StructuredCompletionRequest<unknown>));
    },
  };
}

export interface LogLine {
  level: string;
  obj: unknown;
  msg?: string;
}

export function fakeContext(sql: Sql, over: Partial<WorkerContext> = {}): WorkerContext & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = (level: string) => (obj: object | string, msg?: string) => lines.push({ level, obj, msg });
  return {
    sql,
    http: fakeHttp(new Map()),
    llm: fakeLlm({}),
    embeddings: fakeEmbeddings(),
    classifier: { classify: async () => ({ category: "unclassified", impact: 1, confidence: 0, oneLiner: "", reasonCodes: [] }) },
    enricher: { enrich: async () => null },
    log: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    env: { LLM_MODEL: "zta-fake-llm" },
    lines,
    ...over,
  };
}

export function link(kind: ScreenerDocumentLink["kind"], period: string, url: string, title = kind): ScreenerDocumentLink {
  return { kind, title, url, period };
}

export function screenerCompany(symbol: string, documents: ScreenerDocumentLink[], history: ScreenerCompany["history"] = []): ScreenerCompany {
  return { symbol, basis: "consolidated", documents, history, fetchedAt: new Date("2026-11-15T00:00:00Z") };
}
