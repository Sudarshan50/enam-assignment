import { guidanceRepo } from "@finn/db/repositories/guidance";
import { BullBearPayloadSchema, BusinessSnapshotPayloadSchema, PromiseLedgerPayloadSchema } from "@finn/shared/contracts/research";
import type { StructuredCompletionRequest } from "@finn/shared/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HistoryTables } from "../src/financials/history";
import { LlmTransportError, LlmValidationError } from "../src/llm/errors";
import { EXTRACTOR_VERSION } from "../src/prompts/guidance";
import { bullBearModule } from "../src/modules/bullBear";
import { businessSnapshotModule } from "../src/modules/businessSnapshot";
import { promiseLedgerModule } from "../src/modules/promiseLedger";
import type { ModuleContext, ModuleDocument } from "../src/modules/types";
import { cleanupSymbols, connect, insertCompany, insertDocument, testSymbol, type FixtureDocument, type InsertedDocument } from "./helpers/db";
import { aliasFor, fakeEmbeddings, fakeLlm, oneHot, parseSources, type LlmResponder } from "./helpers/fakes";

const SYM = testSymbol("ZTAMOD");
const SMALL = testSymbol("ZTAMODS");
const { sql, reachable } = await connect();
const embeddings = fakeEmbeddings({ dealer: 1, capex: 2, export: 3, resin: 4, receivable: 5, brand: 6 });

const AR = {
  overview: "Zeta Pipes makes PVC pipes and fittings sold through 2,400 dealers across India. Pipes contributed 70% of revenue in FY26 while adhesives contributed 30%.",
  capex: "Capex of ₹450 crore is planned for a new plant in Gujarat to expand capacity by 30%.",
  exports: "Exports to the Middle East grew 25% in FY26 on strong demand for our products.",
  risks: "Key risks include volatile PVC resin prices and intense competition from unorganised players.",
  receivables: "Receivable days increased to 45 days from 38 days, stretching working capital.",
  brand: "Our brand Zeta is a market leader with a 12% share of the organised pipes market.",
};

const T = {
  q4fy26: "Rakesh Shah, CFO: For FY27 we expect revenue growth of 15 to 18%. In H1 FY27 we expect revenue growth of at least 10%. Volume growth should be around 12% in FY27.",
  q1fy27: "Rakesh Shah, CFO: We expect EBITDA margin of 25% in Q2 FY27 as resin prices soften.",
  q2fy27: "Rakesh Shah, CFO: We reiterate revenue growth of 15 to 18% for FY27.",
};

const history: HistoryTables = {
  profit_loss: {
    statement: "profit_loss",
    periods: ["Mar 2025", "Mar 2026"],
    rows: [
      { label: "Sales", values: [1100, 1265] },
      { label: "Operating Profit", values: [220, 278.3] },
      { label: "Net Profit", values: [110, 121] },
    ],
  },
  quarters: {
    statement: "quarters",
    periods: ["Jun 2025", "Sep 2025", "Dec 2025", "Mar 2026", "Jun 2026", "Sep 2026"],
    rows: [
      { label: "Sales", values: [300, 310, 320, 335, 340, 360] },
      { label: "Operating Profit", values: [60, 62, 70, 86, 75, 80] },
      { label: "Net Profit", values: [28, 29, 30, 34, 32, 34] },
    ],
  },
};

const docs: Record<string, InsertedDocument> = {};
const moduleDocs: ModuleDocument[] = [];

function transcript(periodLabel: string, periodEnd: string, text: string): FixtureDocument {
  return { docType: "transcript", periodLabel, periodEnd, pages: [{ page: 1, text: "Operator: welcome." }, { page: 2, text }], chunks: [{ text, pageStart: 2, embedding: oneHot(7) }] };
}

function ctx(llm: ModuleContext["llm"], over: Partial<ModuleContext> = {}): ModuleContext {
  return {
    symbol: SYM,
    companyName: "Zeta Pipes Ltd",
    runId: "11111111-1111-4111-8111-111111111111",
    sql,
    llm,
    embeddings,
    documents: moduleDocs,
    history,
    asOf: new Date("2026-11-15T06:00:00Z"),
    ...over,
  };
}

const claim = (user: string, needle: string, text: string, quote: string) => ({ text, citations: [{ chunkId: aliasFor(user, needle), quote }] });

describe.skipIf(!reachable)("research modules against the local database (synthetic ZTA data)", () => {
  beforeAll(async () => {
    await cleanupSymbols(sql, [SYM, SMALL]);
    await insertCompany(sql, SYM, "Zeta Pipes Ltd");
    await insertCompany(sql, SMALL);
    docs.ar = await insertDocument(sql, SYM, {
      docType: "annual_report",
      periodLabel: "FY26",
      periodEnd: "2026-03-31",
      chunks: Object.values(AR).map((text, i) => ({ text, pageStart: 10 + i, embedding: oneHot(i + 1) })),
    });
    docs.t1 = await insertDocument(sql, SYM, transcript("Q4 FY26", "2026-05-10", T.q4fy26));
    docs.t2 = await insertDocument(sql, SYM, transcript("Q1 FY27", "2026-08-10", T.q1fy27));
    docs.t3 = await insertDocument(sql, SYM, transcript("Q2 FY27", "2026-11-05", T.q2fy27));
    for (const [key, label, type, periodLabel, periodEnd] of [
      ["ar", "Annual Report FY26", "annual_report", "FY26", "2026-03-31"],
      ["t1", "Q4 FY26 concall", "transcript", "Q4 FY26", "2026-05-10"],
      ["t2", "Q1 FY27 concall", "transcript", "Q1 FY27", "2026-08-10"],
      ["t3", "Q2 FY27 concall", "transcript", "Q2 FY27", "2026-11-05"],
    ] as const) {
      moduleDocs.push({ id: docs[key]!.id, docType: type, label, periodLabel, periodEnd, url: `https://www.bseindia.com/${key}.pdf`, sha256: key, pages: 2 });
    }
    docs.small = await insertDocument(sql, SMALL, {
      docType: "annual_report",
      periodLabel: "FY26",
      periodEnd: "2026-03-31",
      chunks: [{ text: AR.overview, embedding: oneHot(1) }, { text: AR.capex, embedding: oneHot(2) }],
    });
  });

  afterAll(async () => {
    await cleanupSymbols(sql, [SYM, SMALL]);
    await sql.end({ timeout: 5 });
  });

  describe("bull / bear", () => {
    const respond: Record<string, LlmResponder> = {
      bull_bear: (req) => ({
        bull: [
          claim(req.user, "Exports", "Exports to the Middle East grew 25% in FY26.", "Exports to the Middle East grew 25% in FY26"),
          claim(req.user, "brand Zeta", "Zeta leads the organised pipes market with a 12% share.", "Our brand Zeta is a market leader with a 12% share"),
        ],
        bear: [
          claim(req.user, "Receivable", "Receivable days rose to 45 from 38.", "Receivable days increased to 45 days from 38 days"),
          claim(req.user, "volatile PVC resin", "PVC resin prices fell 40%.", "Key risks include volatile PVC resin prices"),
        ],
      }),
      "bull_bear.regenerate": (req) => ({ claims: [claim(req.user, "volatile PVC resin", "Resin prices are volatile.", "Key risks include volatile PVC resin prices")] }),
    };

    it("returns a schema-valid payload whose claims are grounded, with one regeneration for the bad bear point", async () => {
      const llm = fakeLlm(respond);
      const r = await bullBearModule.run(ctx(llm));
      expect(r.status).toBe("done");
      const p = BullBearPayloadSchema.parse(r.payload);
      expect(p.bull.map((c) => c.text)).toEqual(["Exports to the Middle East grew 25% in FY26.", "Zeta leads the organised pipes market with a 12% share."]);
      expect(p.bear.map((c) => c.text)).toEqual(["Receivable days rose to 45 from 38.", "Resin prices are volatile."]);
      expect([...p.bull, ...p.bear].every((c) => c.grounded && c.citations[0]!.documentId === docs.ar!.id)).toBe(true);
      expect(llm.calls.map((c) => c.task)).toEqual(["bull_bear", "bull_bear.regenerate"]);
      expect(llm.calls[0]!.ref).toEqual({ kind: "research_run", id: "11111111-1111-4111-8111-111111111111" });
      expect(llm.calls[0]!.user).toContain("<<<SOURCES");
    });

    it("only ever sees chunks of its own symbol", async () => {
      const llm = fakeLlm(respond);
      await bullBearModule.run(ctx(llm));
      const all = await sql<{ text: string }[]>`SELECT text FROM doc_chunks WHERE symbol = ${SYM}`;
      const allowed = new Set(all.map((r) => r.text));
      for (const s of parseSources(llm.calls[0]!.user)) expect(allowed.has(s.text)).toBe(true);
    });

    it("caps each side at 4 points", async () => {
      const llm = fakeLlm({
        bull_bear: (req) => {
          const c = claim(req.user, "Exports", "Exports to the Middle East grew 25% in FY26.", "Exports to the Middle East grew 25% in FY26");
          return { bull: Array(6).fill(c), bear: Array(5).fill(c) };
        },
      });
      const p = BullBearPayloadSchema.parse((await bullBearModule.run(ctx(llm))).payload);
      expect([p.bull.length, p.bear.length]).toEqual([4, 4]);
    });

    it("is insufficient with no documents, too few passages, or no supported points", async () => {
      const never = fakeLlm(() => {
        throw new Error("must not be called");
      });
      expect(await bullBearModule.run(ctx(never, { documents: [] }))).toMatchObject({ status: "insufficient_sources", payload: null });
      const small = await bullBearModule.run(ctx(never, { symbol: SMALL, documents: [moduleDocs[0]!] }));
      expect(small).toMatchObject({ status: "insufficient_sources", reason: expect.stringMatching(/Only 2 relevant passages/) });
      expect(never.calls).toHaveLength(0);
      const empty = await bullBearModule.run(ctx(fakeLlm(() => ({ bull: [], bear: [] }))));
      expect(empty.status).toBe("insufficient_sources");
    });
  });

  describe("business snapshot", () => {
    it("keeps a segment share only when the percentage is in that segment's cited source", async () => {
      const llm = fakeLlm({
        business_snapshot: (req) => ({
          description: claim(req.user, "Zeta Pipes makes", "Zeta Pipes sells PVC pipes and fittings through 2,400 dealers.", "Zeta Pipes makes PVC pipes and fittings sold through 2,400 dealers"),
          segments: [
            { name: "Pipes", sharePct: 70, claim: claim(req.user, "Zeta Pipes makes", "Pipes are the main business.", "Pipes contributed 70% of revenue in FY26") },
            { name: "Adhesives", sharePct: 45, claim: claim(req.user, "Zeta Pipes makes", "Adhesives are the second segment.", "adhesives contributed 30%") },
            { name: "Fittings", sharePct: 20, claim: claim(req.user, "Zeta Pipes makes", "Fittings make up 20% of sales.", "PVC pipes and fittings") },
          ],
        }),
        "business_snapshot.regenerate": () => ({ claims: [] }),
      });
      const r = await businessSnapshotModule.run(ctx(llm));
      const p = BusinessSnapshotPayloadSchema.parse(r.payload);
      expect(p.description).toMatchObject({ grounded: true });
      expect(p.segments.map((s) => [s.name, s.sharePct, s.claim.grounded])).toEqual([
        ["Pipes", 70, true],
        ["Adhesives", null, true],
        ["Fittings", null, false],
      ]);
    });

    it("works without a description and is insufficient when nothing is described", async () => {
      const segOnly = fakeLlm({
        business_snapshot: (req) => ({ description: null, segments: [{ name: "Pipes", sharePct: null, claim: claim(req.user, "Zeta Pipes makes", "Pipes are sold via dealers.", "PVC pipes and fittings sold through") }] }),
      });
      const p = BusinessSnapshotPayloadSchema.parse((await businessSnapshotModule.run(ctx(segOnly))).payload);
      expect(p.description).toBeNull();
      expect(p.segments).toHaveLength(1);
      expect((await businessSnapshotModule.run(ctx(fakeLlm(() => ({ description: null, segments: [] })))))).toMatchObject({ status: "insufficient_sources" });
      expect((await businessSnapshotModule.run(ctx(fakeLlm(() => ({})), { documents: [] })))).toMatchObject({ status: "insufficient_sources" });
      expect((await businessSnapshotModule.run(ctx(fakeLlm(() => ({})), { symbol: SMALL })))).toMatchObject({ status: "insufficient_sources" });
    });
  });

  describe("Promise Ledger", () => {
    const byDoc = (req: StructuredCompletionRequest<unknown>) => {
      const s = (quote: string, rest: Record<string, unknown>) => ({
        statementType: "explicit_guidance",
        scope: "consolidated",
        segment: null,
        speaker: "Rakesh Shah",
        withdrawn: false,
        unit: "pct",
        sourceId: "S1",
        quote,
        ...rest,
      });
      const id = req.ref?.id;
      if (id === docs.t1!.id)
        return {
          items: [
            s("For FY27 we expect revenue growth of 15 to 18%.", { metric: "revenue_growth", bound: "range", low: 15, high: 18, horizon: "FY27" }),
            s("In H1 FY27 we expect revenue growth of at least 10%.", { metric: "revenue_growth", bound: "at_least", low: 10, high: null, horizon: "H1 FY27" }),
            s("Volume growth should be around 12% in FY27.", { metric: "volume_growth", bound: "point", low: 12, high: 12, horizon: "FY27" }),
          ],
        };
      if (id === docs.t2!.id) return { items: [s("We expect EBITDA margin of 25% in Q2 FY27 as resin prices soften.", { metric: "ebitda_margin", bound: "point", low: 25, high: 25, horizon: "Q2 FY27" })] };
      if (id === docs.t3!.id) return { items: [s("We reiterate revenue growth of 15 to 18% for FY27.", { metric: "revenue_growth", bound: "range", low: 15, high: 18, horizon: "FY27" })] };
      return { items: [] };
    };

    it("extracts, stores and judges guidance; the payload passes its schema and the summary is a fraction", async () => {
      const llm = fakeLlm({ guidance_extract: byDoc });
      const logs: string[] = [];
      const r = await promiseLedgerModule.run(ctx(llm, { log: (m) => logs.push(m) }));
      const p = PromiseLedgerPayloadSchema.parse(r.payload);
      expect(llm.calls).toHaveLength(3);
      expect(logs).toEqual(["guidance extracted", "guidance extracted", "guidance extracted"]);
      expect(p.transcriptsUsed).toEqual(["Q2 FY27 concall", "Q1 FY27 concall", "Q4 FY26 concall"]);
      const verdicts = Object.fromEntries(p.promises.map((x) => [`${x.metric}:${x.horizonLabel}`, x.verdict]));
      expect(verdicts).toEqual({
        "revenue_growth:FY27": "pending",
        "revenue_growth:H1 FY27": "delivered",
        "volume_growth:FY27": "quietly_dropped",
        "ebitda_margin:Q2 FY27": "missed",
      });
      expect(p.summary).toEqual({ elapsed: 2, delivered: 1, missed: 1, pending: 1, quietlyDropped: 1 });
      const delivered = p.promises.find((x) => x.verdict === "delivered")!;
      expect(delivered).toMatchObject({ actual: 14.8, actualPeriod: "H1 FY27", speaker: "Rakesh Shah", horizonEnd: "2026-09-30", saidIn: "Q4 FY26 concall" });
      expect(delivered.citation).toMatchObject({ chunkId: docs.t1!.chunkIds[0], documentId: docs.t1!.id, documentLabel: "Q4 FY26 concall", page: 2, url: "https://www.bseindia.com/t1.pdf" });
    });

    it("persists items and checks, and re-running keeps ids stable without duplicates", async () => {
      const llm = fakeLlm({ guidance_extract: byDoc });
      await promiseLedgerModule.run(ctx(llm));
      const first = await guidanceRepo(sql).listBySymbol(SYM);
      await promiseLedgerModule.run(ctx(llm));
      const second = await guidanceRepo(sql).listBySymbol(SYM);
      expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
      expect(second).toHaveLength(5);
      const checks = await sql<{ verdict: string }[]>`
        SELECT c.verdict FROM guidance_checks c JOIN guidance_items g ON g.id = c.guidance_id WHERE g.symbol = ${SYM} ORDER BY c.verdict`;
      expect(checks.map((c) => c.verdict)).toEqual(["delivered", "missed", "pending", "pending", "quietly_dropped"]);
    });

    it("drops stale items when a later extraction no longer finds them", async () => {
      const llm = fakeLlm({ guidance_extract: (req) => (req.ref?.id === docs.t2!.id ? { items: [] } : byDoc(req)) });
      await promiseLedgerModule.run(ctx(llm));
      expect(await guidanceRepo(sql).listForDocument(docs.t1!.id, EXTRACTOR_VERSION)).not.toEqual([]);
      expect(await guidanceRepo(sql).listForDocument(docs.t2!.id, EXTRACTOR_VERSION)).toEqual([]);
    });

    const unreadable = (id: string) => (req: StructuredCompletionRequest<unknown>) => {
      if (req.ref?.id === id) throw new LlmValidationError("guidance_extract: response cut off at the 6000 token limit before the JSON was complete", "guidance_extract");
      return byDoc(req);
    };

    it("an unreadable call keeps its earlier guidance, and the ledger built without it is not cached", async () => {
      await promiseLedgerModule.run(ctx(fakeLlm({ guidance_extract: byDoc })));
      const logs: string[] = [];
      const r = await promiseLedgerModule.run(ctx(fakeLlm({ guidance_extract: unreadable(docs.t2!.id) }), { log: (m) => logs.push(m) }));
      expect(r).toMatchObject({ status: "done", cacheable: false });
      const p = PromiseLedgerPayloadSchema.parse(r.payload);
      expect(p.transcriptsUsed).toEqual(["Q2 FY27 concall", "Q1 FY27 concall", "Q4 FY26 concall"]);
      expect(p.transcriptsUnread).toBeUndefined();
      expect(p.promises.find((x) => x.metric === "ebitda_margin")).toMatchObject({ verdict: "missed", saidIn: "Q1 FY27 concall" });
      expect(logs.filter((m) => m === "guidance extraction failed")).toHaveLength(1);
    });

    it("names a call that has never been read, builds the ledger from the rest and does not read its silence as dropped guidance", async () => {
      await guidanceRepo(sql).replaceForDocument(docs.t3!.id, []);
      const r = await promiseLedgerModule.run(ctx(fakeLlm({ guidance_extract: unreadable(docs.t3!.id) })));
      const p = PromiseLedgerPayloadSchema.parse(r.payload);
      expect(p.transcriptsUsed).toEqual(["Q1 FY27 concall", "Q4 FY26 concall"]);
      expect(p.transcriptsUnread).toEqual(["Q2 FY27 concall"]);
      expect(p.summary).toEqual({ elapsed: 2, delivered: 1, missed: 1, pending: 2, quietlyDropped: 0 });
    });

    it("still fails when every call is unreadable or the provider itself fails", async () => {
      const allBad = fakeLlm({ guidance_extract: () => { throw new LlmValidationError("guidance_extract: invalid JSON", "guidance_extract"); } });
      await expect(promiseLedgerModule.run(ctx(allBad))).rejects.toBeInstanceOf(LlmValidationError);
      const down = fakeLlm({ guidance_extract: (req) => { if (req.ref?.id === docs.t2!.id) throw new LlmTransportError("LLM HTTP 503", 503); return byDoc(req); } });
      await expect(promiseLedgerModule.run(ctx(down))).rejects.toBeInstanceOf(LlmTransportError);
      expect(await promiseLedgerModule.run(ctx(fakeLlm({ guidance_extract: byDoc })))).not.toHaveProperty("cacheable");
    });

    it("is insufficient without dated transcripts", async () => {
      const llm = fakeLlm(() => ({ items: [] }));
      const noTranscripts = moduleDocs.filter((d) => d.docType !== "transcript");
      expect(await promiseLedgerModule.run(ctx(llm, { documents: noTranscripts }))).toMatchObject({ status: "insufficient_sources" });
      const undated = moduleDocs.map((d) => ({ ...d, periodEnd: null }));
      expect(await promiseLedgerModule.run(ctx(llm, { documents: undated }))).toMatchObject({ status: "insufficient_sources" });
      expect(llm.calls).toHaveLength(0);
    });
  });
});
