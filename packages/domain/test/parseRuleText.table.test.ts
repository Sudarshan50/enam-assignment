import { describe, expect, it } from "vitest";
import { AlertRuleDefinitionSchema, PreviewAlertRuleResponseSchema, type AlertRuleDefinition } from "@finn/shared/contracts/alerts";
import { explain, parseRuleText, previewRuleText } from "../src/alerts/parseRuleText";

const KNOWN = new Set(["ZTDALPHA", "ZTDBETA", "TCS", "IDEA", "SUN", "BEL", "HAL", "TITAN"]);
const ctx = { isKnownSymbol: (s: string) => KNOWN.has(s) };

describe("parseRuleText: table-driven", () => {
  const cases: [string, AlertRuleDefinition | null][] = [
    ["alert me if ZTDALPHA falls more than 4%", { type: "price_move", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, direction: "down", thresholdPct: 4 }],
    ["ZTDALPHA drops 5 per cent", { type: "price_move", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, direction: "down", thresholdPct: 5 }],
    ["tell me when ZTDBETA rallies 2.5 percent", { type: "price_move", scope: { kind: "symbols", symbols: ["ZTDBETA"] }, direction: "up", thresholdPct: 2.5 }],
    ["ZTDALPHA rises or falls 3%", { type: "price_move", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, direction: "either", thresholdPct: 3 }],
    ["ZTDALPHA or ZTDBETA moves 6 pc", { type: "price_move", scope: { kind: "symbols", symbols: ["ZTDALPHA", "ZTDBETA"] }, direction: "either", thresholdPct: 6 }],
    ["any stock in my portfolio moves 3%", { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 3 }],
    ["5%", { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 5 }],
    ["ZTDALPHA moves 0.1%", { type: "price_move", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, direction: "either", thresholdPct: 0.5 }],
    ["ZTDALPHA moves 25%", { type: "price_move", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, direction: "either", thresholdPct: 20 }],
    ["any nbfc falls 2%", { type: "price_move", scope: { kind: "statement_family", family: "nbfc" }, direction: "down", thresholdPct: 2 }],
    ["non-banking finance companies up 2%", { type: "price_move", scope: { kind: "statement_family", family: "nbfc" }, direction: "up", thresholdPct: 2 }],
    ["my banks fall 2%", { type: "price_move", scope: { kind: "statement_family", family: "banking" }, direction: "down", thresholdPct: 2 }],
    ["volume spike on ZTDALPHA", { type: "volume_spike", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, multiple: 2 }],
    ["3x on ZTDBETA", { type: "volume_spike", scope: { kind: "symbols", symbols: ["ZTDBETA"] }, multiple: 3 }],
    ["ZTDBETA trades 4 times average", { type: "volume_spike", scope: { kind: "symbols", symbols: ["ZTDBETA"] }, multiple: 4 }],
    ["volume 15× on ZTDALPHA", { type: "volume_spike", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, multiple: 10 }],
    ["any bank volume 1.2x", { type: "volume_spike", scope: { kind: "statement_family", family: "banking" }, multiple: 1.5 }],
    ["vol jump 5% on ZTDALPHA", { type: "volume_spike", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, multiple: 2 }],
    ["dividends or bonus in ZTDALPHA", { type: "category", scope: { kind: "symbols", symbols: ["ZTDALPHA"] }, categories: ["dividend", "bonus_split"] }],
    ["notify me of rating downgrades", { type: "category", scope: { kind: "portfolio" }, categories: ["credit_rating"] }],
    ["concall transcripts", { type: "category", scope: { kind: "portfolio" }, categories: ["earnings_call"] }],
    ["promoter selling or pledge", { type: "category", scope: { kind: "portfolio" }, categories: ["pledging", "insider_trading"] }],
    ["3× volume on ZTDBETA", { type: "volume_spike", scope: { kind: "symbols", symbols: ["ZTDBETA"] }, multiple: 3 }],
    ["2.5 × average on ZTDBETA", { type: "volume_spike", scope: { kind: "symbols", symbols: ["ZTDBETA"] }, multiple: 2.5 }],
    ["CEO resigns at any bank", { type: "category", scope: { kind: "statement_family", family: "banking" }, categories: ["management_change"] }],
    ["takeover or demerger news", { type: "category", scope: { kind: "portfolio" }, categories: ["m_and_a"] }],
    ["QIP or rights issue", { type: "category", scope: { kind: "portfolio" }, categories: ["fund_raise"] }],
    ["SEBI order or court case", { type: "category", scope: { kind: "portfolio" }, categories: ["litigation"] }],
    ["new plant capex", { type: "category", scope: { kind: "portfolio" }, categories: ["capex"] }],
    ["postal ballot notices", { type: "category", scope: { kind: "portfolio" }, categories: ["postal_ballot"] }],
    ["AGM dates", { type: "category", scope: { kind: "portfolio" }, categories: ["agm_egm"] }],
    ["press release", { type: "category", scope: { kind: "portfolio" }, categories: ["press_release"] }],
    ["analyst meet", { type: "category", scope: { kind: "portfolio" }, categories: ["investor_meetings"] }],
    ["", null],
    ["    ", null],
    ["hello there", null],
    ["!!! ??? ...", null],
    ["asdf qwerty zxcv", null],
    ["12345", null],
    ["x x x", null],
    ["🚀🚀🚀", null],
    ["what is the weather in Mumbai", null],
  ];

  it.each(cases)("%j", (text, expected) => {
    const parsed = parseRuleText(text, ctx);
    expect(parsed).toEqual(expected);
    if (parsed) expect(AlertRuleDefinitionSchema.safeParse(parsed).success).toBe(true);
  });

  it("very long garbage input is null rather than an error", () => {
    expect(parseRuleText("lorem ipsum ".repeat(500), ctx)).toBeNull();
  });
});

describe("ticker vs English-word ambiguity", () => {
  it("without a resolver every non-stop ALL-CAPS token counts, so shouting picks up words", () => {
    expect(parseRuleText("PLEASE ALERT ME IF TCS FALLS 5%")?.scope).toEqual({ kind: "symbols", symbols: ["PLEASE", "TCS"] });
  });

  it("with a resolver only known tickers survive", () => {
    expect(parseRuleText("PLEASE ALERT ME IF TCS FALLS 5%", ctx)?.scope).toEqual({ kind: "symbols", symbols: ["TCS"] });
  });

  it("an ALL-CAPS known ticker wins over lower-case words that are also tickers", () => {
    // "idea" and "sun" are tickers but here they are English words.
    expect(parseRuleText("no idea why the sun matters, alert if TCS falls 5%", ctx)?.scope).toEqual({ kind: "symbols", symbols: ["TCS"] });
  });

  it("lower-case known tickers are used only when no ALL-CAPS ticker is present", () => {
    expect(parseRuleText("ping me when titan jumps 5 percent", ctx)?.scope).toEqual({ kind: "symbols", symbols: ["TITAN"] });
    expect(parseRuleText("alert if idea falls 5%", ctx)?.scope).toEqual({ kind: "symbols", symbols: ["IDEA"] });
  });

  it("short lower-case words are never treated as tickers even when known", () => {
    const tiny = { isKnownSymbol: (s: string) => s === "UP" || s === "BY" || s === "GO" };
    expect(parseRuleText("go up by 5%", tiny)?.scope).toEqual({ kind: "portfolio" });
  });

  it("stop words and rule words are never tickers", () => {
    expect(parseRuleText("ALERT WHEN ANY STOCK MOVES 5% TODAY")?.scope).toEqual({ kind: "portfolio" });
    expect(parseRuleText("NSE EOD PRICE CHANGE 5%")?.scope).toEqual({ kind: "portfolio" });
  });

  it("an unknown ALL-CAPS token with a resolver falls back to portfolio", () => {
    expect(parseRuleText("ZZUNKNOWN falls 5%", ctx)?.scope).toEqual({ kind: "portfolio" });
  });

  it("family words beat tickers", () => {
    expect(parseRuleText("TCS and any bank move 3%", ctx)?.scope).toEqual({ kind: "statement_family", family: "banking" });
  });

  it("de-duplicates repeated tickers and caps the list at 50", () => {
    expect(parseRuleText("TCS tcs TCS falls 5%", ctx)?.scope).toEqual({ kind: "symbols", symbols: ["TCS"] });
    const many = Array.from({ length: 60 }, (_, i) => `ZQ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
    const scope = parseRuleText(`${many.join(" ")} moves 5%`)?.scope;
    expect(scope?.kind).toBe("symbols");
    expect(scope && scope.kind === "symbols" ? scope.symbols.length : 0).toBe(50);
  });
});

describe("previewRuleText and explain", () => {
  it("returns a schema-valid preview for each scope kind", () => {
    const pctx = { ...ctx, holdings: ["ZTDALPHA", "ZTDBETA"], symbolsInFamily: (f: string) => (f === "banking" ? ["ZTDBANK"] : []) };
    for (const text of ["ZTDALPHA falls 4%", "portfolio volume 3x", "any bank results", "any nbfc moves 2%", "nonsense words only"]) {
      expect(PreviewAlertRuleResponseSchema.safeParse(previewRuleText(text, pctx)).success).toBe(true);
    }
    expect(previewRuleText("portfolio volume 3x", pctx).resolvedSymbols).toEqual(["ZTDALPHA", "ZTDBETA"]);
    expect(previewRuleText("any bank results", pctx).resolvedSymbols).toEqual(["ZTDBANK"]);
    expect(previewRuleText("any nbfc moves 2%", pctx).resolvedSymbols).toEqual([]);
    expect(previewRuleText("ZTDALPHA falls 4%", pctx).resolvedSymbols).toEqual(["ZTDALPHA"]);
  });

  it("resolves to nothing when the context has no holdings or family lookup", () => {
    expect(previewRuleText("portfolio volume 3x").resolvedSymbols).toEqual([]);
    expect(previewRuleText("any bank moves 3%").resolvedSymbols).toEqual([]);
  });

  it("explains failures with examples and never resolves symbols", () => {
    const p = previewRuleText("blah");
    expect(p.definition).toBeNull();
    expect(p.resolvedSymbols).toEqual([]);
    expect(p.explanation).toMatch(/Couldn't read that/);
  });

  it("explains each direction and scope wording", () => {
    const scopeOf = (scope: AlertRuleDefinition["scope"]) => explain({ type: "price_move", scope, direction: "up", thresholdPct: 2 });
    expect(scopeOf({ kind: "portfolio" })).toBe("Alert when any stock in your portfolio rises 2% or more in a session, measured close vs previous close (checked after market close).");
    expect(scopeOf({ kind: "symbols", symbols: ["A", "B", "C"] })).toMatch(/^Alert when A, B or C rises 2%/);
    expect(scopeOf({ kind: "statement_family", family: "nbfc" })).toMatch(/any NBFC you track/);
    expect(scopeOf({ kind: "statement_family", family: "industrial" })).toMatch(/any industrial stock you track/);
    expect(explain({ type: "price_move", scope: { kind: "portfolio" }, direction: "down", thresholdPct: 3 })).toMatch(/falls 3% or more/);
    expect(explain({ type: "category", scope: { kind: "statement_family", family: "industrial" }, categories: ["results", "dividend", "capex"] })).toBe(
      "Alert on new Results, Dividend or Capex filings from any industrial company you track.",
    );
    expect(explain({ type: "volume_spike", scope: { kind: "symbols", symbols: ["A", "B"] }, multiple: 2.5 })).toBe(
      "Alert when A or B trades at least 2.5× its average volume of the previous 20 sessions.",
    );
  });
});
