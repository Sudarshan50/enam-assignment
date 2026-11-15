import { describe, expect, it } from "vitest";
import type { HistoryTables } from "../src/financials/history";
import { createHistoryActuals } from "../src/ledger/actuals";
import { extractGuidance } from "../src/ledger/extract";
import { describeTarget, ledgerSummaryText, matchGuidance, summariseLedger, type LedgerItem, type TranscriptRef } from "../src/ledger/match";
import { fiscalYearOf, parseFiscalLabel, quarterColumns, previousYear } from "../src/ledger/periods";
import { EXTRACTOR_VERSION } from "../src/prompts/guidance";
import { fakeLlm } from "./helpers/fakes";

// FY26 actuals: revenue growth 15%, EBITDA margin 22%, PAT growth 10%, capex (CFO - FCF) 110.
const tables: HistoryTables = {
  profit_loss: {
    statement: "profit_loss",
    periods: ["Mar 2024", "Mar 2025", "Mar 2026", "TTM"],
    rows: [
      { label: "Sales", values: [1000, 1100, 1265, 1300] },
      { label: "Operating Profit", values: [200, 220, 278.3, 280] },
      { label: "Net Profit", values: [100, 110, 121, 125] },
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
  cash_flow: {
    statement: "cash_flow",
    periods: ["Mar 2025", "Mar 2026"],
    rows: [
      { label: "Cash from Operating Activity", values: [150, 200] },
      { label: "Free Cash Flow", values: [60, 90] },
    ],
  },
};

const transcripts: TranscriptRef[] = [
  { documentId: "t1", label: "Q4 FY26 concall", callDate: "2026-05-01" },
  { documentId: "t2", label: "Q1 FY27 concall", callDate: "2026-08-01" },
  { documentId: "t3", label: "Q2 FY27 concall", callDate: "2026-10-01" },
];
const asOf = new Date("2026-11-15T06:00:00Z");

let seq = 0;
function item(p: Partial<LedgerItem> & Pick<LedgerItem, "metric" | "horizonLabel">): LedgerItem {
  const t = transcripts.find((x) => x.documentId === (p.documentId ?? "t1"))!;
  return {
    id: `g${++seq}`,
    statementType: "explicit_guidance",
    low: null,
    high: null,
    unit: p.metric === "capex" || p.metric === "order_book" ? "inr_crore" : "pct",
    scope: "consolidated",
    segment: null,
    quote: "We guide ...",
    saidIn: t.label,
    saidOn: p.saidOn ?? t.callDate,
    documentId: t.documentId,
    withdrawn: false,
    ...p,
  };
}

const run = (items: LedgerItem[]) => matchGuidance({ items, transcripts, actuals: createHistoryActuals(tables), asOf });
const PAST = "2025-08-01";

describe("matchGuidance verdict table", () => {
  it.each<[string, LedgerItem[], string]>([
    ["delivered: inside the range", [item({ metric: "revenue_growth", horizonLabel: "FY26", low: 12, high: 16, saidOn: PAST })], "delivered"],
    ["delivered: range beaten for a higher-is-better metric", [item({ metric: "revenue_growth", horizonLabel: "FY26", low: 10, high: 12, saidOn: PAST })], "delivered"],
    ["missed: below the range", [item({ metric: "revenue_growth", horizonLabel: "FY26", low: 18, high: 20, saidOn: PAST })], "missed"],
    ["point target: exactly +10% (capex 110 vs 100) is delivered", [item({ metric: "capex", horizonLabel: "FY26", low: 100, high: 100, saidOn: PAST })], "delivered"],
    ["point target: just beyond +10% (110 vs 99) is missed for two-sided capex", [item({ metric: "capex", horizonLabel: "FY26", low: 99, high: 99, saidOn: PAST })], "missed"],
    ["point target: 110 vs 122 (-9.8%) is delivered", [item({ metric: "capex", horizonLabel: "FY26", low: 122, high: 122, saidOn: PAST })], "delivered"],
    ["point target: 110 vs 123 (-10.6%) is missed", [item({ metric: "capex", horizonLabel: "FY26", low: 123, high: 123, saidOn: PAST })], "missed"],
    ["point target: PAT growth 10 vs 11 (within 10%) is delivered", [item({ metric: "pat_growth", horizonLabel: "FY26", low: 11, high: 11, saidOn: PAST })], "delivered"],
    ["point target: PAT growth 10 vs 11.2 (beyond 10%) is missed", [item({ metric: "pat_growth", horizonLabel: "FY26", low: 11.2, high: 11.2, saidOn: PAST })], "missed"],
    ["pending: FY27 still open, stated in the latest call", [item({ metric: "revenue_growth", horizonLabel: "FY27", low: 15, high: 18, documentId: "t3" })], "pending"],
    ["pending: only one later call has passed", [item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t2" })], "pending"],
    ["quietly dropped: open, absent from the next two calls, not withdrawn", [item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t1" })], "quietly_dropped"],
    [
      "withdrawn: an explicit withdrawal is never a quiet drop",
      [item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t1" }), item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t3", withdrawn: true })],
      "not_scored",
    ],
    ["withdrawal-only group is not scored", [item({ metric: "capex", horizonLabel: "FY27", low: 500, high: 500, documentId: "t2", withdrawn: true })], "not_scored"],
    ["closed horizon is judged, never dropped", [item({ metric: "revenue_growth", horizonLabel: "FY26", low: 12, high: 16, documentId: "t1", saidOn: "2025-05-01" })], "delivered"],
    ["segment guidance is not scored against company actuals", [item({ metric: "ebitda_margin", horizonLabel: "FY26", low: 20, high: 22, scope: "segment", segment: "Pipes", saidOn: PAST })], "not_scored"],
    ["aspiration is shown, not scored", [item({ metric: "revenue_growth", horizonLabel: "FY26", low: 30, high: 30, statementType: "aspiration", saidOn: PAST })], "not_scored"],
    ["unit mismatch: a growth metric stated in crore is not scored", [item({ metric: "revenue_growth", horizonLabel: "FY26", low: 1500, high: 1500, unit: "inr_crore", saidOn: PAST })], "not_scored"],
    ["unit mismatch: capex stated as a percentage is not scored", [item({ metric: "capex", horizonLabel: "FY26", low: 8, high: 8, unit: "pct", saidOn: PAST })], "not_scored"],
    ["floor met", [item({ metric: "revenue_growth", horizonLabel: "FY26", low: 15, high: null, saidOn: PAST })], "delivered"],
    ["ceiling breached", [item({ metric: "capex", horizonLabel: "FY26", low: null, high: 100, saidOn: PAST })], "missed"],
  ])("%s", (_name, items, verdict) => {
    const entries = run(items);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.verdict).toBe(verdict);
  });

  it("explains a unit mismatch instead of comparing incomparable numbers", () => {
    const [e] = run([item({ metric: "revenue_growth", horizonLabel: "FY26", low: 1500, high: 1500, unit: "inr_crore", saidOn: PAST })]);
    expect(e!.actual).toBeNull();
    expect(e!.explanation).toMatch(/stated in ₹ crore, but revenue growth is measured in percent/);
  });

  it("a withdrawal before the horizon closes is noted when the horizon has elapsed", () => {
    const [e] = run([
      item({ metric: "revenue_growth", horizonLabel: "FY26", low: 18, high: 20, documentId: "t1", saidOn: "2025-05-01" }),
      item({ metric: "revenue_growth", horizonLabel: "FY26", low: 18, high: 20, documentId: "t1", saidOn: "2025-11-01", withdrawn: true }),
    ]);
    expect(e!.verdict).toBe("missed");
    expect(e!.explanation).toMatch(/Withdrawn by management/);
  });

  it("uses a custom tolerance and drop threshold", () => {
    const actuals = createHistoryActuals(tables);
    const point = item({ metric: "capex", horizonLabel: "FY26", low: 100, high: 100, saidOn: PAST });
    expect(matchGuidance({ items: [point], transcripts, actuals, asOf, pointTolerance: 0.05 })[0]!.verdict).toBe("missed");
    const open = item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t1" });
    expect(matchGuidance({ items: [open], transcripts, actuals, asOf, dropAfterCalls: 3 })[0]!.verdict).toBe("pending");
  });
});

describe("ledger summary", () => {
  it("is a fraction with a denominator, never a score", () => {
    const entries = run([
      item({ metric: "revenue_growth", horizonLabel: "FY26", low: 12, high: 16, saidOn: PAST }),
      item({ metric: "pat_growth", horizonLabel: "FY26", low: 20, high: 20, saidOn: PAST }),
      item({ metric: "capex", horizonLabel: "FY26", low: 100, high: 100, saidOn: PAST }),
      item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t1" }),
    ]);
    const s = summariseLedger(entries);
    const text = ledgerSummaryText(s);
    expect(text).toBe("2 of 3 elapsed promises delivered, 1 quietly dropped");
    expect(text).not.toMatch(/score|\/100|\d+%/i);
    expect(ledgerSummaryText({ elapsed: 1, delivered: 0, missed: 1, pending: 0, quietlyDropped: 0 })).toBe("0 of 1 elapsed promise delivered");
  });

  it("describes targets of every shape", () => {
    expect(describeTarget({ low: 5, high: 5, unit: "x" })).toBe("5x");
    expect(describeTarget({ low: 1.25, high: 2, unit: "inr_crore" })).toBe("₹1.3 Cr–₹2 Cr");
    expect(describeTarget({ low: null, high: 3, unit: "pct" })).toBe("at most 3%");
    expect(describeTarget({ low: null, high: null, unit: "pct" })).toBe("an unquantified target");
  });
});

describe("fiscal period helpers", () => {
  it("handles 4-digit, compact and invalid labels", () => {
    expect(parseFiscalLabel("2HFY2027")?.label).toBe("H2 FY27");
    expect(parseFiscalLabel("3QFY27")?.label).toBe("Q3 FY27");
    expect(parseFiscalLabel("FY027")).toBeNull();
    expect(fiscalYearOf("2026-03-31")).toBe(2026);
    expect(fiscalYearOf(new Date("2026-04-01T00:00:00Z"))).toBe(2027);
    expect(quarterColumns(parseFiscalLabel("H2 FY27")!)).toEqual(["Dec 2026", "Mar 2027"]);
    expect(previousYear(parseFiscalLabel("Q4 FY27")!).label).toBe("Q4 FY26");
  });
});

describe("history actuals edge cases", () => {
  it("computes a quarterly margin and reports a missing quarter as not available", () => {
    const actuals = createHistoryActuals(tables);
    expect(actuals("ebitda_margin", parseFiscalLabel("Q2 FY27")!)).toMatchObject({ status: "ok", value: 22.2 });
    expect(actuals("ebitda_margin", parseFiscalLabel("Q3 FY27")!).status).toBe("not_available");
  });

  it("prefers fixed assets purchased for capex and reports a missing cash-flow table", () => {
    const withPurchased = createHistoryActuals({
      ...tables,
      cash_flow: { statement: "cash_flow", periods: ["Mar 2026"], rows: [{ label: "Fixed assets purchased", values: [-95] }] },
    });
    expect(withPurchased("capex", parseFiscalLabel("FY26")!)).toMatchObject({ status: "ok", value: 95 });
    const noCashFlow = createHistoryActuals({ profit_loss: tables.profit_loss });
    expect(noCashFlow("capex", parseFiscalLabel("FY26")!).status).toBe("not_computable");
    expect(createHistoryActuals(tables)("capex", parseFiscalLabel("FY27")!).status).toBe("not_available");
  });

  it("refuses growth on a non-positive base and margin on non-positive revenue", () => {
    const t: HistoryTables = {
      profit_loss: { statement: "profit_loss", periods: ["Mar 2025", "Mar 2026"], rows: [{ label: "Sales", values: [0, 100] }, { label: "Operating Profit", values: [1, 10] }, { label: "Net Profit", values: [-5, 3] }] },
    };
    const a = createHistoryActuals(t);
    expect(a("revenue_growth", parseFiscalLabel("FY26")!).status).toBe("not_computable");
    expect(a("pat_growth", parseFiscalLabel("FY26")!).status).toBe("not_computable");
    expect(a("ebitda_margin", parseFiscalLabel("FY25")!).status).toBe("not_computable");
  });
});

describe("extractGuidance", () => {
  const chunk = (id: string, text: string, page = 3) => ({
    chunkId: id,
    documentId: "doc-1",
    documentLabel: "Q2 FY27 concall",
    url: null,
    pageStart: page,
    pageEnd: page + 1,
    text,
    pages: [
      { page, text: "intro" },
      { page: page + 1, text },
    ],
  });
  const c1 = chunk("chunk-1", "Rakesh Shah, CFO: We expect revenue growth of 15 to 18% for FY27. Capex will be around 450 crore next year.");
  const c2 = chunk("chunk-2", "For the pipes segment we target EBITDA margin of at least 16% in FY28. We are withdrawing our FY27 volume guidance.", 9);
  const transcript = { documentId: "doc-1", symbol: "ZTAX", companyName: "Zeta", label: "Q2 FY27 concall", callDate: "2026-10-15", chunks: [c1, c2] };

  const base = { statementType: "explicit_guidance", scope: "consolidated", segment: null, speaker: "Rakesh Shah", withdrawn: false, unit: "pct" };
  const proposal = [
    { ...base, metric: "revenue_growth", bound: "range", low: 18, high: 15, horizon: "FY27", sourceId: "S1", quote: "We expect revenue growth of 15 to 18% for FY27." },
    { ...base, metric: "capex", bound: "point", low: null, high: 450, unit: "inr_crore", horizon: "FY 2028", sourceId: "S1", segment: "ignored", quote: "Capex will be around 450 crore next year." },
    { ...base, metric: "ebitda_margin", bound: "at_least", low: 16, high: null, horizon: "FY28", scope: "segment", segment: "Pipes", statementType: "target", sourceId: "S2", quote: "For the pipes segment we target EBITDA margin of at least 16% in FY28." },
    { ...base, metric: "volume_growth", bound: "point", low: 10, high: 10, horizon: "FY27", withdrawn: true, sourceId: "S2", quote: "We are withdrawing our FY27 volume guidance." },
    // Rejections:
    { ...base, metric: "pat_growth", bound: "at_most", low: 9, high: null, horizon: "FY27", sourceId: "S1", quote: "We expect revenue growth of 15 to 18% for FY27." },
    { ...base, metric: "revenue_growth", bound: "range", low: 15, high: 18, horizon: "FY27", sourceId: "S7", quote: "We expect revenue growth of 15 to 18% for FY27." },
    { ...base, metric: "revenue_growth", bound: "range", low: 20, high: 22, horizon: "FY27", sourceId: "S1", quote: "We expect revenue growth of 20 to 22% for FY27." },
    { ...base, metric: "revenue_growth", bound: "range", low: 15, high: 18, horizon: "medium term", sourceId: "S1", quote: "We expect revenue growth of 15 to 18% for FY27." },
    { ...base, metric: "revenue_growth", bound: "range", low: 15, high: 18, horizon: "Q1 FY27", sourceId: "S1", quote: "We expect revenue growth of 15 to 18% for FY27." },
    { ...base, metric: "revenue_growth", bound: "range", low: 15, high: null, horizon: "FY27", sourceId: "S1", quote: "Capex will be around 450 crore next year." },
    // Duplicate of the first item:
    { ...base, metric: "revenue_growth", bound: "range", low: 15, high: 18, horizon: "FY 27", sourceId: "S1", quote: "We expect revenue growth of 15 to 18% for FY27. " },
  ];

  it("keeps verbatim, well-formed future guidance and explains every rejection", async () => {
    const llm = fakeLlm({ guidance_extract: () => ({ items: proposal }) });
    const { items, stats } = await extractGuidance({ llm }, transcript);
    expect(stats).toMatchObject({ proposed: 11, kept: 4 });
    expect(stats.rejected.map((r) => r.reason)).toEqual([
      "guided value 9 not in quote",
      "unknown source S7",
      "quote not verbatim in source",
      "unrecognised horizon medium term",
      "horizon Q1 FY27 ended before the call",
      "no numeric value",
      "duplicate of revenue_growth FY27",
    ]);
    expect(stats.kept + stats.rejected.length).toBe(stats.proposed);
    expect(items.map((i) => [i.metric, i.low, i.high, i.horizonLabel])).toEqual([
      ["revenue_growth", 15, 18, "FY27"],
      ["capex", 450, 450, "FY28"],
      ["ebitda_margin", 16, null, "FY28"],
      ["volume_growth", 10, 10, "FY27"],
    ]);
    expect(items[0]).toMatchObject({ symbol: "ZTAX", documentId: "doc-1", chunkId: "chunk-1", page: 4, saidIn: "Q2 FY27 concall", saidOn: "2026-10-15", horizonStart: "2026-04-01", horizonEnd: "2027-03-31", extractorVersion: EXTRACTOR_VERSION, segment: null });
    expect(items[1]!.segment).toBeNull();
    expect(items[2]).toMatchObject({ scope: "segment", segment: "Pipes", statementType: "target" });
    expect(items[3]!.withdrawn).toBe(true);
  });

  it("rejects a malformed item on its own and keeps the rest of the reply", async () => {
    const llm = fakeLlm({
      guidance_extract: () => ({ items: [{ ...proposal[3], scope: "group" }, proposal[0], null, "FY27 revenue growth 15-18%", { ...proposal[2], low: "16%" }] }),
    });
    const { items, stats } = await extractGuidance({ llm }, transcript);
    expect(items.map((i) => [i.metric, i.horizonLabel])).toEqual([["revenue_growth", "FY27"]]);
    expect(stats).toMatchObject({ proposed: 5, kept: 1 });
    expect(stats.rejected).toHaveLength(4);
    expect(stats.rejected.every((r) => r.reason.startsWith("malformed item ("))).toBe(true);
    expect(stats.rejected[0]).toMatchObject({ reason: expect.stringContaining("scope"), quote: "We are withdrawing our FY27 volume guidance." });
    expect(stats.rejected[3]!.reason).toContain("low");
  });

  it("requires each guided number in the quote, in a compatible unit and scale", async () => {
    const c = chunk(
      "chunk-n",
      "Rakesh Shah, CFO: Revenue should grow 15% in FY27 while PAT grows faster. Capex will be ₹4.5 billion in FY28. Margins expand 150 bps in FY27. We aim to be net debt free by FY28. We expect double-digit volume growth in FY28.",
    );
    const items = [
      { ...base, metric: "revenue_growth", bound: "point", low: 15, high: 15, horizon: "FY27", sourceId: "S1", quote: "Revenue should grow 15% in FY27 while PAT grows faster." },
      { ...base, metric: "pat_growth", bound: "range", low: 15, high: 18, horizon: "FY27", sourceId: "S1", quote: "Revenue should grow 15% in FY27 while PAT grows faster." },
      { ...base, metric: "capex", bound: "point", low: 450, high: 450, unit: "inr_crore", horizon: "FY28", sourceId: "S1", quote: "Capex will be ₹4.5 billion in FY28." },
      { ...base, metric: "capex", bound: "point", low: 4.5, high: 4.5, unit: "inr_crore", horizon: "FY28", sourceId: "S1", quote: "Capex will be ₹4.5 billion in FY28." },
      { ...base, metric: "ebitda_margin", bound: "point", low: 150, high: 150, horizon: "FY27", sourceId: "S1", quote: "Margins expand 150 bps in FY27." },
      { ...base, metric: "net_debt", bound: "at_most", low: null, high: 0, unit: "inr_crore", horizon: "FY28", sourceId: "S1", quote: "We aim to be net debt free by FY28." },
      { ...base, metric: "volume_growth", bound: "at_least", low: 10, high: null, horizon: "FY28", sourceId: "S1", quote: "We expect double-digit volume growth in FY28." },
    ];
    const llm = fakeLlm({ guidance_extract: () => ({ items }) });
    const { items: kept, stats } = await extractGuidance({ llm }, { ...transcript, chunks: [c] });
    expect(kept.map((i) => [i.metric, i.low, i.high])).toEqual([
      ["revenue_growth", 15, 15],
      ["capex", 450, 450],
      ["net_debt", null, 0],
      ["volume_growth", 10, null],
    ]);
    expect(stats.rejected.map((r) => r.reason)).toEqual(["guided value 18 not in quote", "guided value 4.5 not in quote", "guided value 150 not in quote"]);
  });

  it("wraps transcript text as untrusted sources and tags the call with the document", async () => {
    const llm = fakeLlm(() => ({ items: [] }));
    await extractGuidance({ llm }, transcript);
    const call = llm.calls[0]!;
    expect(call.user).toContain("<<<SOURCES");
    expect(call.user).toContain("Call: Q2 FY27 concall, held in 2026-10");
    expect(call.system).toMatch(/untrusted/);
    expect(call.ref).toEqual({ kind: "document", id: "doc-1" });
  });

  it("splits long transcripts into batches of 45 chunks", async () => {
    const llm = fakeLlm(() => ({ items: [] }));
    const many = Array.from({ length: 50 }, (_, i) => chunk(`c${i}`, `text ${i}`));
    await extractGuidance({ llm }, { ...transcript, chunks: many });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.user).toContain('<source id="S5"');
    expect(llm.calls[1]!.user).not.toContain('<source id="S6"');
  });
});
