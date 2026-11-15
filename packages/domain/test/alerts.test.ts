import { describe, expect, it } from "vitest";
import type { AlertRuleDefinition } from "@finn/shared/contracts/alerts";
import { createScopeResolver, evaluateCategoryRule, evaluatePriceRules, type PriceSnapshot, type RuleLike } from "../src/alerts/evaluate";

const families: Record<string, "industrial" | "banking" | "nbfc"> = { TRENT: "industrial", HDFCBANK: "banking", ICICIBANK: "banking", BAJFINANCE: "nbfc", DIXON: "industrial" };
const inScope = createScopeResolver({ holdings: ["TRENT", "HDFCBANK", "DIXON"], familyOf: (s) => families[s] ?? null });

const rule = (id: string, definition: AlertRuleDefinition, enabled = true): RuleLike => ({ id, definition, enabled });

const snap = (symbol: string, close: number, prevClose: number, volume = 1000, avg20Volume: number | null = 1000): PriceSnapshot => ({
  symbol,
  sessionDate: "2026-11-13",
  close,
  prevClose,
  volume,
  avg20Volume,
});

describe("evaluatePriceRules", () => {
  const snapshots = [snap("TRENT", 95, 100), snap("HDFCBANK", 103.5, 100), snap("ICICIBANK", 97, 100), snap("DIXON", 100, 100, 3500, 1000), snap("BAJFINANCE", 90, 100)];

  it("fires price_move by direction and threshold, within scope", () => {
    const drafts = evaluatePriceRules(
      [
        rule("down4", { type: "price_move", scope: { kind: "symbols", symbols: ["TRENT"] }, direction: "down", thresholdPct: 4 }),
        rule("up4", { type: "price_move", scope: { kind: "symbols", symbols: ["TRENT"] }, direction: "up", thresholdPct: 4 }),
        rule("bank3", { type: "price_move", scope: { kind: "statement_family", family: "banking" }, direction: "either", thresholdPct: 3 }),
        rule("port5", { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 5 }),
      ],
      snapshots,
      inScope,
    );
    const keys = drafts.map((d) => `${d.ruleId}:${d.symbol}`).sort();
    expect(keys).toEqual(["bank3:HDFCBANK", "bank3:ICICIBANK", "down4:TRENT", "port5:TRENT"]);
    const trent = drafts.find((d) => d.ruleId === "down4")!;
    expect(trent.kind).toBe("price_move");
    expect(trent.eventKey).toBe("2026-11-13");
    expect(trent.sessionDate).toBe("2026-11-13");
    expect(trent.title).toContain("TRENT");
    expect(trent.payload.changePct).toBe(-5);
  });

  it("fires volume_spike only with a 20-session average and at the multiple", () => {
    const drafts = evaluatePriceRules(
      [rule("vol3", { type: "volume_spike", scope: { kind: "portfolio" }, multiple: 3 })],
      [...snapshots, { ...snap("TRENT", 100, 100, 9000, null) }],
      inScope,
    );
    expect(drafts.map((d) => d.symbol)).toEqual(["DIXON"]);
    expect(drafts[0]!.kind).toBe("volume_spike");
    expect(drafts[0]!.payload.ratio).toBe(3.5);
  });

  it("is deterministic (idempotent event keys) and skips disabled rules and suppressed symbols", () => {
    const rules = [
      rule("r1", { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 3 }),
      rule("off", { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 0.5 }, false),
    ];
    const a = evaluatePriceRules(rules, snapshots, inScope);
    const b = evaluatePriceRules(rules, snapshots, inScope);
    expect(a).toEqual(b);
    expect(new Set(a.map((d) => `${d.ruleId}|${d.symbol}|${d.kind}|${d.eventKey}`)).size).toBe(a.length);
    expect(a.every((d) => d.ruleId === "r1")).toBe(true);
    const suppressed = evaluatePriceRules(rules, snapshots, inScope, { suppressedSymbols: new Set(["TRENT"]) });
    expect(suppressed.some((d) => d.symbol === "TRENT")).toBe(false);
  });

  it("ignores rows without a previous close", () => {
    const drafts = evaluatePriceRules([rule("r", { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 1 })], [{ ...snap("TRENT", 90, 100), prevClose: null }], inScope);
    expect(drafts).toEqual([]);
  });
});

describe("evaluateCategoryRule", () => {
  const ratingRule = rule("cat", { type: "category", scope: { kind: "portfolio" }, categories: ["credit_rating", "results"] });
  const base = { seqId: "106860004", symbol: "HDFCBANK", category: "credit_rating" as const, headline: "Credit rating revised", publishedAt: new Date("2026-11-13T10:00:00Z") };

  it("fires for matching category in scope and keys on the cluster", () => {
    const d = evaluateCategoryRule(ratingRule, { ...base, clusterKey: "HDFCBANK:credit_rating:2026-11-13" }, inScope)!;
    expect(d.kind).toBe("category");
    expect(d.eventKey).toBe("HDFCBANK:credit_rating:2026-11-13");
    expect(d.announcementSeqId).toBe("106860004");
    const dup = evaluateCategoryRule(ratingRule, { ...base, seqId: "106860005", clusterKey: "HDFCBANK:credit_rating:2026-11-13" }, inScope)!;
    expect(dup.eventKey).toBe(d.eventKey);
  });

  it("falls back to seq id when there is no cluster key", () => {
    expect(evaluateCategoryRule(ratingRule, base, inScope)!.eventKey).toBe("106860004");
  });

  it("does not fire out of scope, for other categories, or for price rules", () => {
    expect(evaluateCategoryRule(ratingRule, { ...base, symbol: "BAJFINANCE" }, inScope)).toBeNull();
    expect(evaluateCategoryRule(ratingRule, { ...base, category: "dividend" }, inScope)).toBeNull();
    expect(evaluateCategoryRule(rule("p", { type: "price_move", scope: { kind: "portfolio" }, direction: "up", thresholdPct: 2 }), base, inScope)).toBeNull();
  });
});
