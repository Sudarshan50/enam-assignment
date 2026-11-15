import { chunksRepo } from "@finn/db/repositories/chunks";
import { documentsRepo } from "@finn/db/repositories/documents";
import { AskResponseSchema } from "@finn/shared/contracts/research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerQuestion } from "../src/ask/answer";
import { isWeakRetrieval, retrieve, retrieveMulti } from "../src/retrieval/hybrid";
import { cleanupSymbols, connect, insertCompany, insertDocument, testSymbol, type InsertedDocument } from "./helpers/db";
import { aliasFor, DIMS, fakeEmbeddings, fakeLlm, oneHot } from "./helpers/fakes";

const SYM = testSymbol("ZTARET");
const OTHER = testSymbol("ZTARETB");
const EMPTY = testSymbol("ZTARETE");
const { sql, reachable } = await connect();

const AXES = { dealer: 1, capex: 2, export: 3, resin: 4, guid: 5, margin: 6 };
const embeddings = fakeEmbeddings(AXES);
const deps = { sql, embeddings };

const TEXT = {
  dealer: "Our dealer network expanded to 2,400 dealers across India during FY26, deepening rural reach.",
  capex: "Capex of ₹450 crore is planned for the new Gujarat plant, adding 30% capacity by FY28.",
  export: "Exports to the Middle East grew 25% in FY26 on strong infrastructure demand.",
  resin: "Key risks include volatile PVC resin prices and competition from unorganised players.",
  guid: "We guide revenue growth of 15 to 18% for FY27 with steady dealer additions.",
  margin: "EBITDA margin was 21.5% in Q2 FY27, helped by softer input costs.",
};

let ar: InsertedDocument;
let tr: InsertedDocument;
let failed: InsertedDocument;
let other: InsertedDocument;

describe.skipIf(!reachable)("hybrid retrieval against the local database (synthetic ZTA data)", () => {
  beforeAll(async () => {
    await cleanupSymbols(sql, [SYM, OTHER, EMPTY]);
    await insertCompany(sql, SYM, "Zeta Retrieval Pipes Ltd");
    await insertCompany(sql, OTHER);
    ar = await insertDocument(sql, SYM, {
      docType: "annual_report",
      periodLabel: "FY26",
      periodEnd: "2026-03-31",
      pages: [
        { page: 1, text: "cover" },
        { page: 3, text: TEXT.dealer },
        { page: 4, text: "continued on page four" },
        { page: 9, text: TEXT.capex },
        { page: 10, text: TEXT.export },
        { page: 11, text: TEXT.resin },
      ],
      chunks: [
        { text: TEXT.dealer, pageStart: 3, pageEnd: 4, section: "Distribution", embedding: oneHot(AXES.dealer) },
        { text: TEXT.capex, pageStart: 9, embedding: oneHot(AXES.capex) },
        { text: TEXT.export, pageStart: 10, embedding: oneHot(AXES.export) },
        { text: TEXT.resin, pageStart: 11, embedding: oneHot(AXES.resin) },
      ],
    });
    tr = await insertDocument(sql, SYM, {
      docType: "transcript",
      periodLabel: "Q2 FY27",
      periodEnd: "2026-11-05",
      chunks: [
        { text: TEXT.guid, pageStart: 2, embedding: oneHot(AXES.guid) },
        { text: TEXT.margin, pageStart: 3, embedding: oneHot(AXES.margin) },
        { text: "Unembedded transcript chunk about dealer incentives and dealer schemes.", pageStart: 4, embedding: null },
      ],
    });
    failed = await insertDocument(sql, SYM, {
      docType: "annual_report",
      periodLabel: "FY25",
      periodEnd: "2025-03-31",
      status: "failed",
      chunks: [{ text: "Stale dealer dealer dealer count from a failed parse.", embedding: oneHot(AXES.dealer) }],
    });
    other = await insertDocument(sql, OTHER, {
      docType: "annual_report",
      periodLabel: "FY26",
      periodEnd: "2026-03-31",
      chunks: [{ text: TEXT.dealer, pageStart: 3, embedding: oneHot(AXES.dealer) }],
    });
  });

  afterAll(async () => {
    await cleanupSymbols(sql, [SYM, OTHER, EMPTY]);
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM doc_chunks WHERE symbol IN (${SYM}, ${OTHER})`;
    expect(left!.n).toBe(0);
    await sql.end({ timeout: 5 });
  });

  describe("repository searches", () => {
    it("FTS: matches lexically, ranks by distinct query terms, and only reads ready documents of the symbol", async () => {
      const hits = await chunksRepo(sql).ftsSearch(SYM, "Gujarat plant capacity", 10);
      expect(hits.map((h) => h.id)).toEqual([ar.chunkIds[1]]);
      expect(hits[0]!.score).toBeGreaterThan(2);
      const dealer = await chunksRepo(sql).ftsSearch(SYM, "dealers", 10);
      expect(new Set(dealer.map((h) => h.id))).toEqual(new Set([ar.chunkIds[0], tr.chunkIds[0], tr.chunkIds[2]]));
      expect(dealer.map((h) => h.id)).not.toContain(failed.chunkIds[0]);
    });

    it("FTS: OR-s natural-language terms so a question still matches", async () => {
      const hits = await chunksRepo(sql).ftsSearch(SYM, "what are the risks from resin and competition?", 10);
      expect(hits[0]!.id).toBe(ar.chunkIds[3]);
    });

    it("vector: orders by cosine distance, skips unembedded chunks and other symbols", async () => {
      const hits = await chunksRepo(sql).vectorSearch(SYM, oneHot(AXES.export), 10);
      expect(hits[0]).toMatchObject({ id: ar.chunkIds[2] });
      expect(hits[0]!.score).toBeLessThan(0.01);
      expect(hits[1]!.score).toBeGreaterThan(0.9);
      const ids = hits.map((h) => h.id);
      expect(ids).not.toContain(tr.chunkIds[2]);
      expect(ids).not.toContain(other.chunkIds[0]);
      expect(ids).not.toContain(failed.chunkIds[0]);
      expect(ids).toHaveLength(6);
    });

    it("both searches honour the docKinds filter and the limit", async () => {
      const fts = await chunksRepo(sql).ftsSearch(SYM, "dealers", 10, ["annual_report"]);
      expect(fts.map((h) => h.id)).toEqual([ar.chunkIds[0]]);
      const vec = await chunksRepo(sql).vectorSearch(SYM, oneHot(AXES.dealer), 2, ["transcript"]);
      expect(vec).toHaveLength(2);
      expect(vec.every((h) => tr.chunkIds.includes(h.id))).toBe(true);
    });
  });

  describe("retrieve()", () => {
    it("fuses FTS and vector ranks with RRF: a chunk first in both lists wins with score 2/61", async () => {
      const out = await retrieve(deps, { symbol: SYM, query: "resin prices" });
      expect(out[0]).toMatchObject({ chunkId: ar.chunkIds[3], documentLabel: "Annual Report FY26", docType: "annual_report", periodLabel: "FY26", periodEnd: "2026-03-31" });
      expect(out[0]!.ftsRank).toBeGreaterThan(0);
      expect(out[0]!.vectorDistance).toBeCloseTo(0, 2);
      expect(out[0]!.score).toBeCloseTo(2 / 61, 10);
      expect(embeddings.queryCalls.at(-1)).toEqual({ text: "resin prices", task: "search_query" });
    });

    it("vector-only: a query with no lexical match still returns the nearest chunk, without an FTS rank", async () => {
      // "exportzz" embeds near the exports chunk (fake embedder matches substrings) but shares no lexeme with it.
      const vecOnly = await retrieve(deps, { symbol: SYM, query: "xylophone exportzz" });
      expect(vecOnly[0]).toMatchObject({ chunkId: ar.chunkIds[2], ftsRank: null });
      expect(vecOnly[0]!.vectorDistance).toBeLessThan(0.01);
    });

    it("FTS-only: an unembedded chunk can still be retrieved lexically", async () => {
      const out = await retrieve(deps, { symbol: SYM, query: "dealer incentives schemes", k: 10 });
      const hit = out.find((c) => c.chunkId === tr.chunkIds[2]);
      expect(hit).toMatchObject({ vectorDistance: null, docType: "transcript", documentLabel: "Q2 FY27 concall" });
      expect(hit!.ftsRank).toBeGreaterThan(0);
    });

    it("never returns another symbol's chunks, even with identical text and embedding", async () => {
      const mine = await retrieve(deps, { symbol: SYM, query: "dealer network dealers", k: 20 });
      expect(mine.map((c) => c.chunkId)).not.toContain(other.chunkIds[0]);
      const theirs = await retrieve(deps, { symbol: OTHER, query: "dealer network dealers", k: 20 });
      expect(theirs.map((c) => c.chunkId)).toEqual([other.chunkIds[0]]);
    });

    it("filters by document kind", async () => {
      const out = await retrieve(deps, { symbol: SYM, query: "dealer growth", k: 20, docKinds: ["transcript"] });
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((c) => c.docType === "transcript")).toBe(true);
    });

    it("limits results to k (default 8) and passes the task to the embedder", async () => {
      expect(await retrieve(deps, { symbol: SYM, query: "dealer", k: 2 })).toHaveLength(2);
      expect((await retrieve(deps, { symbol: SYM, query: "dealer" })).length).toBeLessThanOrEqual(8);
      await retrieve(deps, { symbol: SYM, query: "margin", task: "question_answering" });
      expect(embeddings.queryCalls.at(-1)!.task).toBe("question_answering");
    });

    it("hydrates the full text of every page a chunk spans, in page order", async () => {
      const out = await retrieve(deps, { symbol: SYM, query: "dealer network expanded" });
      const c = out.find((x) => x.chunkId === ar.chunkIds[0])!;
      expect(c).toMatchObject({ pageStart: 3, pageEnd: 4, section: "Distribution" });
      expect(c.pages).toEqual([
        { page: 3, text: TEXT.dealer },
        { page: 4, text: "continued on page four" },
      ]);
      expect(c.url).toMatch(/^https:\/\/www\.bseindia\.com\/zta-test\//);
    });

    it("returns nothing for a symbol with no documents", async () => {
      expect(await retrieve(deps, { symbol: EMPTY, query: "dealers" })).toEqual([]);
    });
  });

  describe("retrieveMulti() and weak retrieval", () => {
    it("fuses several themed queries without one theme crowding out the rest", async () => {
      const out = await retrieveMulti(deps, { symbol: SYM, queries: ["dealer network", "capex plant", "resin risks"], perQuery: 2, k: 5 });
      const ids = out.map((c) => c.chunkId);
      expect(ids).toEqual(expect.arrayContaining([ar.chunkIds[0], ar.chunkIds[1], ar.chunkIds[3]]));
      expect(ids.length).toBeLessThanOrEqual(5);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("weak: no lexical hit and the nearest vector is far away", async () => {
      const unrelated = await retrieve(deps, { symbol: SYM, query: "zebra quantum xylophone" });
      expect(unrelated.length).toBeGreaterThan(0);
      expect(unrelated.every((c) => c.ftsRank === null)).toBe(true);
      expect(isWeakRetrieval(unrelated)).toBe(true);
      expect(isWeakRetrieval([])).toBe(true);
      expect(isWeakRetrieval(await retrieve(deps, { symbol: SYM, query: "resin" }))).toBe(false);
      expect(isWeakRetrieval(await retrieve(deps, { symbol: SYM, query: "xylophone exportzz" }))).toBe(false);
    });
  });

  describe("ask", () => {
    const answerFor = (needle: string, text: string, quote: string) =>
      fakeLlm({
        ask: (req) => ({ answerable: true, claims: [{ text, citations: [{ chunkId: aliasFor(req.user, needle), quote }] }] }),
        "ask.regenerate": () => ({ claims: [] }),
      });

    it("returns insufficientSources without calling the LLM when the company has no documents", async () => {
      const llm = fakeLlm(() => ({}));
      expect(await answerQuestion({ sql, llm, embeddings }, { symbol: EMPTY, question: "How many dealers?" })).toEqual({ answer: [], insufficientSources: true });
      expect(llm.calls).toHaveLength(0);
    });

    it("returns insufficientSources without calling the LLM when retrieval is weak", async () => {
      const llm = fakeLlm(() => ({}));
      expect(await answerQuestion({ sql, llm, embeddings }, { symbol: SYM, question: "zebra quantum xylophone?" })).toEqual({ answer: [], insufficientSources: true });
      expect(llm.calls).toHaveLength(0);
    });

    it("answers with grounded, cited claims from the symbol's own filings", async () => {
      const llm = answerFor("2,400 dealers", "The dealer network reached 2,400 dealers in FY26.", "Our dealer network expanded to 2,400 dealers across India");
      const res = await answerQuestion({ sql, llm, embeddings }, { symbol: ` ${SYM.toLowerCase()} `, question: "  How many dealers does it have? " });
      expect(() => AskResponseSchema.parse(res)).not.toThrow();
      expect(res.insufficientSources).toBe(false);
      expect(res.answer).toHaveLength(1);
      expect(res.answer[0]).toMatchObject({ grounded: true, citations: [{ chunkId: ar.chunkIds[0], documentLabel: "Annual Report FY26", page: 3 }] });
      expect(llm.calls[0]!.user).toContain(`Company: Zeta Retrieval Pipes Ltd (NSE: ${SYM})`);
      expect(llm.calls[0]!.user).toContain("Question: How many dealers does it have?");
      expect(llm.calls[0]!.ref).toMatchObject({ kind: "ask" });
      expect(embeddings.queryCalls.at(-1)!.task).toBe("question_answering");
    });

    it("keeps an ungroundable claim but marks it grounded=false after one regeneration", async () => {
      const llm = answerFor("2,400 dealers", "The dealer network reached 3,100 dealers.", "Our dealer network expanded to 2,400 dealers across India");
      const res = await answerQuestion({ sql, llm, embeddings }, { symbol: SYM, question: "How many dealers?" });
      expect(res.answer).toHaveLength(1);
      expect(res.answer[0]).toMatchObject({ text: "The dealer network reached 3,100 dealers.", grounded: false });
      expect(llm.calls.map((c) => c.task)).toEqual(["ask", "ask.regenerate"]);
    });

    it("returns insufficientSources when the model says the sources do not answer", async () => {
      const llm = fakeLlm({ ask: () => ({ answerable: false, claims: [] }) });
      expect(await answerQuestion({ sql, llm, embeddings }, { symbol: SYM, question: "What is the dealer attrition rate?" })).toEqual({ answer: [], insufficientSources: true });
    });

    it("uses the symbol as the name when the company is unknown", async () => {
      expect(await documentsRepo(sql).companyName("ZTANOPE")).toBeNull();
    });
  });

  it("uses 768-dim vectors", () => {
    expect(oneHot(1)).toHaveLength(DIMS);
  });
});
