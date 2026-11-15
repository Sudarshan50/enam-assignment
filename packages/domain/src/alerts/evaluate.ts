import type { AlertRuleDefinition } from "@finn/shared/contracts/alerts";
import { CATEGORY_LABELS, type Category, type StatementFamily } from "@finn/shared/taxonomy";
import { formatPct, istDateString } from "@finn/shared/format";

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

/** A bonus/split filing, as needed to decide which sessions its mechanical price move can land on. */
export interface CorporateActionForAlert {
  symbol: string;
  publishedAt: Date;
  /** YYYY-MM-DD from the enriched card, when known. */
  recordDate: string | null;
  /** Exchange text and summary; searched for a record/ex-date when the card has none. */
  text: string;
}

export const CORPORATE_ACTION_SUPPRESSION = {
  /** Sessions this many days after the filing (and the filing day itself). */
  afterFilingDays: 7,
  /** Sessions this many calendar days either side of the record/ex-date (T+1: ex-date is the record date; T+2 was a business day earlier). */
  aroundExDateDays: 3,
  /** Filings this far back can still have their record date on or after the session (bonus within 2 months of board approval). */
  lookbackDays: 90,
} as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DATE_FORMATS: { re: RegExp; parse: (m: RegExpMatchArray) => [number, number, number] }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  { re: /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g, parse: (m) => [Number(m[3]), Number(m[2]), Number(m[1])] },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s/-]+${MON}[\\s/,-]+(\\d{4})\\b`, "gi"),
    parse: (m) => [Number(m[3]), MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[1])],
  },
  {
    re: new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
    parse: (m) => [Number(m[3]), MONTHS.indexOf(m[1]!.toLowerCase()) + 1, Number(m[2])],
  },
];
const RECORD_DATE_RE = /\b(record|ex)[- ]?date\b/gi;
/** How far (characters) a date may sit from "record date" / "ex-date" and still belong to it. */
const RECORD_DATE_REACH = 80;

/** The record or ex-date stated in a corporate-action filing ("Record date ... is 20-Nov-2026", "fixed 20.11.2026 as the record date"). */
export function extractRecordDate(text: string): string | null {
  const dates: { at: number; end: number; iso: string }[] = [];
  for (const { re, parse } of DATE_FORMATS) {
    for (const m of text.matchAll(re)) {
      const [y, mo, d] = parse(m);
      const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const parsed = new Date(`${iso}T00:00:00Z`);
      if (mo >= 1 && mo <= 12 && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso) dates.push({ at: m.index, end: m.index + m[0].length, iso });
    }
  }
  let best: { distance: number; iso: string } | null = null;
  for (const k of text.matchAll(RECORD_DATE_RE)) {
    for (const d of dates) {
      const after = d.at >= k.index;
      const between = after ? text.slice(k.index + k[0].length, d.at) : text.slice(d.end, k.index);
      const distance = between.length;
      if (distance > RECORD_DATE_REACH || /;|\.\s/.test(between)) continue;
      if (!best || distance < best.distance) best = { distance, iso: d.iso };
    }
  }
  return best?.iso ?? null;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Symbols whose session move is mechanical: within a week of the bonus/split filing, or around its record/ex-date
 * (which is often weeks after the filing).
 */
export function corporateActionSuppression(actions: readonly CorporateActionForAlert[], sessionDate: string): Set<string> {
  const { afterFilingDays, aroundExDateDays } = CORPORATE_ACTION_SUPPRESSION;
  const out = new Set<string>();
  for (const a of actions) {
    const sinceFiling = daysBetween(istDateString(a.publishedAt), sessionDate);
    const exDate = a.recordDate ?? extractRecordDate(a.text);
    const nearExDate = exDate !== null && Math.abs(daysBetween(exDate, sessionDate)) <= aroundExDateDays;
    if ((sinceFiling >= 0 && sinceFiling <= afterFilingDays) || nearExDate) out.add(a.symbol);
  }
  return out;
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
