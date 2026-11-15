import { describe, expect, it } from "vitest";
import { ResultsCardSchema, type ResultsCard } from "@finn/shared/contracts/cards";
import { strategyFor, type StrategyResolver } from "../src/metrics/registry";
import { buildResultsCard, createResultsCardBuilder, notFiledResultsCard, ResultsCardInputError } from "../src/results/buildResultsCard";
import type { ParsedFiling } from "../src/types";
import { parseIntegratedXbrl } from "../src/xbrl/parse";
import { cr, filing, readXml, syntheticXbrl } from "./helpers";

const metric = (card: ReturnType<typeof buildResultsCard>, key: string) => card.metrics.find((m) => m.key === key)!;

describe("buildResultsCard", () => {
  const tcs = buildResultsCard({
    current: filing("TCS", "30-SEP-2026"),
    previousQuarter: filing("TCS", "30-JUN-2026"),
    yearAgoQuarter: filing("TCS", "30-SEP-2025"),
    sourceRef: "nse:integrated:200121",
    previousQuarterRef: "nse:integrated:173420",
    yearAgoQuarterRef: "nse:integrated:119003",
  });

  it("passes ResultsCardSchema", () => {
    expect(() => ResultsCardSchema.parse(tcs)).not.toThrow();
  });

  it("industrial card shows Revenue, EBITDA, PBT, PAT for Q2 FY27", () => {
    expect(tcs).toMatchObject({ kind: "results", periodEnd: "2026-09-30", periodLabel: "Q2 FY27", basis: "consolidated", statementFamily: "industrial", audited: true, status: "ready" });
    expect(tcs.metrics.map((m) => m.label)).toEqual(["Revenue", "EBITDA", "PBT", "PAT"]);
    expect(tcs.ebitdaDefinition).toMatch(/Profit before exceptional items and tax \+ Finance costs/);
  });

  it("YoY and QoQ match a hand computation from each quarter's own OneD", () => {
    const rev = metric(tcs, "revenue");
    expect(rev.current.value).toBe(cr(73188));
    expect(rev.yearAgoQuarter?.value).toBe(cr(65799));
    expect(rev.previousQuarter?.value).toBe(cr(72275));
    expect(rev.yoyPct).toBeCloseTo(((73188 - 65799) / 65799) * 100, 10);
    expect(rev.qoqPct).toBeCloseTo(((73188 - 72275) / 72275) * 100, 10);
    expect(rev.yoyPct).toBeCloseTo(11.2296, 3);

    const pat = metric(tcs, "pat");
    expect(pat.yoyPct).toBeCloseTo(((13934 - 12131) / 12131) * 100, 10);
  });

  it("flags derived metrics and carries XBRL provenance per quarter", () => {
    const ebitda = metric(tcs, "ebitda");
    expect(ebitda.current).toEqual({ value: cr(18815), unit: "inr", derived: true, source: { kind: "xbrl", ref: "nse:integrated:200121" } });
    expect(ebitda.yearAgoQuarter?.source?.ref).toBe("nse:integrated:119003");
    expect(metric(tcs, "revenue").current.derived).toBe(false);
  });

  it("reports the YoY change in EBITDA margin in bps", () => {
    const now = (18815 / 73188) * 100;
    const yearAgo = (17978 / 65799) * 100;
    expect(tcs.marginBps).toMatchObject({ label: "EBITDA margin" });
    expect(tcs.marginBps!.current).toBeCloseTo(now, 2);
    expect(tcs.marginBps!.yoyBps).toBe(Math.round((now - yearAgo) * 100));
  });

  it("writes a deterministic read", () => {
    expect(tcs.read).toBe("Q2 FY27: Revenue ₹73,188 Cr (+11.2% YoY), EBITDA margin 25.7% (-161 bps YoY), PAT ₹13,934 Cr (+14.9% YoY).");
  });

  it("is null-safe when comparison filings are missing", () => {
    const card = buildResultsCard({ current: filing("TCS", "30-SEP-2026"), previousQuarter: null, yearAgoQuarter: null, sourceRef: "x" });
    expect(ResultsCardSchema.parse(card).metrics.every((m) => m.qoqPct === null && m.yoyPct === null && m.previousQuarter === null)).toBe(true);
    expect(card.marginBps).toMatchObject({ qoqBps: null, yoyBps: null });
    expect(card.read).toBe("Q2 FY27: Revenue ₹73,188 Cr, EBITDA margin 25.7%, PAT ₹13,934 Cr.");
  });

  it("banking card shows NII, PPOP, PBT, PAT without EBITDA", () => {
    const card = ResultsCardSchema.parse(
      buildResultsCard({
        current: filing("HDFCBANK", "30-SEP-2026"),
        previousQuarter: filing("HDFCBANK", "30-JUN-2026"),
        yearAgoQuarter: filing("HDFCBANK", "30-SEP-2025"),
        sourceRef: "nse:integrated:202132",
      }),
    );
    expect(card.metrics.map((m) => m.label)).toEqual(["NII", "PPOP", "PBT", "PAT"]);
    expect(card).toMatchObject({ statementFamily: "banking", audited: false, marginBps: null, ebitdaDefinition: null, status: "ready" });
    const nii = card.metrics[0]!;
    expect(nii.current.derived).toBe(true);
    expect(nii.yoyPct).toBeCloseTo(((44464.2 - 40252.98) / 40252.98) * 100, 6);
  });

  it("nbfc card shows NII, PPOP, PBT, PAT", () => {
    const card = ResultsCardSchema.parse(
      buildResultsCard({
        current: filing("BAJFINANCE", "30-SEP-2026"),
        previousQuarter: filing("BAJFINANCE", "30-JUN-2026"),
        yearAgoQuarter: filing("BAJFINANCE", "30-SEP-2025"),
        sourceRef: "nse:integrated:202442",
      }),
    );
    expect(card.metrics.map((m) => m.label)).toEqual(["NII", "PPOP", "PBT", "PAT"]);
    expect(card.read).toMatch(/^Q2 FY27: NII ₹13,335 Cr \(\+23\.6% YoY\), PAT ₹6,367 Cr \(\+28\.7% YoY\)\.$/);
  });

  it("marks the card under review when the current filing does not reconcile", () => {
    const f = filing("TCS", "30-SEP-2026");
    const broken: ParsedFiling = { ...f, byContext: { ...f.byContext, OneD: { ...f.byContext.OneD, ProfitBeforeTax: cr(1) } } };
    const card = ResultsCardSchema.parse(buildResultsCard({ current: broken, previousQuarter: null, yearAgoQuarter: null, sourceRef: "x" }));
    expect(card.status).toBe("under_review");
    expect(card.read).toMatch(/under review/);
  });

  it("refuses to compare across bases or the wrong quarter", () => {
    const current = filing("TCS", "30-SEP-2026");
    const standalone: ParsedFiling = { ...filing("TCS", "30-JUN-2026"), basis: "standalone" };
    expect(() => buildResultsCard({ current, previousQuarter: standalone, yearAgoQuarter: null, sourceRef: "x" })).toThrow(ResultsCardInputError);
    expect(() => buildResultsCard({ current, previousQuarter: filing("TCS", "31-MAR-2026"), yearAgoQuarter: null, sourceRef: "x" })).toThrow(/expected 2026-06-30/);
  });

  it("builds a not-filed-yet card with no figures", () => {
    const card = ResultsCardSchema.parse(notFiledResultsCard({ periodEnd: "2026-12-31", basis: "consolidated", statementFamily: "industrial" }));
    expect(card).toMatchObject({ status: "not_filed_yet", periodLabel: "Q3 FY27", metrics: [] });
  });
});

const pct = (now: number, base: number) => ((now - base) / Math.abs(base)) * 100;

/** Each metric's [current, previous quarter, year-ago] in crore, read off the fixtures' own OneD facts. */
function expectChanges(card: ResultsCard, expected: Record<string, [number, number, number]>) {
  expect(card.metrics.map((m) => m.key)).toEqual(Object.keys(expected));
  for (const [key, [now, prev, yago]] of Object.entries(expected)) {
    const m = metric(card, key);
    expect([m.current.value, m.previousQuarter?.value, m.yearAgoQuarter?.value]).toEqual([cr(now), cr(prev), cr(yago)]);
    expect(m.qoqPct).toBeCloseTo(pct(now, prev), 9);
    expect(m.yoyPct).toBeCloseTo(pct(now, yago), 9);
  }
}

const card3 = (symbol: string) =>
  buildResultsCard({
    current: filing(symbol, "30-SEP-2026"),
    previousQuarter: filing(symbol, "30-JUN-2026"),
    yearAgoQuarter: filing(symbol, "30-SEP-2025"),
    sourceRef: `${symbol}:cur`,
    previousQuarterRef: `${symbol}:prev`,
    yearAgoQuarterRef: `${symbol}:yago`,
  });

describe("results card: every output satisfies ResultsCardSchema without losing fields", () => {
  const cases: [string, string, string | null, string | null][] = [
    ["TCS", "30-SEP-2026", "30-JUN-2026", "30-SEP-2025"],
    ["TCS", "30-JUN-2026", "31-MAR-2026", null],
    ["TCS", "31-MAR-2026", null, null],
    ["TCS", "30-SEP-2025", null, null],
    ["HDFCBANK", "30-SEP-2026", "30-JUN-2026", "30-SEP-2025"],
    ["HDFCBANK", "30-JUN-2026", "31-MAR-2026", null],
    ["HDFCBANK", "31-MAR-2026", null, null],
    ["BAJFINANCE", "30-SEP-2026", "30-JUN-2026", "30-SEP-2025"],
    ["BAJFINANCE", "30-JUN-2026", "31-MAR-2026", null],
    ["BAJFINANCE", "30-SEP-2025", null, null],
  ];
  it.each(cases)("%s %s", (symbol, cur, prev, yago) => {
    const card = buildResultsCard({
      current: filing(symbol, cur),
      previousQuarter: prev ? filing(symbol, prev) : null,
      yearAgoQuarter: yago ? filing(symbol, yago) : null,
      sourceRef: "ref",
    });
    expect(ResultsCardSchema.parse(card)).toEqual(card);
    expect(card.status).toBe("ready");
    expect(card.metrics).toHaveLength(4);
    expect(card.metrics.every((m) => m.current.value !== null)).toBe(true);
  });

  it("not-filed-yet cards too", () => {
    for (const statementFamily of ["industrial", "banking", "nbfc"] as const) {
      const card = notFiledResultsCard({ periodEnd: "2026-12-31", basis: "standalone", statementFamily });
      expect(ResultsCardSchema.parse(card)).toEqual(card);
    }
  });
});

describe("results card: QoQ and YoY by hand", () => {
  it("TCS (industrial)", () => {
    const card = card3("TCS");
    expectChanges(card, {
      revenue: [73188, 72275, 65799],
      ebitda: [18815, 18556, 17978],
      pbt: [18638, 17944, 16068],
      pat: [13934, 13420, 12131],
    });
    expect(metric(card, "revenue").qoqPct).toBeCloseTo(1.2632, 3);
  });

  it("HDFCBANK (banking)", () => {
    const card = card3("HDFCBANK");
    expectChanges(card, {
      nii: [44464.2, 42949.7, 40252.98],
      ppop: [32871.54, 30996, 30940.72],
      pbt: [27825.48, 27193.16, 25905.79],
      pat: [20700.03, 19244.71, 19610.67],
    });
    expect(card.read).toBe("Q2 FY27: NII ₹44,464 Cr (+10.5% YoY), PAT ₹20,700 Cr (+5.6% YoY).");
  });

  it("BAJFINANCE (nbfc)", () => {
    const card = card3("BAJFINANCE");
    expectChanges(card, {
      nii: [13334.66, 12570.64, 10784.69],
      ppop: [10699.56, 10137.33, 8873.58],
      pbt: [8533.47, 8143.89, 6604.83],
      pat: [6366.57, 6080.6, 4947.76],
    });
    expect(metric(card, "ppop").yoyPct).toBeCloseTo(20.578, 2);
  });

  it("banking and NBFC cards label NII and PPOP and carry no EBITDA or margin", () => {
    for (const symbol of ["HDFCBANK", "BAJFINANCE"]) {
      const card = card3(symbol);
      expect(card.metrics.map((m) => [m.key, m.label])).toEqual([
        ["nii", "NII"],
        ["ppop", "PPOP"],
        ["pbt", "PBT"],
        ["pat", "PAT"],
      ]);
      expect(card).toMatchObject({ marginBps: null, ebitdaDefinition: null });
    }
    expect(metric(card3("HDFCBANK"), "ppop").current.derived).toBe(false);
    expect(metric(card3("BAJFINANCE"), "ppop").current.derived).toBe(true);
  });

  it("states the EBITDA definition on industrial cards", () => {
    expect(card3("TCS").ebitdaDefinition).toBe(
      "EBITDA (computed) = Profit before exceptional items and tax + Finance costs + Depreciation and amortisation - Other income. Exceptional items are excluded.",
    );
  });

  it("reports the QoQ margin change in bps alongside YoY", () => {
    const m = card3("TCS").marginBps!;
    const now = (18815 / 73188) * 100;
    expect(m.current).toBe(Math.round(now * 100) / 100);
    expect(m.qoqBps).toBe(Math.round((now - (18556 / 72275) * 100) * 100));
    expect(m.yoyBps).toBe(-161);
  });
});

describe("results card: missing and mismatched comparisons", () => {
  const cur = filing("TCS", "30-SEP-2026");

  it("without a year-ago filing, YoY is null and the read falls back to QoQ", () => {
    const card = buildResultsCard({ current: cur, previousQuarter: filing("TCS", "30-JUN-2026"), yearAgoQuarter: null, sourceRef: "x" });
    expect(card.metrics.every((m) => m.yoyPct === null && m.yearAgoQuarter === null && m.qoqPct !== null)).toBe(true);
    expect(card.marginBps).toMatchObject({ yoyBps: null });
    expect(card.marginBps!.qoqBps).not.toBeNull();
    expect(card.read).toBe("Q2 FY27: Revenue ₹73,188 Cr (+1.3% QoQ), EBITDA margin 25.7%, PAT ₹13,934 Cr (+3.8% QoQ).");
  });

  it("without a previous-quarter filing, QoQ is null but YoY stands", () => {
    const card = buildResultsCard({ current: cur, previousQuarter: null, yearAgoQuarter: filing("TCS", "30-SEP-2025"), sourceRef: "x" });
    expect(card.metrics.every((m) => m.qoqPct === null && m.previousQuarter === null && m.yoyPct !== null)).toBe(true);
    expect(card.marginBps).toMatchObject({ qoqBps: null, yoyBps: -161 });
  });

  it("omits provenance for comparison slots without a ref", () => {
    const card = buildResultsCard({ current: cur, previousQuarter: filing("TCS", "30-JUN-2026"), yearAgoQuarter: null, sourceRef: "cur" });
    expect(metric(card, "revenue").previousQuarter).toEqual({ value: cr(72275), unit: "inr", derived: false });
    expect(metric(card, "revenue").current.source).toEqual({ kind: "xbrl", ref: "cur" });
  });

  it.each([
    ["a different family", { previousQuarter: filing("HDFCBANK", "30-JUN-2026") }, "previousQuarter is banking but current is industrial"],
    ["a different basis", { yearAgoQuarter: { ...filing("TCS", "30-SEP-2025"), basis: "standalone" as const } }, "yearAgoQuarter is standalone but current is consolidated; bases must not be mixed"],
    ["the wrong year-ago quarter", { yearAgoQuarter: filing("TCS", "30-JUN-2026") }, "yearAgoQuarter ends 2026-06-30, expected 2025-09-30"],
    ["the current filing as its own previous quarter", { previousQuarter: cur }, "previousQuarter ends 2026-09-30, expected 2026-06-30"],
  ])("throws ResultsCardInputError for %s", (_label, slots, message) => {
    const run = () => buildResultsCard({ current: cur, previousQuarter: null, yearAgoQuarter: null, sourceRef: "x", ...slots });
    expect(run).toThrow(ResultsCardInputError);
    expect(run).toThrow(message);
  });

  it("Q1 compares with March and Q4 labels the fiscal year that ends", () => {
    const q1 = buildResultsCard({ current: filing("TCS", "30-JUN-2026"), previousQuarter: filing("TCS", "31-MAR-2026"), yearAgoQuarter: null, sourceRef: "x" });
    expect(q1.periodLabel).toBe("Q1 FY27");
    expect(metric(q1, "revenue").qoqPct).toBeCloseTo(pct(72275, 70698), 9);
    const q4 = buildResultsCard({ current: filing("HDFCBANK", "31-MAR-2026"), previousQuarter: null, yearAgoQuarter: null, sourceRef: "x" });
    expect(q4).toMatchObject({ periodEnd: "2026-03-31", periodLabel: "Q4 FY26", audited: true, status: "ready" });
  });

  it("labels standalone cards in the read", () => {
    const standalone = (q: string) => ({ ...filing("TCS", q), basis: "standalone" as const });
    const card = buildResultsCard({ current: standalone("30-SEP-2026"), previousQuarter: standalone("30-JUN-2026"), yearAgoQuarter: standalone("30-SEP-2025"), sourceRef: "x" });
    expect(card.basis).toBe("standalone");
    expect(card.read).toMatch(/^Q2 FY27 \(standalone\): Revenue ₹73,188 Cr/);
  });
});

describe("results card: margin semantics", () => {
  const quarter = (periodStart: string, periodEnd: string, revenue: number, ebitda: number) =>
    parseIntegratedXbrl(
      syntheticXbrl({
        taxonomy: "IndAS",
        periodStart,
        periodEnd,
        oneD: {
          RevenueFromOperations: revenue,
          OtherIncome: 0,
          Income: revenue,
          Expenses: revenue - ebitda,
          FinanceCosts: 0,
          DepreciationDepletionAndAmortisationExpense: 0,
          ProfitBeforeExceptionalItemsAndTax: ebitda,
          ProfitBeforeTax: ebitda,
          TaxExpense: 0,
          ProfitLossForPeriod: ebitda,
        },
      }),
    );
  const build = (prev: [number, number], yago: [number, number]) =>
    buildResultsCard({
      current: quarter("2026-07-01", "2026-09-30", 1000, 256.78),
      previousQuarter: quarter("2026-04-01", "2026-06-30", ...prev),
      yearAgoQuarter: quarter("2025-07-01", "2025-09-30", ...yago),
      sourceRef: "x",
    });

  it("current is a percentage to 2 dp; changes are whole basis points of the percentage difference", () => {
    const card = build([1000, 200.04], [800, 240]);
    expect(card.status).toBe("ready");
    expect(card.marginBps).toEqual({ label: "EBITDA margin", current: 25.68, qoqBps: 567, yoyBps: -432 });
    expect(card.read).toBe("Q2 FY27: Revenue ₹1,000 Cr (+25.0% YoY), EBITDA margin 25.7% (-432 bps YoY), PAT ₹257 Cr (+7.0% YoY).");
  });

  it("an expansion reads with a plus sign", () => {
    expect(build([1000, 200], [1000, 200]).read).toContain("EBITDA margin 25.7% (+568 bps YoY)");
  });

  it("a zero-revenue comparison quarter has no margin and therefore no bps change", () => {
    const card = build([0, 0], [800, 240]);
    expect(card.marginBps).toMatchObject({ current: 25.68, qoqBps: null, yoyBps: -432 });
    expect(metric(card, "revenue").qoqPct).toBeNull();
  });

  it("a loss-making base gives a positive change measured against its magnitude", () => {
    const card = build([1000, 200], [1000, -100]);
    expect(metric(card, "pat").yoyPct).toBeCloseTo(356.78, 9);
    expect(card.marginBps!.yoyBps).toBe(3568);
  });
});

describe("results card: under review and pluggable strategies", () => {
  const xml = readXml("TCS_30-SEP-2026_consolidated.xml");

  it("a tampered filing fails its identities and the card says so while still showing the figures", () => {
    const tampered = xml.replace(/(<in-capmkt:Income contextRef="OneD"[^>]*>)(\d+)/, (_m, tag: string, v: string) => `${tag}${Number(v) + cr(500)}`);
    expect(tampered).not.toBe(xml);
    const f = parseIntegratedXbrl(tampered);
    expect(
      strategyFor("industrial")
        .checks(f)
        .filter((c) => !c.passed)
        .map((c) => c.name),
    ).toEqual(["OneD: total income = revenue + other income", "OneD: profit before exceptional items = income - expenses"]);
    const card = ResultsCardSchema.parse(buildResultsCard({ current: f, previousQuarter: filing("TCS", "30-JUN-2026"), yearAgoQuarter: null, sourceRef: "x" }));
    expect(card.status).toBe("under_review");
    expect(card.read).toBe("Q2 FY27 numbers under review: the filing's totals did not reconcile.");
    expect(metric(card, "revenue").current.value).toBe(cr(73188));
  });

  it("a tampered YTD figure also blocks the card", () => {
    const tampered = xml.replace(/(<in-capmkt:ProfitBeforeTax contextRef="FourD"[^>]*>)(\d+)/, (_m, tag: string, v: string) => `${tag}${Number(v) + cr(1000)}`);
    const card = buildResultsCard({ current: parseIntegratedXbrl(tampered), previousQuarter: null, yearAgoQuarter: null, sourceRef: "x" });
    expect(card.status).toBe("under_review");
  });

  it("a filing missing a required concept is under review", () => {
    const f = filing("BAJFINANCE", "30-SEP-2026");
    const { ImpairmentOnFinancialInstruments: _, ...rest } = f.byContext.OneD;
    const card = buildResultsCard({ current: { ...f, byContext: { ...f.byContext, OneD: rest } }, previousQuarter: null, yearAgoQuarter: null, sourceRef: "x" });
    expect(card.status).toBe("under_review");
    expect(metric(card, "ppop").current.value).toBeNull();
  });

  it("uses the resolver's strategy; missing metrics fall back to their key and a bare read", () => {
    const resolve: StrategyResolver = (family) => ({ ...strategyFor(family), headline: () => [], checks: () => [] });
    const card = createResultsCardBuilder(resolve)({ current: filing("TCS", "30-SEP-2026"), previousQuarter: null, yearAgoQuarter: null, sourceRef: "x" });
    expect(card.metrics.map((m) => [m.label, m.current.value])).toEqual([
      ["revenue", null],
      ["ebitda", null],
      ["pbt", null],
      ["pat", null],
    ]);
    expect(card.marginBps).toEqual({ label: "EBITDA margin", current: null, qoqBps: null, yoyBps: null });
    expect(card.read).toBe("Q2 FY27 results filed.");
    expect(card.status).toBe("ready");
  });

  it("notFiledResultsCard has a fixed, figure-free shape", () => {
    expect(notFiledResultsCard({ periodEnd: "2027-03-31", basis: "standalone", statementFamily: "banking" })).toEqual({
      kind: "results",
      periodEnd: "2027-03-31",
      periodLabel: "Q4 FY27",
      basis: "standalone",
      statementFamily: "banking",
      audited: false,
      status: "not_filed_yet",
      metrics: [],
      marginBps: null,
      read: "Q4 FY27 numbers not filed yet.",
      ebitdaDefinition: null,
    });
  });
});
