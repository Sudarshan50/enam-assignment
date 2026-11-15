import { describe, expect, it } from "vitest";
import type { HistoryTables } from "../src/financials/history";
import { createHistoryActuals } from "../src/ledger/actuals";
import { judge, ledgerSummaryText, matchGuidance, summariseLedger, type LedgerItem, type TranscriptRef } from "../src/ledger/match";
import { parseFiscalLabel, quarterDiscussedOn } from "../src/ledger/periods";

const tables: HistoryTables = {
  profit_loss: {
    statement: "profit_loss",
    periods: ["Mar 2024", "Mar 2025", "Mar 2026", "TTM"],
    rows: [
      { label: "Sales", values: [1000, 1100, 1265, 1300] },
      { label: "Operating Profit", values: [200, 220, 278.3, 280] },
      { label: "OPM %", values: [20, 20, 22, 21.5] },
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
  { documentId: "t-q4fy26", label: "Q4 FY26 concall", callDate: "2026-05-01" },
  { documentId: "t-q1fy27", label: "Q1 FY27 concall", callDate: "2026-08-01" },
  { documentId: "t-q2fy27", label: "Q2 FY27 concall", callDate: "2026-10-01" },
];

let seq = 0;
function item(p: Partial<LedgerItem> & Pick<LedgerItem, "metric" | "horizonLabel">): LedgerItem {
  const t = transcripts.find((x) => x.documentId === (p.documentId ?? "t-q4fy26"))!;
  return {
    id: p.id ?? `g${++seq}`,
    statementType: "explicit_guidance",
    low: null,
    high: null,
    unit: "pct",
    scope: "consolidated",
    segment: null,
    quote: "We guide ...",
    saidIn: t.label,
    saidOn: t.callDate,
    documentId: t.documentId,
    withdrawn: false,
    ...p,
  };
}

const asOf = new Date("2026-11-15T06:00:00Z");
const actuals = createHistoryActuals(tables);

function run(items: LedgerItem[], opts: { tables?: HistoryTables; asOf?: Date } = {}) {
  return matchGuidance({ items, transcripts, actuals: opts.tables ? createHistoryActuals(opts.tables) : actuals, asOf: opts.asOf ?? asOf });
}

describe("fiscal periods", () => {
  it("parses labels and maps call dates to the quarter discussed", () => {
    expect(parseFiscalLabel("FY27")).toMatchObject({ start: "2026-04-01", end: "2027-03-31" });
    expect(parseFiscalLabel("H2 FY27")).toMatchObject({ start: "2026-10-01", end: "2027-03-31" });
    expect(parseFiscalLabel("Q3FY27")).toMatchObject({ label: "Q3 FY27", start: "2026-10-01", end: "2026-12-31" });
    expect(parseFiscalLabel("FY2028")?.label).toBe("FY28");
    expect(parseFiscalLabel("medium term")).toBeNull();
    expect(quarterDiscussedOn("2026-10-01").label).toBe("Q2 FY27");
    expect(quarterDiscussedOn("2026-05-12").label).toBe("Q4 FY26");
    expect(quarterDiscussedOn("2027-02-03").label).toBe("Q3 FY27");
  });
});

describe("history actuals", () => {
  it("computes full-year growth and margins from the annual table", () => {
    expect(actuals("revenue_growth", parseFiscalLabel("FY26")!)).toMatchObject({ status: "ok", value: 15 });
    expect(actuals("ebitda_margin", parseFiscalLabel("FY26")!)).toMatchObject({ status: "ok", value: 22 });
    expect(actuals("pat_growth", parseFiscalLabel("FY26")!)).toMatchObject({ status: "ok", value: 10 });
  });
  it("uses matching quarters for half years, never a single quarter", () => {
    // H1 FY27 = Jun+Sep 2026 (700) vs H1 FY26 = Jun+Sep 2025 (610)
    expect(actuals("revenue_growth", parseFiscalLabel("H1 FY27")!)).toMatchObject({ status: "ok", value: 14.8 });
  });
  it("derives capex as CFO minus FCF for full years only", () => {
    expect(actuals("capex", parseFiscalLabel("FY26")!)).toMatchObject({ status: "ok", value: 110 });
    expect(actuals("capex", parseFiscalLabel("H1 FY27")!).status).toBe("not_computable");
  });
  it("reports missing periods as not available and unknown metrics as not computable", () => {
    expect(actuals("revenue_growth", parseFiscalLabel("FY27")!).status).toBe("not_available");
    expect(actuals("order_book", parseFiscalLabel("FY26")!).status).toBe("not_computable");
  });
});

describe("judge", () => {
  it("handles ranges, points, floors, ceilings and direction", () => {
    expect(judge({ metric: "revenue_growth", low: 12, high: 16 }, 15).verdict).toBe("delivered");
    expect(judge({ metric: "revenue_growth", low: 12, high: 16 }, 11).verdict).toBe("missed");
    expect(judge({ metric: "revenue_growth", low: 12, high: 16 }, 20).verdict).toBe("delivered");
    expect(judge({ metric: "capex", low: 400, high: 500 }, 600).verdict).toBe("missed");
    expect(judge({ metric: "ebitda_margin", low: 20, high: 20 }, 18.1).verdict).toBe("delivered");
    expect(judge({ metric: "ebitda_margin", low: 20, high: 20 }, 17.9).verdict).toBe("missed");
    expect(judge({ metric: "capex", low: 500, high: 500 }, 440).verdict).toBe("missed");
    expect(judge({ metric: "capex", low: 500, high: 500 }, 560).verdict).toBe("missed");
    expect(judge({ metric: "pat_growth", low: 10, high: null }, 10).verdict).toBe("delivered");
    expect(judge({ metric: "net_debt", low: null, high: 0 }, -50).verdict).toBe("delivered");
    expect(judge({ metric: "net_debt", low: null, high: 0 }, 50).verdict).toBe("missed");
  });
});

describe("matchGuidance", () => {
  it("delivered: inside the guided range for the same full year", () => {
    const [e] = run([item({ metric: "revenue_growth", horizonLabel: "FY26", low: 12, high: 16, documentId: "t-q4fy26", saidOn: "2025-08-01" })]);
    expect(e).toMatchObject({ verdict: "delivered", actual: 15, actualPeriod: "FY26" });
    expect(e!.actualSource).toMatch(/screener/);
    expect(e!.explanation).toMatch(/within the guided range/);
  });

  it("delivered: within ±10% of a point target", () => {
    const [e] = run([item({ metric: "ebitda_margin", horizonLabel: "FY26", low: 21, high: 21, saidOn: "2025-08-01" })]);
    expect(e!.verdict).toBe("delivered");
  });

  it("not scored: segment guidance is never judged against company-wide actuals", () => {
    const [e] = run([item({ metric: "ebitda_margin", horizonLabel: "FY26", low: 16, high: 18, scope: "segment", segment: "Pipes", saidOn: "2025-08-01" })]);
    expect(e!.verdict).toBe("not_scored");
    expect(e!.explanation).toMatch(/Pipes.*company-wide/);
  });

  it("missed: outside tolerance of the point target", () => {
    const [e] = run([item({ metric: "pat_growth", horizonLabel: "FY26", low: 20, high: 20, saidOn: "2025-08-01" })]);
    expect(e).toMatchObject({ verdict: "missed", actual: 10 });
  });

  it("delivered when a half-year growth range is beaten", () => {
    const [e] = run([item({ metric: "revenue_growth", horizonLabel: "H1 FY27", low: 10, high: 12, documentId: "t-q4fy26" })]);
    expect(e).toMatchObject({ verdict: "delivered", actual: 14.8 });
  });

  it("pending: horizon not complete and recently stated", () => {
    const [e] = run([item({ metric: "revenue_growth", horizonLabel: "FY27", low: 15, high: 18, documentId: "t-q2fy27" })]);
    expect(e!.verdict).toBe("pending");
    expect(e!.explanation).toMatch(/FY27 ends 2027-03-31/);
  });

  it("pending: period ended but actuals not yet available", () => {
    const [e] = run([item({ metric: "revenue_growth", horizonLabel: "Q2 FY27", low: 5, high: 6 })], {
      tables: { ...tables, quarters: { ...tables.quarters!, periods: tables.quarters!.periods.slice(0, 5), rows: tables.quarters!.rows.map((r) => ({ ...r, values: r.values.slice(0, 5) })) } },
    });
    expect(e!.verdict).toBe("pending");
    expect(e!.explanation).toMatch(/has ended/);
  });

  it("quietly dropped: open horizon, absent from the next two calls, never withdrawn", () => {
    const [e] = run([item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t-q4fy26" })]);
    expect(e!.verdict).toBe("quietly_dropped");
    expect(e!.explanation).toMatch(/Q1 FY27 concall, Q2 FY27 concall/);
  });

  it("not dropped when only one later call has passed", () => {
    const [e] = run([item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t-q1fy27" })]);
    expect(e!.verdict).toBe("pending");
  });

  it("reiteration in a later call resets the quiet-drop clock and groups into one promise", () => {
    const entries = run([
      item({ id: "a", metric: "capex", unit: "inr_crore", horizonLabel: "FY27", low: 500, high: 500, documentId: "t-q4fy26" }),
      item({ id: "b", metric: "capex", unit: "inr_crore", horizonLabel: "FY 27", low: 500, high: 500, documentId: "t-q2fy27" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ verdict: "pending", memberIds: ["a", "b"] });
    expect(entries[0]!.representative.id).toBe("a");
  });

  it("a later mention under a variant segment name is not a quiet drop", () => {
    const entries = run([
      item({ id: "a", metric: "ebitda_margin", horizonLabel: "FY27", low: 16, high: 18, scope: "segment", segment: "Piping", documentId: "t-q4fy26" }),
      item({ id: "b", metric: "ebitda_margin", horizonLabel: "FY27", low: 16, high: 18, scope: "segment", segment: "Pipes (plumbing)", documentId: "t-q2fy27" }),
      item({ id: "c", metric: "ebitda_margin", horizonLabel: "FY27", low: 9, high: 10, scope: "segment", segment: "Paints", documentId: "t-q4fy26" }),
    ]);
    expect(entries.find((e) => e.representative.id === "a")!.verdict).toBe("pending");
    expect(entries.find((e) => e.representative.id === "c")!.verdict).toBe("quietly_dropped");
  });

  it("explicit withdrawal is not a quiet drop", () => {
    const entries = run([
      item({ id: "v1", metric: "volume_growth", horizonLabel: "FY27", low: 10, high: 10, documentId: "t-q4fy26" }),
      item({ id: "v2", metric: "volume_growth", horizonLabel: "FY27", low: 10, high: 10, documentId: "t-q1fy27", withdrawn: true }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.verdict).toBe("not_scored");
    expect(entries[0]!.explanation).toMatch(/Withdrawn by management in the Q1 FY27 concall/);
  });

  it("judges the original promise and notes later revisions", () => {
    const [e] = run([
      item({ metric: "revenue_growth", horizonLabel: "FY26", low: 18, high: 20, documentId: "t-q4fy26", saidOn: "2025-05-01", saidIn: "Q4 FY25 concall" }),
      item({ metric: "revenue_growth", horizonLabel: "FY26", low: 14, high: 16, documentId: "t-q4fy26", saidOn: "2025-11-01", saidIn: "Q2 FY26 concall" }),
    ]);
    expect(e!.verdict).toBe("missed");
    expect(e!.explanation).toMatch(/Later revised to 14%–16% \(Q2 FY26 concall\)/);
  });

  it("not scored: metric not computable, targets and aspirations, unknown horizons", () => {
    const entries = run([
      item({ metric: "order_book", unit: "inr_crore", horizonLabel: "FY26", low: 5000, high: 5000, saidOn: "2025-05-01" }),
      item({ metric: "pat_growth", horizonLabel: "FY28", low: 25, high: null, statementType: "target" }),
      item({ metric: "revenue_growth", horizonLabel: "medium term", low: 15, high: 15 }),
    ]);
    expect(entries.map((e) => e.verdict)).toEqual(["not_scored", "not_scored", "not_scored"]);
  });

  it("summarises as a fraction, never a score", () => {
    const entries = run([
      item({ metric: "revenue_growth", horizonLabel: "FY26", low: 12, high: 16, saidOn: "2025-08-01" }),
      item({ metric: "pat_growth", horizonLabel: "FY26", low: 20, high: 20, saidOn: "2025-08-01" }),
      item({ metric: "ebitda_margin", horizonLabel: "FY27", low: 24, high: 24, documentId: "t-q4fy26" }),
      item({ metric: "revenue_growth", horizonLabel: "FY27", low: 15, high: 18, documentId: "t-q2fy27" }),
    ]);
    const s = summariseLedger(entries);
    expect(s).toEqual({ elapsed: 2, delivered: 1, missed: 1, pending: 1, quietlyDropped: 1, notScored: 0 });
    expect(ledgerSummaryText(s)).toBe("1 of 2 elapsed promises delivered, 1 quietly dropped, 1 pending");
    expect(ledgerSummaryText({ elapsed: 0, delivered: 0, missed: 0, pending: 3, quietlyDropped: 0 })).toBe("No elapsed promises to score yet, 3 pending");
  });
});
