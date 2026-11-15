import { describe, expect, it } from "vitest";
import { quarterMetrics, strategyFor } from "../src/metrics/registry";
import type { HeadlineMetric, ParsedFiling } from "../src/types";
import { parseIntegratedXbrl } from "../src/xbrl/parse";
import { cr, filing, FIXTURE_FILES, readXml } from "./helpers";

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
