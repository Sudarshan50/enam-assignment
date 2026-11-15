import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AlertRuleDefinition } from "@finn/shared";
import { PreviewResponseSchema } from "../src/contracts";
import { backtestPriceRule, describeBacktest } from "../src/services/alertBacktest";
import { type AlertRepository, type AlertRuleRow, type RuleParser, createAlertRuleService } from "../src/services/alertRuleService";
import type { PricePoint } from "../src/services/holdingsService";
import { auth, buildTestApp } from "./helpers";

/** Builds a daily series from closes; volumes default to 1M. */
function series(closes: number[], volumes?: number[]): PricePoint[] {
  return closes.map((close, i) => ({
    sessionDate: `2026-10-${String(i + 1).padStart(2, "0")}`,
    close,
    prevClose: i === 0 ? null : closes[i - 1]!,
    volume: volumes?.[i] ?? 1_000_000,
    avg20Volume: null,
  }));
}

const priceRule = (direction: "up" | "down" | "either", thresholdPct: number): AlertRuleDefinition => ({
  type: "price_move",
  scope: { kind: "portfolio" },
  direction,
  thresholdPct,
});

describe("backtestPriceRule", () => {
  // Moves: +6%, -5%, +1%, -7%
  const closes = [100, 106, 100.7, 101.7, 94.6];

  it("counts moves at or beyond the threshold in the chosen direction", () => {
    const s = new Map([["TCS", series(closes)]]);
    expect(backtestPriceRule(priceRule("either", 5) as never, s).fires).toBe(3);
    expect(backtestPriceRule(priceRule("down", 5) as never, s).fires).toBe(2);
    expect(backtestPriceRule(priceRule("up", 5) as never, s).fires).toBe(1);
    const result = backtestPriceRule(priceRule("down", 5) as never, s);
    expect(result.bySymbol).toEqual([{ symbol: "TCS", fires: 2, lastFiredOn: "2026-10-05" }]);
    expect(result.sessions).toBe(5);
  });

  it("suppresses price moves on bonus/split days", () => {
    const s = new Map([["TCS", series(closes)]]);
    const suppressed = new Map([["TCS", new Set(["2026-10-05"])]]);
    expect(backtestPriceRule(priceRule("down", 5) as never, s, suppressed).fires).toBe(1);
  });

  it("only evaluates volume spikes once 20 prior sessions exist", () => {
    const volumes = Array.from({ length: 25 }, (_, i) => (i === 5 || i === 22 ? 3_000_000 : 1_000_000));
    const s = new Map([["DIXON", series(Array(25).fill(100), volumes)]]);
    const result = backtestPriceRule({ type: "volume_spike", scope: { kind: "portfolio" }, multiple: 2.5 }, s);
    expect(result.fires).toBe(1);
    expect(result.bySymbol[0]!.lastFiredOn).toBe("2026-10-23");
  });

  it("describes the replay in plain English", () => {
    expect(describeBacktest({ sessions: 30, fires: 0, bySymbol: [], note: null })).toBe("It would not have fired in the last 30 sessions.");
    expect(
      describeBacktest({ sessions: 30, fires: 3, bySymbol: [{ symbol: "TRENT", fires: 2, lastFiredOn: null }, { symbol: "ITC", fires: 1, lastFiredOn: null }], note: null }),
    ).toBe("It would have fired 3 times in the last 30 sessions (TRENT ×2, ITC).");
    expect(describeBacktest({ sessions: 0, fires: 0, bySymbol: [], note: "No price history yet, so there is nothing to replay." })).toContain("No price history");
  });
});

function fakeAlertRepo(): AlertRepository & { rules: AlertRuleRow[] } {
  const rules: AlertRuleRow[] = [
    {
      id: randomUUID(),
      name: "Material filings",
      enabled: true,
      definition: { type: "category", scope: { kind: "portfolio" }, categories: ["results"] },
      createdAt: new Date(),
    },
    {
      id: randomUUID(),
      name: "Big move",
      enabled: true,
      definition: { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 5 },
      createdAt: new Date(),
    },
  ];
  return {
    rules,
    listRules: async () => rules,
    getRule: async (id) => rules.find((r) => r.id === id) ?? null,
    insertRule: async (name, definition) => {
      const r = { id: randomUUID(), name, enabled: true, definition, createdAt: new Date() };
      rules.push(r);
      return r;
    },
    updateRule: async (id, patch) => {
      const r = rules.find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return r;
    },
    deleteRule: async (id) => {
      const index = rules.findIndex((r) => r.id === id);
      if (index < 0) return false;
      rules.splice(index, 1);
      return true;
    },
    listAlerts: async () => [],
    markAlertRead: async () => true,
    listHoldings: async () => [
      { symbol: "TRENT", statementFamily: "industrial" },
      { symbol: "HDFCBANK", statementFamily: "banking" },
      { symbol: "ITC", statementFamily: "industrial" },
    ],
    existingSymbols: async (symbols) => symbols.filter((s) => ["TRENT", "HDFCBANK", "ITC"].includes(s)),
    allSymbols: async () => ["TRENT", "HDFCBANK", "ITC"],
    priceSeries: async (symbols) =>
      new Map(
        symbols.map((s) => [s, series(s === "TRENT" ? [100, 94, 95, 89] : s === "ITC" ? [100, 105.5, 106, 106] : [100, 101, 100, 101])]),
      ),
    bonusSplitDates: async () => new Map(),
    categoryFilings: async (symbols) => symbols.map((symbol) => ({ symbol, count: symbol === "ITC" ? 2 : 0, last: "2026-11-10" })),
  };
}

/** Stand-in for @finn/domain's deterministic parser. */
const parser: RuleParser = {
  parse: vi.fn((text: string, ctx: { isKnownSymbol: (s: string) => boolean }): AlertRuleDefinition | null => {
    if (/results/i.test(text)) return { type: "category", scope: { kind: "portfolio" }, categories: ["results"] };
    const pct = /(\d+(?:\.\d+)?)%/.exec(text);
    if (!pct) return null;
    const symbols = (text.match(/\b[A-Z]{2,}\b/g) ?? []).filter((s) => ctx.isKnownSymbol(s));
    return {
      type: "price_move",
      scope: symbols.length ? { kind: "symbols", symbols } : { kind: "portfolio" },
      direction: /fall|drop/i.test(text) ? "down" : "either",
      thresholdPct: Number(pct[1]),
    };
  }),
  explain: (d) => `Alert on ${d.type}.`,
};

function appWith(repo = fakeAlertRepo()) {
  const rules = createAlertRuleService({ repo, parser });
  return { app: buildTestApp({ alertRules: rules }), repo };
}

describe("POST /api/v1/alert-rules/preview", () => {
  it("parses, resolves the portfolio and replays the last 30 sessions", async () => {
    const { app } = appWith();
    const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: "tell me when any holding falls 5%" });
    expect(res.status).toBe(200);
    const body = PreviewResponseSchema.parse(res.body);
    expect(body.definition).toMatchObject({ type: "price_move", direction: "down", thresholdPct: 5 });
    expect(body.resolvedSymbols).toEqual(["TRENT", "HDFCBANK", "ITC"]);
    expect(body.backtest).toMatchObject({ fires: 2, bySymbol: [{ symbol: "TRENT", fires: 2 }] });
    expect(body.explanation).toBe("Alert on price_move. It would have fired 2 times in the last 4 sessions (TRENT ×2).");
  });

  it("only resolves symbols that exist", async () => {
    const { app } = appWith();
    const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: "ITC moves 5%" });
    expect(res.body.resolvedSymbols).toEqual(["ITC"]);
    expect(res.body.backtest.fires).toBe(1);
  });

  it("counts matching filings for category rules", async () => {
    const { app } = appWith();
    const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: "new results" });
    expect(res.body.definition.type).toBe("category");
    expect(res.body.explanation).toContain("2 matching filings in the last 30 sessions");
  });

  it("explains how to phrase a rule when the text cannot be parsed", async () => {
    const { app } = appWith();
    const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: "something vague" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ definition: null, resolvedSymbols: [], backtest: null });
    expect(res.body.explanation).toMatch(/couldn't turn that into a rule/i);
  });
});

describe("alert rule CRUD", () => {
  it("creates, lists, toggles, retunes and deletes rules", async () => {
    const { app, repo } = appWith();
    const created = await request(app)
      .post("/api/v1/alert-rules")
      .set(auth)
      .send({ name: "TRENT drop", definition: { type: "price_move", scope: { kind: "symbols", symbols: ["TRENT"] }, direction: "down", thresholdPct: 4 } });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect((await request(app).get("/api/v1/alert-rules").set(auth)).body).toHaveLength(3);

    const toggled = await request(app).patch(`/api/v1/alert-rules/${id}`).set(auth).send({ enabled: false });
    expect(toggled.body.enabled).toBe(false);

    const retuned = await request(app).patch(`/api/v1/alert-rules/${id}`).set(auth).send({ threshold: 6 });
    expect(retuned.body.definition.thresholdPct).toBe(6);

    const outOfRange = await request(app).patch(`/api/v1/alert-rules/${id}`).set(auth).send({ threshold: 25 });
    expect(outOfRange.status).toBe(400);

    const categoryId = repo.rules[0]!.id;
    const noThreshold = await request(app).patch(`/api/v1/alert-rules/${categoryId}`).set(auth).send({ threshold: 3 });
    expect(noThreshold.status).toBe(400);
    expect(noThreshold.body.error.message).toContain("no threshold");

    expect((await request(app).delete(`/api/v1/alert-rules/${id}`).set(auth)).status).toBe(204);
    expect((await request(app).delete(`/api/v1/alert-rules/${id}`).set(auth)).status).toBe(404);
  });
});
