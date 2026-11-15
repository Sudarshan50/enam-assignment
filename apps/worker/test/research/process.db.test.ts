import { chunksRepo } from "@finn/db/repositories/chunks";
import { documentsRepo, type DocumentRow } from "@finn/db/repositories/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { processDocument, type DocumentProgress } from "../../src/pipelines/documents";
import { cleanupSymbols, connect, decodeFakePdf, fakeContext, fakeEmbeddings, fakeHttp, fakePdf, insertCompany, testSymbol, transcriptPage } from "./helpers";

vi.mock("@finn/sources/pdf/extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@finn/sources/pdf/extract")>();
  return { ...actual, extractPdfPages: async (bytes: Uint8Array) => decodeFakePdf(bytes) };
});

const SYM = testSymbol("ZTAPROC");
const BASE = "https://www.bseindia.com/zta-proc";
const { sql, reachable } = await connect();

const goodTranscript = [1, 2, 3].map((p) => transcriptPage("zta", p));
const files = new Map<string, Uint8Array>([
  [`${BASE}/good.pdf`, fakePdf(goodTranscript)],
  [`${BASE}/scanned.pdf`, fakePdf(["", "Page 2", " "])],
  [`${BASE}/short.pdf`, fakePdf([transcriptPage("intimation", 1, 20)])],
  [`${BASE}/short-ar.pdf`, fakePdf([transcriptPage("ar", 1, 20)])],
  [`${BASE}/html.pdf`, new TextEncoder().encode("<html>blocked</html>")],
]);

async function discovered(url: string, docType: "transcript" | "annual_report" = "transcript"): Promise<DocumentRow> {
  return documentsRepo(sql).upsertDiscovered({ symbol: SYM, docType, periodLabel: docType === "transcript" ? "Q2 FY27" : "FY26", periodEnd: "2026-11-05", url });
}

async function reload(id: string): Promise<DocumentRow> {
  return (await documentsRepo(sql).get(id))!;
}

function recorder(): DocumentProgress & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    async onDownloaded(_d, info) {
      events.push(`downloaded:${info.bytes > 0}`);
    },
    async onExtracted(_d, info) {
      events.push(`extracted:${info.pages}`);
    },
    async onEmbedded(_d, info) {
      events.push(`embedded:${info.embedded}/${info.chunks}`);
    },
    async tick() {
      events.push("tick");
    },
  };
}

describe.skipIf(!reachable)("processDocument against the local database", () => {
  beforeAll(async () => {
    await cleanupSymbols(sql, [SYM]);
    await insertCompany(sql, SYM);
  });
  afterAll(async () => {
    await cleanupSymbols(sql, [SYM]);
    await sql.end({ timeout: 5 });
  });

  let goodId = "";
  let firstChunkIds: string[] = [];

  it("takes a transcript from discovered to ready, emitting progress in order", async () => {
    const doc = await discovered(`${BASE}/good.pdf`);
    goodId = doc.id;
    const embeddings = fakeEmbeddings();
    const ctx = fakeContext(sql, { embeddings });
    const progress = recorder();
    const r = await processDocument(ctx, fakeHttp(files), doc, "Zeta Pipes Ltd", progress);

    expect(r).toMatchObject({ status: "ready", pages: 3 });
    expect(r.chunks).toBeGreaterThan(0);
    const steps = progress.events.filter((e) => e !== "tick");
    expect(steps).toEqual(["downloaded:true", "extracted:3", `embedded:${r.chunks}/${r.chunks}`]);
    expect(progress.events.filter((e) => e === "tick").length).toBeGreaterThanOrEqual(3);

    const row = await reload(doc.id);
    expect(row).toMatchObject({ status: "ready", pages: 3, error: null });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.text_quality).toBeGreaterThan(0);
    expect(await documentsRepo(sql).pages(doc.id)).toHaveLength(3);
    expect(await chunksRepo(sql).countForDocument(doc.id)).toEqual({ total: r.chunks, embedded: r.chunks });
    expect(embeddings.calls.flat()[0]!.title).toMatch(/^Zeta Pipes Ltd Q2 FY27 concall/);
    firstChunkIds = (await chunksRepo(sql).listForDocument(doc.id)).map((c) => c.id);
  });

  it("skips a ready, fully embedded document without downloading or embedding", async () => {
    const http = fakeHttp(files);
    const embeddings = fakeEmbeddings();
    const r = await processDocument(fakeContext(sql, { embeddings }), http, await reload(goodId), "Zeta Pipes Ltd");
    expect(r).toEqual({ status: "skipped", pages: 3, chunks: firstChunkIds.length });
    expect(http.requested).toEqual([]);
    expect(embeddings.calls).toEqual([]);
  });

  it("re-processing the same document is idempotent: same chunk rows, unchanged text keeps its embedding", async () => {
    await documentsRepo(sql).setStatus(goodId, "discovered");
    const embeddings = fakeEmbeddings();
    const r = await processDocument(fakeContext(sql, { embeddings }), fakeHttp(files), await reload(goodId), "Zeta Pipes Ltd");
    expect(r.status).toBe("ready");
    const after = await chunksRepo(sql).listForDocument(goodId);
    expect(after.map((c) => c.id)).toEqual(firstChunkIds);
    expect(embeddings.calls).toEqual([]);
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM doc_chunks WHERE document_id = ${goodId}`;
    expect(count!.n).toBe(firstChunkIds.length);
  });

  it("resumes a crashed run from chunked: no download, embeds only what is missing", async () => {
    await sql`UPDATE doc_chunks SET embedding = NULL WHERE id = ${firstChunkIds[0]!}`;
    await documentsRepo(sql).setStatus(goodId, "chunked");
    const http = fakeHttp(files);
    const embeddings = fakeEmbeddings();
    const r = await processDocument(fakeContext(sql, { embeddings }), http, await reload(goodId), "Zeta Pipes Ltd");
    expect(r.status).toBe("ready");
    expect(http.requested).toEqual([]);
    expect(embeddings.calls.flat()).toHaveLength(1);
    expect(r.pages).toBe(3);
  });

  it("re-embeds every chunk when the embedding model changes", async () => {
    await documentsRepo(sql).setStatus(goodId, "embedded");
    const embeddings = fakeEmbeddings("zta-fake-embed-v2");
    await processDocument(fakeContext(sql, { embeddings }), fakeHttp(files), await reload(goodId), "Zeta Pipes Ltd");
    expect(embeddings.calls.flat()).toHaveLength(firstChunkIds.length);
    const models = await sql<{ embedding_model: string }[]>`SELECT DISTINCT embedding_model FROM doc_chunks WHERE document_id = ${goodId}`;
    expect(models.map((m) => m.embedding_model)).toEqual(["zta-fake-embed-v2"]);
  });

  it("marks a scanned PDF as scanned (no chunks) and skips it next time", async () => {
    const doc = await discovered(`${BASE}/scanned.pdf`, "annual_report");
    const r = await processDocument(fakeContext(sql), fakeHttp(files), doc, "Zeta Pipes Ltd");
    expect(r).toEqual({ status: "scanned", pages: 3, chunks: 0 });
    const row = await reload(doc.id);
    expect(row).toMatchObject({ status: "scanned", pages: 3, text_quality: 0 });
    expect(row.error).toMatch(/Scanned PDF/);
    expect((await chunksRepo(sql).countForDocument(doc.id)).total).toBe(0);

    const http = fakeHttp(files);
    expect((await processDocument(fakeContext(sql), http, row, "Zeta Pipes Ltd")).status).toBe("skipped");
    expect(http.requested).toEqual([]);
  });

  it("rejects a 'transcript' under 5000 characters (audio-recording intimation) but accepts the same size annual report", async () => {
    const short = await discovered(`${BASE}/short.pdf`);
    const r = await processDocument(fakeContext(sql), fakeHttp(files), short, "Zeta Pipes Ltd");
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Not a transcript: only \d+ characters/);
    expect((await reload(short.id)).status).toBe("failed");
    expect((await chunksRepo(sql).countForDocument(short.id)).total).toBe(0);

    const ar = await discovered(`${BASE}/short-ar.pdf`, "annual_report");
    expect((await processDocument(fakeContext(sql), fakeHttp(files), ar, "Zeta Pipes Ltd")).status).toBe("ready");
  });

  it("records failures (non-PDF payload, missing file, embedding outage) on the document row", async () => {
    const html = await discovered(`${BASE}/html.pdf`);
    expect((await processDocument(fakeContext(sql), fakeHttp(files), html, "Z")).error).toMatch(/Not a PDF/);
    expect((await reload(html.id)).error).toMatch(/Not a PDF/);

    const missing = await discovered(`${BASE}/missing.pdf`);
    expect((await processDocument(fakeContext(sql), fakeHttp(files), missing, "Z")).error).toMatch(/HTTP 404/);

    const outage = await discovered(`${BASE}/good.pdf?v=2`);
    const broken = { ...fakeEmbeddings(), embedDocuments: async () => Promise.reject(new Error("x".repeat(800))) };
    const files2 = new Map(files).set(`${BASE}/good.pdf?v=2`, files.get(`${BASE}/good.pdf`)!);
    const r = await processDocument(fakeContext(sql, { embeddings: broken }), fakeHttp(files2), outage, "Z");
    expect(r.status).toBe("failed");
    const row = await reload(outage.id);
    expect(row.status).toBe("failed");
    expect(row.error).toHaveLength(500);
    expect((await chunksRepo(sql).countForDocument(outage.id)).embedded).toBe(0);
  });
});
