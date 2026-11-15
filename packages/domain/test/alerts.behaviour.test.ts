import { describe, expect, it } from "vitest";
import type { AlertRuleDefinition } from "@finn/shared/contracts/alerts";
import { CATEGORIES, type Category } from "@finn/shared/taxonomy";
import {
  changePct,
  corporateActionSuppression,
  createScopeResolver,
  evaluateCategoryRule,
  evaluatePriceRules,
  extractRecordDate,
  type AnnouncementForAlert,
  type CorporateActionForAlert,
  type PriceSnapshot,
  type RuleLike,
} from "../src/alerts/evaluate";

const FAMILIES: Record<string, "industrial" | "banking" | "nbfc"> = { ZTDALPHA: "industrial", ZTDBANK: "banking", ZTDFIN: "nbfc", ZTDOUT: "industrial" };
const inScope = createScopeResolver({ holdings: ["ztdalpha", "ZTDBANK"], familyOf: (s) => FAMILIES[s] });

const rule = (definition: AlertRuleDefinition, id = "r1", enabled?: boolean): RuleLike => ({ id, definition, enabled });
const priceRule = (direction: "up" | "down" | "either", thresholdPct: number, scope: AlertRuleDefinition["scope"] = { kind: "portfolio" }) =>
  rule({ type: "price_move", scope, direction, thresholdPct }, `${direction}${thresholdPct}`);
const snap = (close: number, prevClose: number | null, extra: Partial<PriceSnapshot> = {}): PriceSnapshot => ({
  symbol: "ZTDALPHA",
  sessionDate: "2026-11-13",
  close,
  prevClose,
  volume: 1000,
  avg20Volume: 1000,
  ...extra,
});
const fires = (r: RuleLike, s: PriceSnapshot) => evaluatePriceRules([r], [s], inScope).length === 1;

describe("price_move at the threshold", () => {
  it.each([
    // [close, prevClose] pairs whose exact move is 5.00%; several compute as 4.999999… in floating point.
    [105, 100],
    [2.85, 3],
    [66.5, 70],
    [3.15, 3],
    [1050, 1000],
    [95, 100],
    [190, 200],
  ])("an exact 5%% move %s vs %s fires a 5%% rule in its direction and either", (close, prevClose) => {
    const s = snap(close, prevClose);
    const up = close > prevClose;
    expect(fires(priceRule(up ? "up" : "down", 5), s)).toBe(true);
    expect(fires(priceRule("either", 5), s)).toBe(true);
    expect(fires(priceRule(up ? "down" : "up", 5), s)).toBe(false);
  });

  it("does not fire just below the threshold", () => {
    expect(fires(priceRule("up", 5), snap(104.99, 100))).toBe(false);
    expect(fires(priceRule("down", 5), snap(95.01, 100))).toBe(false);
    expect(fires(priceRule("either", 5), snap(104.99, 100))).toBe(false);
  });

  it("fires above the threshold, with the change recorded in the payload", () => {
    const [d] = evaluatePriceRules([priceRule("down", 4)], [snap(90, 100)], inScope);
    expect(d).toMatchObject({ kind: "price_move", symbol: "ZTDALPHA", eventKey: "2026-11-13", sessionDate: "2026-11-13", announcementSeqId: null });
    expect(d!.payload).toEqual({ changePct: -10, close: 90, prevClose: 100, thresholdPct: 4, direction: "down" });
    expect(d!.title).toBe("ZTDALPHA -10.0% today");
    expect(d!.body).toContain("rule: down 4%");
  });

  it("flat sessions and missing/zero previous close never fire", () => {
    expect(fires(priceRule("either", 0.5), snap(100, 100))).toBe(false);
    expect(fires(priceRule("either", 0.5), snap(100, null))).toBe(false);
    expect(fires(priceRule("either", 0.5), snap(100, 0))).toBe(false);
    expect(changePct({ close: 100, prevClose: -5 })).toBeNull();
    expect(changePct({ close: 110, prevClose: 100 })).toBeCloseTo(10, 10);
  });
});

describe("volume_spike", () => {
  const vol = (multiple: number) => rule({ type: "volume_spike", scope: { kind: "portfolio" }, multiple }, `vol${multiple}`);

  it("fires at exactly the multiple and above, not below", () => {
    expect(fires(vol(3), snap(100, 100, { volume: 3000, avg20Volume: 1000 }))).toBe(true);
    expect(fires(vol(3), snap(100, 100, { volume: 3001, avg20Volume: 1000 }))).toBe(true);
    expect(fires(vol(3), snap(100, 100, { volume: 2999, avg20Volume: 1000 }))).toBe(false);
    expect(fires(vol(1.5), snap(100, 100, { volume: 1500, avg20Volume: 1000 }))).toBe(true);
  });

  it("never fires without 20 sessions of history (avg20 missing), a zero average, or a missing volume", () => {
    expect(fires(vol(1.5), snap(100, 100, { volume: 1_000_000, avg20Volume: null }))).toBe(false);
    expect(fires(vol(1.5), snap(100, 100, { volume: 1_000_000, avg20Volume: 0 }))).toBe(false);
    expect(fires(vol(1.5), snap(100, 100, { volume: null, avg20Volume: 1000 }))).toBe(false);
  });

  it("is independent of price direction and reports the ratio", () => {
    const [d] = evaluatePriceRules([vol(2)], [snap(80, 100, { volume: 2500, avg20Volume: 1000 })], inScope);
    expect(d).toMatchObject({ kind: "volume_spike", eventKey: "2026-11-13" });
    expect(d!.payload).toEqual({ volume: 2500, avg20Volume: 1000, ratio: 2.5, multiple: 2 });
    expect(d!.title).toBe("ZTDALPHA volume 2.5× average");
  });
});

describe("scopes", () => {
  const snaps = ["ZTDALPHA", "ZTDBANK", "ZTDFIN", "ZTDOUT", "ZTDNOFAMILY"].map((symbol) => snap(110, 100, { symbol }));
  const firedFor = (scope: AlertRuleDefinition["scope"]) =>
    evaluatePriceRules([priceRule("up", 5, scope)], snaps, inScope)
      .map((d) => d.symbol)
      .sort();

  it("portfolio = holdings (case-insensitive)", () => {
    expect(firedFor({ kind: "portfolio" })).toEqual(["ZTDALPHA", "ZTDBANK"]);
  });

  it("symbols = explicit list (case-insensitive)", () => {
    expect(firedFor({ kind: "symbols", symbols: ["ztdout", "ZTDFIN"] })).toEqual(["ZTDFIN", "ZTDOUT"]);
  });

  it("statement_family resolves through the family lookup; unknown families never match", () => {
    expect(firedFor({ kind: "statement_family", family: "banking" })).toEqual(["ZTDBANK"]);
    expect(firedFor({ kind: "statement_family", family: "nbfc" })).toEqual(["ZTDFIN"]);
    expect(firedFor({ kind: "statement_family", family: "industrial" })).toEqual(["ZTDALPHA", "ZTDOUT"]);
  });

  it("an empty portfolio matches nothing", () => {
    const none = createScopeResolver({ holdings: [], familyOf: () => null });
    expect(evaluatePriceRules([priceRule("up", 1)], snaps, none)).toEqual([]);
  });
});

describe("idempotency and rule hygiene", () => {
  const rules = [
    priceRule("either", 2),
    rule({ type: "volume_spike", scope: { kind: "portfolio" }, multiple: 2 }, "vol"),
    rule({ type: "category", scope: { kind: "portfolio" }, categories: ["results"] }, "cat"),
    rule({ type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 0.5 }, "off", false),
  ];
  const snaps = [snap(110, 100, { volume: 5000 }), snap(90, 100, { symbol: "ZTDBANK", volume: 5000 })];

  it("same inputs produce identical drafts with unique (rule, symbol, kind, eventKey)", () => {
    const a = evaluatePriceRules(rules, snaps, inScope);
    expect(a).toEqual(evaluatePriceRules(rules, snaps, inScope));
    expect(a).toHaveLength(4);
    expect(new Set(a.map((d) => `${d.ruleId}|${d.symbol}|${d.kind}|${d.eventKey}`)).size).toBe(4);
    expect(a.every((d) => d.ruleId !== "off" && d.ruleId !== "cat")).toBe(true);
  });

  it("event key is the session date, so the next session is a new event", () => {
    const next = evaluatePriceRules(rules, snaps.map((s) => ({ ...s, sessionDate: "2026-11-16" })), inScope);
    expect(next.every((d) => d.eventKey === "2026-11-16")).toBe(true);
  });

  it("suppressed symbols (bonus/split) produce no price or volume drafts", () => {
    const drafts = evaluatePriceRules(rules, snaps, inScope, { suppressedSymbols: new Set(["ZTDALPHA"]) });
    expect(drafts.map((d) => d.symbol)).toEqual(["ZTDBANK", "ZTDBANK"]);
  });
});

describe("bonus/split suppression window", () => {
  const action = (publishedAt: string, extra: Partial<CorporateActionForAlert> = {}): CorporateActionForAlert => ({
    symbol: "ZTDALPHA",
    publishedAt: new Date(`${publishedAt}T15:30:00+05:30`),
    recordDate: null,
    text: "Board approved a bonus issue of 1:1",
    ...extra,
  });
  const suppressed = (actions: CorporateActionForAlert[], session: string) => corporateActionSuppression(actions, session).has("ZTDALPHA");

  it("reads the record/ex-date from exchange text in the formats NSE filings use", () => {
    expect(extractRecordDate("Steelcast Limited has informed the Exchange that Record date for the purpose of Dividend  is 20-Nov-2026.")).toBe("2026-11-20");
    expect(extractRecordDate("The company has fixed 20.11.2026 as the record date for the second interim dividend.")).toBe("2026-11-20");
    expect(extractRecordDate("The record date for this bonus issue is November 20, 2026. Allotment on November 23, 2026.")).toBe("2026-11-20");
    expect(extractRecordDate("Ex-date: 4th December 2026")).toBe("2026-12-04");
    expect(extractRecordDate("Record Date 2026-12-04 for sub-division")).toBe("2026-12-04");
    expect(extractRecordDate("Board meeting held on 13/11/2026 approved a bonus issue; record date to be intimated later.")).toBeNull();
    expect(extractRecordDate("Record date is 31-02-2026")).toBeNull();
    expect(extractRecordDate("Bonus issue in the ratio 1:1")).toBeNull();
  });

  it("suppresses sessions in the week after the filing, as before", () => {
    const a = [action("2026-11-10")];
    expect(suppressed(a, "2026-11-09")).toBe(false);
    expect(suppressed(a, "2026-11-10")).toBe(true);
    expect(suppressed(a, "2026-11-17")).toBe(true);
    expect(suppressed(a, "2026-11-18")).toBe(false);
  });

  it("suppresses the ex-date move of a bonus filed weeks earlier (record date from the card)", () => {
    const a = [action("2026-10-20", { recordDate: "2026-12-04" })];
    expect(suppressed(a, "2026-11-30")).toBe(false);
    expect(suppressed(a, "2026-12-01")).toBe(true);
    expect(suppressed(a, "2026-12-04")).toBe(true);
    expect(suppressed(a, "2026-12-07")).toBe(true);
    expect(suppressed(a, "2026-12-08")).toBe(false);
  });

  it("falls back to a record date stated in the text, and the card wins over the text", () => {
    expect(suppressed([action("2026-10-20", { text: "Record date for the bonus issue is 04-Dec-2026" })], "2026-12-04")).toBe(true);
    const both = [action("2026-10-20", { recordDate: "2026-12-18", text: "Record date for the bonus issue is 04-Dec-2026" })];
    expect(suppressed(both, "2026-12-04")).toBe(false);
    expect(suppressed(both, "2026-12-18")).toBe(true);
  });

  it("only suppresses the symbol that has the action", () => {
    expect([...corporateActionSuppression([action("2026-11-10"), action("2026-10-01", { symbol: "ZTDBANK", recordDate: "2026-11-12" })], "2026-11-12")].sort()).toEqual([
      "ZTDALPHA",
      "ZTDBANK",
    ]);
    expect([...corporateActionSuppression([action("2026-11-10")], "2026-11-12")]).toEqual(["ZTDALPHA"]);
  });
});

describe("category rules", () => {
  const base: AnnouncementForAlert = {
    seqId: "ztd-1",
    symbol: "ZTDALPHA",
    category: "management_change",
    headline: "Resignation of CFO",
    publishedAt: new Date("2026-11-13T10:00:00Z"),
  };
  const catRule = (categories: Category[], scope: AlertRuleDefinition["scope"] = { kind: "portfolio" }, enabled?: boolean) =>
    rule({ type: "category", scope, categories }, "cat", enabled);

  it("fires for every category it lists and none it doesn't", () => {
    for (const category of CATEGORIES) {
      const d = evaluateCategoryRule(catRule([category]), { ...base, category }, inScope);
      expect(d?.kind).toBe("category");
      const other = CATEGORIES.find((c) => c !== category)!;
      expect(evaluateCategoryRule(catRule([other]), { ...base, category }, inScope)).toBeNull();
    }
  });

  it("uses the one-liner when present, truncated to 240 chars", () => {
    expect(evaluateCategoryRule(catRule(["management_change"]), { ...base, oneLiner: "CFO quits" }, inScope)?.body).toBe("CFO quits");
    expect(evaluateCategoryRule(catRule(["management_change"]), { ...base, headline: "x".repeat(500) }, inScope)?.body).toHaveLength(240);
  });

  it("dedupes duplicate filings through the cluster key and keeps the payload traceable", () => {
    const a = evaluateCategoryRule(catRule(["management_change"]), { ...base, clusterKey: "ZTDALPHA:management_change:2026-11-13" }, inScope)!;
    const b = evaluateCategoryRule(catRule(["management_change"]), { ...base, seqId: "ztd-2", clusterKey: "ZTDALPHA:management_change:2026-11-13" }, inScope)!;
    expect(a.eventKey).toBe(b.eventKey);
    expect(a.title).toBe("ZTDALPHA: Management change");
    expect(a.payload).toEqual({ category: "management_change", seqId: "ztd-1", publishedAt: "2026-11-13T10:00:00.000Z" });
    expect(evaluateCategoryRule(catRule(["management_change"]), { ...base, clusterKey: null }, inScope)?.eventKey).toBe("ztd-1");
  });

  it("respects scope and the enabled flag", () => {
    expect(evaluateCategoryRule(catRule(["management_change"]), { ...base, symbol: "ZTDOUT" }, inScope)).toBeNull();
    expect(evaluateCategoryRule(catRule(["management_change"], { kind: "symbols", symbols: ["ZTDOUT"] }), { ...base, symbol: "ZTDOUT" }, inScope)).not.toBeNull();
    expect(evaluateCategoryRule(catRule(["management_change"], { kind: "statement_family", family: "nbfc" }), { ...base, symbol: "ZTDFIN" }, inScope)).not.toBeNull();
    expect(evaluateCategoryRule(catRule(["management_change"], { kind: "portfolio" }, false), base, inScope)).toBeNull();
    expect(evaluateCategoryRule(catRule(["management_change"], { kind: "portfolio" }, true), base, inScope)).not.toBeNull();
  });
});
