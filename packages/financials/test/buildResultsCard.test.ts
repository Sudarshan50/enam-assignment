import { describe, expect, it } from "vitest";
import { ResultsCardSchema } from "@finn/shared/contracts/cards";
import { buildResultsCard, notFiledResultsCard, ResultsCardInputError } from "../src/results/buildResultsCard";
import type { ParsedFiling } from "../src/types";
import { cr, filing } from "./helpers";

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
