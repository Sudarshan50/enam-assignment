import { describe, expect, it } from "vitest";
import { AlertRuleDefinitionSchema } from "@finn/shared/contracts/alerts";
import { explain, parseRuleText, previewRuleText } from "../src/alerts/parseRuleText";

const known = new Set(["TRENT", "DIXON", "TCS", "HDFCBANK", "ICICIBANK", "TITAN"]);
const ctx = { isKnownSymbol: (s: string) => known.has(s) };

describe("parseRuleText", () => {
  it("price drop on a symbol", () => {
    expect(parseRuleText("alert me if TRENT falls more than 4%", ctx)).toEqual({
      type: "price_move",
      scope: { kind: "symbols", symbols: ["TRENT"] },
      direction: "down",
      thresholdPct: 4,
    });
  });

  it("any bank moves", () => {
    expect(parseRuleText("any bank moves 3%", ctx)).toEqual({
      type: "price_move",
      scope: { kind: "statement_family", family: "banking" },
      direction: "either",
      thresholdPct: 3,
    });
  });

  it("volume multiple on a symbol", () => {
    expect(parseRuleText("volume 3x on DIXON", ctx)).toEqual({ type: "volume_spike", scope: { kind: "symbols", symbols: ["DIXON"] }, multiple: 3 });
  });

  it("category rule over the portfolio", () => {
    expect(parseRuleText("tell me about credit rating changes", ctx)).toEqual({ type: "category", scope: { kind: "portfolio" }, categories: ["credit_rating"] });
  });

  it("lower-case tickers resolve through the master list", () => {
    expect(parseRuleText("ping me when titan jumps 5 percent", ctx)).toEqual({
      type: "price_move",
      scope: { kind: "symbols", symbols: ["TITAN"] },
      direction: "up",
      thresholdPct: 5,
    });
  });

  it("works without a resolver using ALL-CAPS tokens", () => {
    expect(parseRuleText("alert me if TRENT falls more than 4%")?.scope).toEqual({ kind: "symbols", symbols: ["TRENT"] });
  });

  it("clamps out-of-range numbers to the schema bounds", () => {
    expect(parseRuleText("TCS moves 50%", ctx)).toMatchObject({ thresholdPct: 20 });
    expect(parseRuleText("volume 1.1x on TCS", ctx)).toMatchObject({ multiple: 1.5 });
  });

  it("returns null for unsupported text", () => {
    expect(parseRuleText("hello there", ctx)).toBeNull();
    expect(parseRuleText("", ctx)).toBeNull();
  });

  it("always returns schema-valid definitions", () => {
    for (const t of ["results for my portfolio", "pledge or insider activity in HDFCBANK", "any bank volume spike", "DIXON up 2%"]) {
      const d = parseRuleText(t, ctx);
      expect(d).not.toBeNull();
      expect(AlertRuleDefinitionSchema.safeParse(d).success).toBe(true);
    }
  });
});

describe("explain / previewRuleText", () => {
  it("explains each rule type in plain English", () => {
    expect(explain(parseRuleText("alert me if TRENT falls more than 4%", ctx)!)).toMatch(/TRENT falls 4% or more/);
    expect(explain(parseRuleText("any bank moves 3%", ctx)!)).toMatch(/any bank you track moves 3% or more either way/);
    expect(explain(parseRuleText("volume 3x on DIXON", ctx)!)).toMatch(/DIXON trades at least 3× its average volume/);
    expect(explain(parseRuleText("tell me about credit rating changes", ctx)!)).toMatch(/Credit rating filings from any company in your portfolio/);
  });

  it("previews with resolved symbols", () => {
    const p = previewRuleText("any bank moves 3%", { ...ctx, symbolsInFamily: () => ["HDFCBANK", "ICICIBANK"] });
    expect(p.resolvedSymbols).toEqual(["HDFCBANK", "ICICIBANK"]);
    expect(previewRuleText("credit rating changes", { ...ctx, holdings: ["TCS"] }).resolvedSymbols).toEqual(["TCS"]);
    expect(previewRuleText("gibberish", ctx).definition).toBeNull();
  });
});
