import { describe, expect, it } from "vitest";
import { closest, combine, durationContexts, IDENTITY_TOLERANCE_PCT, identityChecker, roundingUnit } from "../src/metrics/facts";
import { quarterMetrics, strategyFor } from "../src/metrics/registry";
import type { HeadlineMetric, ParsedFiling, XbrlFact } from "../src/types";
import { parseIntegratedXbrl } from "../src/xbrl/parse";
import { BANKING_Q, cr, filing, FIXTURE_FILES, INDUSTRIAL_Q, NBFC_Q, readXml, syntheticXbrl, type SyntheticXbrlOptions } from "./helpers";

const value = (metrics: HeadlineMetric[], key: string) => metrics.find((m) => m.key === key)?.value ?? null;

describe("identity checks", () => {
  it.each(FIXTURE_FILES)("all pass on %s", (file) => {
    const f = parseIntegratedXbrl(readXml(file));
    const checks = strategyFor(f.statementFamily).checks(f);
    expect(checks.length).toBeGreaterThanOrEqual(f.ytdStart ? 9 : 5);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("fails when a total does not reconcile", () => {
    const f = filing("TCS", "30-SEP-2026");
    const tampered: ParsedFiling = { ...f, byContext: { ...f.byContext, OneD: { ...f.byContext.OneD, Income: cr(80000) } } };
    const failed = strategyFor("industrial").checks(tampered).filter((c) => !c.passed);
    expect(failed.map((c) => c.name)).toContain("OneD: total income = revenue + other income");
  });

  it("fails when a required concept is missing", () => {
    const f = filing("HDFCBANK", "30-SEP-2026");
    const { InterestExpended: _, ...rest } = f.byContext.OneD;
    const checks = strategyFor("banking").checks({ ...f, byContext: { ...f.byContext, OneD: rest } });
    expect(checks.find((c) => c.name.startsWith("OneD: required concepts"))?.passed).toBe(false);
  });
});

describe("industrial strategy", () => {
  it("computes EBITDA from profit before exceptional items", () => {
    const m = strategyFor("industrial").headline(filing("TCS", "30-SEP-2026"), "OneD");
    expect(value(m, "revenue")).toBe(cr(73188));
    // 18,638 + 252 + 1,262 - 1,337
    expect(value(m, "ebitda")).toBe(cr(18815));
    expect(m.find((x) => x.key === "ebitda")).toMatchObject({ derived: true });
    expect(value(m, "pbt")).toBe(cr(18638));
    expect(value(m, "pat")).toBe(cr(13934));
    expect(value(m, "pat_owners")).toBe(cr(13884));
  });

  it("excludes exceptional items from YTD EBITDA", () => {
    const m = strategyFor("industrial").headline(filing("TCS", "30-SEP-2026"), "FourD");
    // 37,250 + 525 + 2,501 - 2,905; the -668 exceptional item is not in EBITDA.
    expect(value(m, "ebitda")).toBe(cr(37371));
    expect(value(m, "pbt")).toBe(cr(36582));
  });
});

describe("banking strategy", () => {
  it("HDFCBANK NII is positive and sane", () => {
    const f = filing("HDFCBANK", "30-SEP-2026");
    const m = strategyFor("banking").headline(f, "OneD");
    const nii = value(m, "nii")!;
    expect(nii).toBe(cr(95131.63) - cr(50667.43));
    expect(nii).toBeGreaterThan(0);
    expect(nii).toBeLessThan(f.byContext.OneD.InterestEarned!);
    expect(nii / f.byContext.OneD.InterestEarned!).toBeGreaterThan(0.3);
    expect(nii / f.byContext.OneD.InterestEarned!).toBeLessThan(0.7);
    expect(value(m, "ppop")).toBe(cr(32871.54));
    expect(value(m, "pbt")).toBe(cr(27825.48));
  });

  it("uses the after-minority PAT for consolidated banks", () => {
    const m = strategyFor("banking").headline(filing("HDFCBANK", "30-JUN-2026"), "OneD");
    const pat = m.find((x) => x.key === "pat")!;
    expect(pat.concepts).toEqual(["ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates"]);
    expect(pat.value).toBe(cr(19244.71));
  });

  it("has no EBITDA", () => {
    expect(strategyFor("banking").cardMetricKeys).toEqual(["nii", "ppop", "pbt", "pat"]);
    expect(strategyFor("banking").margin).toBeNull();
  });
});

const synthetic = (taxonomy: string, oneD: Record<string, number>, extra: Partial<SyntheticXbrlOptions> = {}) =>
  parseIntegratedXbrl(syntheticXbrl({ taxonomy, periodStart: "2026-07-01", periodEnd: "2026-09-30", oneD, ...extra }));

const failedNames = (f: ParsedFiling) => strategyFor(f.statementFamily).checks(f).filter((c) => !c.passed).map((c) => c.name);

const omit = (facts: Record<string, number>, ...keys: string[]) => Object.fromEntries(Object.entries(facts).filter(([k]) => !keys.includes(k)));

const NO_OWNERS = ["ProfitOrLossAttributableToOwnersOfParent", "ProfitOrLossAttributableToNonControllingInterests"];

describe("rounding-aware identity tolerance", () => {
  const withFacts = (facts: Partial<XbrlFact>[]): ParsedFiling => ({
    ...filing("TCS", "30-SEP-2026"),
    facts: facts.map((x) => ({ concept: "X", context: "OneD", value: 0, unit: "INR", decimals: null, ...x })),
  });

  it("takes the coarsest negative INR decimals as the rounding unit", () => {
    expect(roundingUnit(withFacts([{ decimals: "-7" }]))).toBe(1e7);
    expect(roundingUnit(withFacts([{ decimals: "-5" }, { decimals: "-7" }, { decimals: "-6" }]))).toBe(1e7);
    expect(roundingUnit(withFacts([{ decimals: "INF" }, { decimals: "2" }, { decimals: null }, { decimals: "0" }]))).toBe(1);
    expect(roundingUnit(withFacts([{ decimals: "-7", unit: "INRPerShare" }, { decimals: "-9", unit: "pure" }]))).toBe(1);
    expect(roundingUnit(filing("HDFCBANK", "30-SEP-2026"))).toBe(1e7);
  });

  it("allows three rounding units of drift on small totals", () => {
    const check = identityChecker(withFacts([{ decimals: "-7" }]));
    expect(check("x", cr(100), cr(103))?.passed).toBe(true);
    expect(check("x", cr(100), cr(103.01))?.passed).toBe(false);
    const lakhs = identityChecker(withFacts([{ decimals: "-5" }]));
    expect(lakhs("x", cr(100), cr(100.5))?.passed).toBe(true);
    expect(lakhs("x", cr(100), cr(100.6))?.passed).toBe(false);
  });

  it("uses 0.5% of the larger magnitude on big totals, including losses", () => {
    const check = identityChecker(withFacts([{ decimals: "-7" }]));
    expect(check("x", cr(10_000), cr(10_050))?.passed).toBe(true);
    expect(check("x", cr(10_000), cr(10_051))?.passed).toBe(false);
    expect(check("x", -cr(10_000), -cr(10_050))?.passed).toBe(true);
    expect(check("x", cr(10_000), -cr(10_000))?.passed).toBe(false);
    const exact = identityChecker(withFacts([]), 0);
    expect(exact("x", 100, 103)?.passed).toBe(true);
    expect(exact("x", 100, 104)).toEqual({ name: "x", passed: false, expected: 100, actual: 104, tolerancePct: 0 });
    expect(IDENTITY_TOLERANCE_PCT).toBe(0.5);
  });

  it("skips a check when either side is missing", () => {
    const check = identityChecker(withFacts([]));
    expect(check("x", null, 1)).toBeNull();
    expect(check("x", 1, null)).toBeNull();
  });

  it("a filing in lakhs is held to a tighter floor than the same filing in crore", () => {
    // Small company whose total income is ₹2 cr above revenue + other income; everything else reconciles.
    const off = {
      RevenueFromOperations: 10,
      OtherIncome: 1,
      Income: 13,
      Expenses: 10,
      FinanceCosts: 0,
      DepreciationDepletionAndAmortisationExpense: 0,
      ProfitBeforeExceptionalItemsAndTax: 3,
      ProfitBeforeTax: 3,
      TaxExpense: 1,
      ProfitLossForPeriod: 2,
    };
    expect(failedNames(synthetic("IndAS", off, { decimals: "-7" }))).toEqual([]);
    expect(failedNames(synthetic("IndAS", off, { decimals: "-5" }))).toContain("OneD: total income = revenue + other income");
  });
});

describe("fact helpers", () => {
  it("combine is null if any term is missing", () => {
    expect(combine([[1, 5], [-1, 2], [1, -1]])).toBe(2);
    expect(combine([[1, 5], [-1, null]])).toBeNull();
    expect(combine([])).toBe(0);
  });

  it("closest picks the nearest candidate, or the first available when actual is missing", () => {
    expect(closest(10, [20, 11, null])).toBe(11);
    expect(closest(10, [null, null])).toBeNull();
    expect(closest(null, [null, 7, 8])).toBe(7);
    expect(closest(15, [10, 20])).toBe(10);
  });

  it("durationContexts drops FourD for Q1 filings", () => {
    expect(durationContexts(filing("TCS", "30-JUN-2026"))).toEqual(["OneD"]);
    expect(durationContexts(filing("TCS", "31-MAR-2026"))).toEqual(["OneD", "FourD"]);
  });

  it("names every missing required concept", () => {
    const f = synthetic("IndAS", omit(INDUSTRIAL_Q, "FinanceCosts", "OtherIncome"));
    const req = strategyFor("industrial").checks(f)[0]!;
    expect(req).toMatchObject({ passed: false, expected: 7, actual: 5, name: "OneD: required concepts present (missing FinanceCosts, OtherIncome)" });
    expect(value(strategyFor("industrial").headline(f, "OneD"), "ebitda")).toBeNull();
  });
});

describe("synthetic filings per family", () => {
  it("industrial: headline values, owners' share and one check per identity", () => {
    const f = synthetic("IndAS", INDUSTRIAL_Q);
    const q = quarterMetrics(f);
    expect(q.metrics.map((m) => [m.key, m.value === null ? null : m.value / 1e7])).toEqual([
      ["revenue", 1000],
      ["ebitda", 250],
      ["pbt", 240],
      ["pat", 180],
      ["pat_owners", 175],
    ]);
    expect(q.checks.map((c) => c.name)).toEqual([
      "OneD: required concepts present",
      "OneD: total income = revenue + other income",
      "OneD: profit before exceptional items = income - expenses",
      "OneD: PBT = profit before exceptional items + exceptional items",
      "OneD: PAT = PBT - tax (+ discontinued ops, associates)",
      "OneD: PAT = owners' share + non-controlling interests",
    ]);
    expect(q.checks.every((c) => c.passed)).toBe(true);
  });

  it("industrial without an owners' split omits pat_owners and its check", () => {
    const q = quarterMetrics(synthetic("IndAS", omit(INDUSTRIAL_Q, ...NO_OWNERS), { basis: "Standalone" }));
    expect(q.metrics.map((m) => m.key)).toEqual(["revenue", "ebitda", "pbt", "pat"]);
    expect(q.checks.some((c) => c.name.includes("owners"))).toBe(false);
  });

  it("industrial PAT accepts associates on either side of PBT, but not halfway", () => {
    const assoc = { ...omit(INDUSTRIAL_Q, ...NO_OWNERS), ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod: 20 };
    const pat = (v: number) => failedNames(synthetic("IndAS", { ...assoc, ProfitLossForPeriod: v }));
    expect(pat(200)).toEqual([]);
    expect(pat(180)).toEqual([]);
    expect(pat(190)).toEqual(["OneD: PAT = PBT - tax (+ discontinued ops, associates)"]);
  });

  it("industrial PAT includes discontinued operations", () => {
    const disc = { ...INDUSTRIAL_Q, ProfitLossFromDiscontinuedOperationsAfterTax: -30, ProfitLossForPeriod: 150, ProfitOrLossAttributableToOwnersOfParent: 145 };
    expect(failedNames(synthetic("IndAS", disc))).toEqual([]);
  });

  it("banking: NII, PPOP and after-minority PAT for consolidated", () => {
    const q = quarterMetrics(synthetic("Banking", BANKING_Q));
    expect(value(q.metrics, "nii")).toBe(cr(400));
    expect(value(q.metrics, "ppop")).toBe(cr(300));
    expect(value(q.metrics, "pat")).toBe(cr(145));
    expect(value(q.metrics, "total_income")).toBe(cr(1200));
    expect(q.checks.every((c) => c.passed)).toBe(true);
    expect(q.checks).toHaveLength(6);
  });

  it("banking: standalone PAT ignores the after-minority line; consolidated without it falls back", () => {
    const standalone = strategyFor("banking").headline(synthetic("Banking", BANKING_Q, { basis: "Standalone" }), "OneD");
    expect(standalone.find((m) => m.key === "pat")).toMatchObject({ value: cr(150), concepts: ["ProfitLossForThePeriod"] });
    const noMinority = omit(BANKING_Q, "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates");
    const consolidated = strategyFor("banking").headline(synthetic("Banking", noMinority), "OneD");
    expect(consolidated.find((m) => m.key === "pat")).toMatchObject({ value: cr(150), concepts: ["ProfitLossForThePeriod"] });
  });

  it.each([
    ["OperatingProfitBeforeProvisionAndContingencies", 310, "OneD: PPOP = total income - expenditure excl. provisions"],
    ["ProfitLossFromOrdinaryActivitiesBeforeTax", 220, "OneD: PBT = PPOP - provisions + exceptional items"],
    ["Income", 1250, "OneD: total income = interest earned + other income"],
    ["ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates", 160, "OneD: PAT after minority = PAT - minority interest + associates"],
  ])("banking: a tampered %s fails its identity", (concept, v, name) => {
    expect(failedNames(synthetic("Banking", { ...BANKING_Q, [concept]: v }))).toContain(name);
  });

  it("banking: exceptional and extraordinary items enter PBT and PAT", () => {
    const f = synthetic("Banking", { ...BANKING_Q, ExceptionalItems: -20, ProfitLossFromOrdinaryActivitiesBeforeTax: 180, ExtraordinaryItems: 10, ProfitLossForThePeriod: 140, ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates: 135 });
    expect(failedNames(f)).toEqual([]);
  });

  it("nbfc: NII, PPOP and impairment as provisions", () => {
    const q = quarterMetrics(synthetic("NBFC", NBFC_Q));
    expect(value(q.metrics, "nii")).toBe(cr(500));
    expect(value(q.metrics, "ppop")).toBe(cr(500));
    expect(q.metrics.find((m) => m.key === "provisions")?.label).toBe("Impairment on financial instruments");
    expect(q.metrics.some((m) => m.key === "pat_owners")).toBe(false);
    expect(q.checks.every((c) => c.passed)).toBe(true);
  });

  it("nbfc: a PAT that does not follow from PBT and tax fails", () => {
    expect(failedNames(synthetic("NBFC", { ...NBFC_Q, ProfitLossForPeriod: 330 }))).toEqual(["OneD: PAT = PBT - tax (+ discontinued ops, associates)"]);
  });

  it("YTD mismatches are caught too, with one check set per duration context", () => {
    const f = synthetic("IndAS", INDUSTRIAL_Q, { ytdStart: "2026-04-01", fourD: { ...INDUSTRIAL_Q, ProfitBeforeTax: 300 } });
    expect(strategyFor("industrial").checks(f)).toHaveLength(11);
    expect(failedNames(f)).toEqual(["FourD: PBT = profit before exceptional items + exceptional items", "FourD: PAT = PBT - tax (+ discontinued ops, associates)"]);
  });
});

describe("quarterMetrics", () => {
  it("reads the requested context and delegates to the resolver", () => {
    const f = filing("TCS", "30-SEP-2026");
    expect(value(quarterMetrics(f, "FourD").metrics, "revenue")).toBe(cr(145463));
    const seen: string[] = [];
    const q = quarterMetrics(f, "OneD", (family) => {
      seen.push(family);
      return { ...strategyFor(family), checks: () => [] };
    });
    expect(seen).toEqual(["industrial"]);
    expect(q).toMatchObject({ periodEnd: "2026-09-30", statementFamily: "industrial", checks: [] });
  });

  it("bank Q1 filings run the OneD checks only", () => {
    const checks = strategyFor("banking").checks(filing("HDFCBANK", "30-JUN-2026"));
    expect(checks.every((c) => !c.name.startsWith("FourD"))).toBe(true);
    expect(checks.filter((c) => c.name.startsWith("OneD: ")).length).toBe(checks.length);
  });
});

describe("nbfc strategy", () => {
  it("BAJFINANCE NII and PPOP", () => {
    const q = quarterMetrics(filing("BAJFINANCE", "30-SEP-2026"));
    expect(q.statementFamily).toBe("nbfc");
    // 21,936.39 - 8,601.73
    expect(value(q.metrics, "nii")).toBe(cr(13334.66));
    // 8,533.47 + 2,166.09
    expect(value(q.metrics, "ppop")).toBe(cr(10699.56));
    expect(value(q.metrics, "provisions")).toBe(cr(2166.09));
    expect(value(q.metrics, "pat")).toBe(cr(6366.57));
    expect(q.metrics.filter((x) => x.derived).map((x) => x.key)).toEqual(["nii", "ppop"]);
  });
});
