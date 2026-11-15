import type { AlertRuleDefinition } from "@finn/shared/contracts/alerts";
import { CATEGORY_LABELS, type Category, type StatementFamily } from "@finn/shared/taxonomy";
import { formatPct } from "@finn/shared/format";

export type RuleScope = AlertRuleDefinition["scope"];
export type AlertKind = AlertRuleDefinition["type"];

export interface RuleLike {
  id: string;
  name?: string;
  enabled?: boolean;
  definition: AlertRuleDefinition;
}

export interface PriceSnapshot {
  symbol: string;
  sessionDate: string;
  close: number;
  prevClose: number | null;
  volume: number | null;
  /** Average volume of the previous 20 completed sessions; null until 20 sessions of history exist. */
  avg20Volume: number | null;
}

export interface AnnouncementForAlert {
  seqId: string;
  symbol: string;
  category: Category;
  headline: string;
  oneLiner?: string | null;
  publishedAt: Date;
  /** When set, the alert dedupes on the cluster so duplicate filings push once per rule. */
  clusterKey?: string | null;
}

export interface AlertDraft {
  ruleId: string;
  symbol: string;
  kind: AlertKind;
  /** Deterministic per event: session date for price/volume, cluster key (or seq id) for filings. */
  eventKey: string;
  sessionDate: string | null;
  announcementSeqId: string | null;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

export type ScopeResolver = (scope: RuleScope, symbol: string) => boolean;

export function createScopeResolver(input: {
  holdings: Iterable<string>;
  familyOf: (symbol: string) => StatementFamily | null | undefined;
}): ScopeResolver {
  const holdings = new Set([...input.holdings].map((s) => s.toUpperCase()));
  return (scope, symbol) => {
    const s = symbol.toUpperCase();
    switch (scope.kind) {
      case "portfolio":
        return holdings.has(s);
      case "symbols":
        return scope.symbols.some((x) => x.toUpperCase() === s);
      case "statement_family":
        return input.familyOf(s) === scope.family;
    }
  };
}

export function changePct(snapshot: Pick<PriceSnapshot, "close" | "prevClose">): number | null {
  if (snapshot.prevClose == null || snapshot.prevClose <= 0) return null;
  return (snapshot.close / snapshot.prevClose - 1) * 100;
}

export interface EvaluatePriceOptions {
  /** Symbols with a bonus/split in the window; their price and volume moves are mechanical, not news. */
  suppressedSymbols?: ReadonlySet<string>;
}

export function evaluatePriceRules(
  rules: readonly RuleLike[],
  snapshots: readonly PriceSnapshot[],
  inScope: ScopeResolver,
  options: EvaluatePriceOptions = {},
): AlertDraft[] {
  const drafts: AlertDraft[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const def = rule.definition;
    if (def.type === "category") continue;
    for (const snap of snapshots) {
      if (!inScope(def.scope, snap.symbol)) continue;
      if (options.suppressedSymbols?.has(snap.symbol)) continue;
      const draft = def.type === "price_move" ? priceMove(rule.id, def, snap) : volumeSpike(rule.id, def, snap);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

type PriceMoveDef = Extract<AlertRuleDefinition, { type: "price_move" }>;
type VolumeSpikeDef = Extract<AlertRuleDefinition, { type: "volume_spike" }>;
type CategoryDef = Extract<AlertRuleDefinition, { type: "category" }>;

/** Absorbs float error so an exact move fires its rule (₹3 -> ₹2.85 computes as -4.999999999999993%). */
const THRESHOLD_EPSILON = 1e-9;

function priceMove(ruleId: string, def: PriceMoveDef, snap: PriceSnapshot): AlertDraft | null {
  const pct = changePct(snap);
  if (pct == null) return null;
  const threshold = def.thresholdPct - THRESHOLD_EPSILON;
  const hit = def.direction === "up" ? pct >= threshold : def.direction === "down" ? pct <= -threshold : Math.abs(pct) >= threshold;
  if (!hit) return null;
  return {
    ruleId,
    symbol: snap.symbol,
    kind: "price_move",
    eventKey: snap.sessionDate,
    sessionDate: snap.sessionDate,
    announcementSeqId: null,
    title: `${snap.symbol} ${formatPct(pct)} today`,
    body: `Closed at ₹${snap.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })} on ${snap.sessionDate} (${formatPct(pct)} vs previous close; rule: ${def.direction} ${def.thresholdPct}%).`,
    payload: { changePct: round2(pct), close: snap.close, prevClose: snap.prevClose, thresholdPct: def.thresholdPct, direction: def.direction },
  };
}

function volumeSpike(ruleId: string, def: VolumeSpikeDef, snap: PriceSnapshot): AlertDraft | null {
  if (snap.volume == null || snap.avg20Volume == null || snap.avg20Volume <= 0) return null;
  const ratio = snap.volume / snap.avg20Volume;
  if (ratio < def.multiple) return null;
  return {
    ruleId,
    symbol: snap.symbol,
    kind: "volume_spike",
    eventKey: snap.sessionDate,
    sessionDate: snap.sessionDate,
    announcementSeqId: null,
    title: `${snap.symbol} volume ${ratio.toFixed(1)}× average`,
    body: `${snap.volume.toLocaleString("en-IN")} shares traded on ${snap.sessionDate}, ${ratio.toFixed(1)}× the 20-session average (rule: ${def.multiple}×).`,
    payload: { volume: snap.volume, avg20Volume: round2(snap.avg20Volume), ratio: round2(ratio), multiple: def.multiple },
  };
}

export function evaluateCategoryRule(rule: RuleLike, announcement: AnnouncementForAlert, inScope: ScopeResolver): AlertDraft | null {
  if (rule.enabled === false) return null;
  const def = rule.definition;
  if (def.type !== "category") return null;
  return categoryAlert(rule.id, def, announcement, inScope);
}

function categoryAlert(ruleId: string, def: CategoryDef, a: AnnouncementForAlert, inScope: ScopeResolver): AlertDraft | null {
  if (!def.categories.includes(a.category)) return null;
  if (!inScope(def.scope, a.symbol)) return null;
  return {
    ruleId,
    symbol: a.symbol,
    kind: "category",
    eventKey: a.clusterKey ?? a.seqId,
    sessionDate: null,
    announcementSeqId: a.seqId,
    title: `${a.symbol}: ${CATEGORY_LABELS[a.category]}`,
    body: (a.oneLiner ?? a.headline).slice(0, 240),
    payload: { category: a.category, seqId: a.seqId, publishedAt: a.publishedAt.toISOString() },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
