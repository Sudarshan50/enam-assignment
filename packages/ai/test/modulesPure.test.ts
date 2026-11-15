import { CashQualityPayloadSchema, FinancialSnapshotPayloadSchema, MODULE_KEYS } from "@finn/shared/contracts/research";
import { describe, expect, it } from "vitest";
import type { Sql } from "@finn/db";
import { findRow, fyLabelOfColumn, labelKey, periodColumns, tablesFromRows, valueAt, type HistoryTable, type HistoryTables } from "../src/financials/history";
import { fmtCr, historyClaim } from "../src/financials/claims";
import { cashQualityModule, cashYears } from "../src/modules/cashQuality";
import { financialSnapshotModule } from "../src/modules/financialSnapshot";
import { createDefaultModuleRegistry, moduleCacheKey, ModuleRegistry } from "../src/modules/registry";
import type { ModuleContext, ModuleDocument, ResearchModuleRunner } from "../src/modules/types";
import { backoffMs, mapWithConcurrency } from "../src/util/concurrency";
import { hashParts, stableStringify } from "../src/util/hash";
import { parseModelJson } from "../src/util/json";
import { formatZodError } from "../src/util/schema";
import { fakeEmbeddings, fakeLlm } from "./helpers/fakes";

const years = ["Mar 2021", "Mar 2022", "Mar 2023", "Mar 2024", "Mar 2025", "Mar 2026"];
const pl: HistoryTable = {
  statement: "profit_loss",
  periods: [...years, "TTM"],
  rows: [
    { label: "Sales\u00a0+", values: [800, 900, 1000, 1100, 1265, 1400, 1450] },
    { label: "Operating Profit", values: [120, 150, 180, 200, 278, 300, 310] },
    { label: "Net Profit +", values: [60, 70, 80, 100, 110, 125, 130] },
  ],
};
const quarters: HistoryTable = {
  statement: "quarters",
  periods: ["Jun 2025", "Sep 2025", "Dec 2025", "Mar 2026", "Jun 2026", "Sep 2026"],
  rows: [
    { label: "Sales", values: [300, 310, 320, 335, 340, 372] },
    { label: "Operating Profit", values: [60, 62, 70, 86, 75, 80] },
    { label: "Net Profit", values: [28, 29, 30, 34, 32, 25] },
  ],
};
const cashFlow: HistoryTable = {
  statement: "cash_flow",
  periods: years,
  rows: [
    { label: "Cash from Operating Activity +", values: [40, 50, 60, 70, 80, 95] },
    { label: "Fixed assets purchased", values: [-30, -40, -90, -50, -60, -70] },
  ],
};
const balance: HistoryTable = {
  statement: "balance_sheet",
  periods: years,
  rows: [
    { label: "Equity Capital", values: [10, 10, 10, 10, 10, 10] },
    { label: "Reserves", values: [300, 350, 400, 450, -20, 590] },
    { label: "Borrowings +", values: [100, 90, 80, 70, 60, 50] },
  ],
};
const ratios: HistoryTable = {
  statement: "ratios",
  periods: years,
  rows: [{ label: "Working Capital Days", values: [60, 65, 70, 75, 80, 85] }],
};
const history: HistoryTables = tablesFromRows([pl, quarters, cashFlow, balance, ratios]);

function ctx(over: Partial<ModuleContext> = {}): ModuleContext {
  return {
    symbol: "ZTAPURE",
    companyName: "Zeta Pure Ltd",
    runId: null,
    sql: {} as Sql,
    llm: fakeLlm(() => {
      throw new Error("history modules must not call the LLM");
    }),
    embeddings: fakeEmbeddings({}),
    documents: [],
    history,
    asOf: new Date("2026-11-15T06:00:00Z"),
    ...over,
  };
}

describe("history helpers", () => {
  it("normalises screener labels and finds rows by alias or prefix", () => {
    expect(labelKey("Sales\u00a0+")).toBe("sales");
    expect(findRow({ statement: "cash_flow", periods: ["Mar 2026"], rows: [{ label: "CFO/EBITDA Share of operating profit", values: [80] }] }, "cfoToEbitda")).toEqual([80]);
    expect(findRow(undefined, "revenue")).toBeNull();
    expect(valueAt(pl, "revenue", "Mar 2030")).toBeNull();
    expect(valueAt(undefined, "revenue", "Mar 2026")).toBeNull();
    expect(periodColumns(pl)).toEqual(years);
    expect(fyLabelOfColumn("Sep 2026")).toBe("FY27");
    expect(fmtCr(123456.4)).toBe("₹1,23,456 Cr");
    expect(historyClaim("A&B", "ratios", "t", "q").citations[0]!.url).toBe("https://www.screener.in/company/A%26B/consolidated/");
  });
});

describe("financial snapshot module", () => {
  it("builds a schema-valid payload with series, headlines and grounded deterministic takeaways", async () => {
    const r = await financialSnapshotModule.run(ctx());
    expect(r.status).toBe("done");
    const p = FinancialSnapshotPayloadSchema.parse(r.payload);
    expect(p.series.map((s) => s.key)).toEqual(["revenue_annual", "ebitda_annual", "pat_annual", "ebitda_margin_annual", "revenue_quarterly", "pat_quarterly", "ebitda_margin_quarterly"]);
    expect(p.headline.find((h) => h.label === "Revenue")).toMatchObject({ value: 1400, period: "FY26", unit: "inr_crore" });
    expect(p.headline.find((h) => h.label === "Quarterly revenue YoY")).toMatchObject({ value: 20, period: "Q2 FY27" });
    expect(p.takeaways.map((t) => t.text)).toEqual([
      "Revenue compounded at 11.8% a year over 5 years, from ₹800 Cr in FY21 to ₹1,400 Cr in FY26.",
      "EBITDA margin expanded from 15.0% to 21.4% over the period.",
      "In Q2 FY27, revenue grew 20.0% year on year to ₹372 Cr and net profit fell 13.8%.",
    ]);
    expect(p.takeaways.every((t) => t.grounded && t.citations.length === 1)).toBe(true);
  });

  it("reports insufficient sources without at least two annual columns", async () => {
    const r = await financialSnapshotModule.run(ctx({ history: { profit_loss: { ...pl, periods: ["Mar 2026", "TTM"], rows: pl.rows.map((x) => ({ ...x, values: x.values.slice(-2) })) } } }));
    expect(r).toMatchObject({ status: "insufficient_sources", payload: null });
    expect((await financialSnapshotModule.run(ctx({ history: {} }))).status).toBe("insufficient_sources");
  });

  it("works without a quarterly table", async () => {
    const r = await financialSnapshotModule.run(ctx({ history: { profit_loss: pl } }));
    expect(FinancialSnapshotPayloadSchema.parse(r.payload).series).toHaveLength(4);
  });
});

describe("cash quality module", () => {
  it("computes conversion, capex, FCF and D/E per year, with n/m notes", () => {
    const ys = cashYears(history);
    expect(ys).toHaveLength(5);
    const fy26 = ys.at(-1)!;
    expect(fy26).toMatchObject({ period: "FY26", cfo: 95, pat: 125, cashConversion: 0.76, capex: 70, fcf: 25, debtToEquity: 0.08 });
    expect(ys.find((y) => y.period === "FY25")!.note).toMatch(/D\/E n\/m/);
  });

  it("flags PAT <= 0 and derives capex from CFO - FCF when purchases are missing", () => {
    const ys = cashYears({
      profit_loss: { statement: "profit_loss", periods: ["Mar 2025", "Mar 2026"], rows: [{ label: "Net Profit", values: [-5, 10] }, { label: "Operating Profit", values: [1, 20] }] },
      cash_flow: { statement: "cash_flow", periods: ["Mar 2025", "Mar 2026"], rows: [{ label: "Cash from Operating Activity", values: [5, 15] }, { label: "Free Cash Flow", values: [1, 5] }] },
    });
    expect(ys[0]).toMatchObject({ cashConversion: null, capex: 4 });
    expect(ys[0]!.note).toMatch(/CFO\/PAT n\/m.*capex derived/);
    expect(ys[1]!.debtToEquity).toBeNull();
  });

  it("produces a schema-valid payload with takeaways on conversion, FCF and working capital", async () => {
    const r = await cashQualityModule.run(ctx());
    const p = CashQualityPayloadSchema.parse(r.payload);
    expect(p.periods).toHaveLength(5);
    expect(p.takeaways.map((t) => t.text)).toEqual([
      "Over FY22–FY26, cumulative cash from operations of ₹355 Cr was 0.73x cumulative net profit of ₹485 Cr, a weak conversion of profit into cash.",
      "Operating cash flow covered 32% of EBITDA over FY22–FY26; working capital or taxes absorb a large share of operating profit.",
      "Free cash flow totalled ₹45 Cr over FY22–FY26, negative in FY23.",
      "Working-capital days rose from 65 in FY22 to 85 in FY26.",
    ]);
  });

  it("is insufficient without cash-flow history or with a single year", async () => {
    expect((await cashQualityModule.run(ctx({ history: { profit_loss: pl } }))).status).toBe("insufficient_sources");
    const one = { ...cashFlow, periods: ["Mar 2026"], rows: cashFlow.rows.map((x) => ({ ...x, values: x.values.slice(-1) })) };
    expect((await cashQualityModule.run(ctx({ history: { profit_loss: pl, cash_flow: one } }))).status).toBe("insufficient_sources");
  });
});

describe("module registry and cache key", () => {
  const doc = (id: string, sha: string | null): ModuleDocument => ({ id, docType: "transcript", label: "x", periodLabel: "Q1 FY27", periodEnd: "2026-08-01", url: "u", sha256: sha, pages: 1 });

  it("registers every module in display-priority order, Promise Ledger first", () => {
    const reg = createDefaultModuleRegistry();
    expect(reg.list().map((r) => r.key)).toEqual(["promise_ledger", "financial_snapshot", "cash_quality", "bull_bear", "business_snapshot"]);
    expect([...MODULE_KEYS].sort()).toEqual(reg.list().map((r) => r.key).sort());
    expect(reg.list(["bull_bear", "cash_quality"]).map((r) => r.key)).toEqual(["bull_bear", "cash_quality"]);
    expect(new ModuleRegistry().list(["bull_bear"])).toEqual([]);
    expect(reg.get("cash_quality")).toBe(cashQualityModule);
  });

  it("keys on the document set by content hash, independent of order", () => {
    const runner = createDefaultModuleRegistry().get("bull_bear")!;
    const base = { symbol: "ZTAPURE", history, asOf: new Date("2026-11-15T06:00:00Z") };
    const k1 = moduleCacheKey(runner, { ...base, documents: [doc("a", "1"), doc("b", "2")] }, "glm");
    expect(moduleCacheKey(runner, { ...base, documents: [doc("b", "2"), doc("a", "1")] }, "glm")).toBe(k1);
    expect(moduleCacheKey(runner, { ...base, documents: [doc("a", "1"), doc("b", "3")] }, "glm")).not.toBe(k1);
    expect(moduleCacheKey(runner, { ...base, documents: [doc("a", "1"), doc("b", "2")] }, "glm-2")).not.toBe(k1);
    expect(moduleCacheKey(runner, { ...base, history: {}, documents: [doc("a", "1"), doc("b", "2")] }, "glm")).toBe(k1);
  });

  it("history-only modules ignore documents; date-dependent modules roll over at IST midnight", () => {
    const reg = createDefaultModuleRegistry();
    const cash = reg.get("cash_quality")!;
    const ledger = reg.get("promise_ledger")!;
    const before = { symbol: "S", history, documents: [doc("a", "1")], asOf: new Date("2026-11-14T18:29:00Z") };
    expect(moduleCacheKey(cash, { ...before, documents: [] }, "m")).toBe(moduleCacheKey(cash, before, "m"));
    const sameIstDay = { ...before, asOf: new Date("2026-11-14T06:00:00Z") };
    const nextIstDay = { ...before, asOf: new Date("2026-11-14T18:31:00Z") };
    expect(moduleCacheKey(ledger, sameIstDay, "m")).toBe(moduleCacheKey(ledger, before, "m"));
    expect(moduleCacheKey(ledger, nextIstDay, "m")).not.toBe(moduleCacheKey(ledger, before, "m"));
    expect(moduleCacheKey(cash, nextIstDay, "m")).toBe(moduleCacheKey(cash, before, "m"));
  });

  it("a custom runner can be registered and replaces one with the same key", () => {
    const fake: ResearchModuleRunner = { key: "bull_bear", version: "x", inputs: { documents: false, history: false }, run: async () => ({ status: "done", payload: {} }) };
    expect(createDefaultModuleRegistry().register(fake).get("bull_bear")).toBe(fake);
  });
});

describe("utilities", () => {
  it("mapWithConcurrency bounds in-flight work and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });

  it("backoff grows exponentially with jitter and is capped", () => {
    for (let a = 0; a < 6; a++) {
      const v = backoffMs(a, 100, 1_000);
      const exp = Math.min(1_000, 100 * 2 ** a);
      expect(v).toBeGreaterThanOrEqual(exp * 0.5);
      expect(v).toBeLessThanOrEqual(exp);
    }
  });

  it("hashes are stable across key order and skip undefined", () => {
    expect(stableStringify({ b: 1, a: [1, { d: undefined, c: null }] })).toBe('{"a":[1,{"c":null}],"b":1}');
    expect(hashParts({ a: 1, b: 2 })).toBe(hashParts({ b: 2, a: 1 }));
    expect(stableStringify(undefined)).toBe("null");
  });

  it("parseModelJson extracts arrays from prose and rethrows hopeless input", () => {
    expect(parseModelJson("Result: [1, 2] end")).toEqual([1, 2]);
    expect(() => parseModelJson("no json here")).toThrow(SyntaxError);
  });

  it("formatZodError handles non-zod errors", () => {
    expect(formatZodError(new Error("boom"))).toBe("boom");
    expect(formatZodError("plain")).toBe("plain");
  });
});
