import type { GuidanceMetric, Verdict } from "@finn/shared/contracts/research";
import type { ActualsResolver } from "./actuals";
import { parseFiscalLabel, type FiscalPeriod } from "./periods";

export interface LedgerItem {
  id: string;
  metric: GuidanceMetric;
  statementType: "explicit_guidance" | "target" | "aspiration";
  /** Encoding: point = low==high; range = low<high; at least = high null; at most = low null. */
  low: number | null;
  high: number | null;
  unit: "pct" | "inr_crore" | "x";
  horizonLabel: string;
  scope: string;
  segment: string | null;
  quote: string;
  saidIn: string;
  /** ISO date of the call. */
  saidOn: string | null;
  documentId: string;
  withdrawn: boolean;
}

export interface TranscriptRef {
  documentId: string;
  label: string;
  callDate: string;
}

export interface MatchInput {
  items: LedgerItem[];
  /** Every transcript that was processed, so absence from a call is meaningful. */
  transcripts: TranscriptRef[];
  actuals: ActualsResolver;
  asOf: Date;
  pointTolerance?: number;
  /** Later calls without a mention before open guidance counts as quietly dropped. */
  dropAfterCalls?: number;
}

export interface LedgerEntry {
  representative: LedgerItem;
  memberIds: string[];
  verdict: Verdict;
  actual: number | null;
  actualPeriod: string | null;
  actualSource: string | null;
  explanation: string;
}

export interface LedgerSummary {
  elapsed: number;
  delivered: number;
  missed: number;
  pending: number;
  quietlyDropped: number;
  notScored: number;
}

type Direction = "higher_better" | "lower_better" | "two_sided";

const DIRECTION: Record<GuidanceMetric, Direction> = {
  revenue_growth: "higher_better",
  ebitda_margin: "higher_better",
  pat_growth: "higher_better",
  order_book: "higher_better",
  volume_growth: "higher_better",
  capex: "two_sided",
  net_debt: "lower_better",
};

const METRIC_LABEL: Record<GuidanceMetric, string> = {
  revenue_growth: "revenue growth",
  ebitda_margin: "EBITDA margin",
  pat_growth: "PAT growth",
  capex: "capex",
  order_book: "order book",
  volume_growth: "volume growth",
  net_debt: "net debt",
};

function fmt(v: number, unit: LedgerItem["unit"]): string {
  const n = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return unit === "pct" ? `${n}%` : unit === "inr_crore" ? `₹${n} Cr` : `${n}x`;
}

export function describeTarget(item: Pick<LedgerItem, "low" | "high" | "unit">): string {
  const { low, high, unit } = item;
  if (low !== null && high !== null) return low === high ? fmt(low, unit) : `${fmt(low, unit)}–${fmt(high, unit)}`;
  if (low !== null) return `at least ${fmt(low, unit)}`;
  if (high !== null) return `at most ${fmt(high, unit)}`;
  return "an unquantified target";
}

/** Pure verdict for an elapsed promise against its same-period actual. */
export function judge(item: Pick<LedgerItem, "metric" | "low" | "high">, actual: number, pointTolerance = 0.1): { verdict: "delivered" | "missed"; note: string } {
  const dir = DIRECTION[item.metric];
  const { low, high } = item;
  if (low !== null && high !== null && low === high) {
    const tol = Math.abs(low) * pointTolerance;
    if (Math.abs(actual - low) <= tol) return { verdict: "delivered", note: "within ±10% of the target" };
    if (dir === "higher_better" && actual > low) return { verdict: "delivered", note: "ahead of the target" };
    if (dir === "lower_better" && actual < low) return { verdict: "delivered", note: "better than the target" };
    return { verdict: "missed", note: actual < low ? "short of the target" : "above the target" };
  }
  if (low !== null && high !== null) {
    const lo = Math.min(low, high);
    const hi = Math.max(low, high);
    if (actual >= lo && actual <= hi) return { verdict: "delivered", note: "within the guided range" };
    if (dir === "higher_better" && actual > hi) return { verdict: "delivered", note: "above the guided range" };
    if (dir === "lower_better" && actual < lo) return { verdict: "delivered", note: "better than the guided range" };
    return { verdict: "missed", note: actual < lo ? "below the guided range" : "above the guided range" };
  }
  if (low !== null) return actual >= low ? { verdict: "delivered", note: "met the floor" } : { verdict: "missed", note: "below the floor" };
  if (high !== null) return actual <= high ? { verdict: "delivered", note: "within the ceiling" } : { verdict: "missed", note: "above the ceiling" };
  return { verdict: "missed", note: "no quantified target" };
}

function groupKey(i: LedgerItem): string {
  const period = parseFiscalLabel(i.horizonLabel)?.label ?? i.horizonLabel.trim().toUpperCase();
  return [i.metric, period, i.scope, (i.segment ?? "").trim().toLowerCase()].join("|");
}

const SEGMENT_STOPWORDS = new Set(["and", "the", "of", "segment", "business", "division", "total", "overall", "growth", "value", "volume"]);
const SEGMENT_SYNONYMS: Record<string, string> = { plumb: "pip" };

function segmentStems(segment: string): Set<string> {
  const stems = segment
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !SEGMENT_STOPWORDS.has(w))
    .map((w) => w.replace(/ing$/, "").replace(/(es|s)$/, "").replace(/e$/, ""))
    .map((s) => SEGMENT_SYNONYMS[s] ?? s);
  return new Set(stems);
}

/**
 * Lenient: "Adhesives (UK)", "UK Adhesives" and "Adhesives India" are related, as are "Piping" and "Pipes".
 * Used only to decide whether a promise was mentioned again, so leniency errs against calling it dropped.
 */
function sameSubject(a: LedgerItem, b: LedgerItem): boolean {
  if (a.metric !== b.metric) return false;
  if ((parseFiscalLabel(a.horizonLabel)?.label ?? a.horizonLabel) !== (parseFiscalLabel(b.horizonLabel)?.label ?? b.horizonLabel)) return false;
  if (!a.segment || !b.segment) return !a.segment && !b.segment;
  const sa = segmentStems(a.segment);
  return [...segmentStems(b.segment)].some((s) => sa.has(s));
}

const byDate = (a: LedgerItem, b: LedgerItem) => (a.saidOn ?? "").localeCompare(b.saidOn ?? "");

function endOfDay(isoDate: string): number {
  return new Date(`${isoDate}T23:59:59+05:30`).getTime();
}

/**
 * Deterministic Promise Ledger. Statements about the same metric, horizon and scope are one promise; the
 * earliest explicit statement is the one judged (later revisions are noted, they do not reset the bar).
 */
export function matchGuidance(input: MatchInput): LedgerEntry[] {
  const tolerance = input.pointTolerance ?? 0.1;
  const dropAfter = input.dropAfterCalls ?? 2;
  const groups = new Map<string, LedgerItem[]>();
  for (const item of input.items) {
    const list = groups.get(groupKey(item)) ?? [];
    list.push(item);
    groups.set(groupKey(item), list);
  }

  const entries: LedgerEntry[] = [];
  for (const members of groups.values()) {
    members.sort(byDate);
    const memberIds = members.map((m) => m.id);
    const statements = members.filter((m) => !m.withdrawn);
    const withdrawals = members.filter((m) => m.withdrawn);
    const base = { memberIds, actual: null, actualPeriod: null, actualSource: null };

    if (statements.length === 0) {
      const w = withdrawals[0]!;
      entries.push({ ...base, representative: w, verdict: "not_scored", explanation: `Withdrawal of ${METRIC_LABEL[w.metric]} guidance for ${w.horizonLabel} (${w.saidIn}).` });
      continue;
    }

    const rep = statements.find((s) => s.statementType === "explicit_guidance") ?? statements[0]!;
    const what = `${METRIC_LABEL[rep.metric]} of ${describeTarget(rep)} for ${rep.horizonLabel}${rep.segment ? ` (${rep.segment})` : ""}`;
    const revisions = statements.filter((s) => s !== rep && (s.low !== rep.low || s.high !== rep.high) && (s.saidOn ?? "") > (rep.saidOn ?? ""));
    const revisionNote = revisions.length ? ` Later revised to ${describeTarget(revisions[revisions.length - 1]!)} (${revisions[revisions.length - 1]!.saidIn}).` : "";
    const withdrawal = withdrawals.find((w) => (w.saidOn ?? "") >= (rep.saidOn ?? ""));
    const withdrawalNote = withdrawal ? ` Withdrawn by management in the ${withdrawal.saidIn}.` : "";

    if (rep.statementType !== "explicit_guidance") {
      entries.push({ ...base, representative: rep, verdict: "not_scored", explanation: `Stated as ${rep.statementType === "target" ? "a target" : "an aspiration"}, not explicit guidance: ${what} (${rep.saidIn}). Shown, not scored.` });
      continue;
    }

    const period: FiscalPeriod | null = parseFiscalLabel(rep.horizonLabel);
    if (!period) {
      entries.push({ ...base, representative: rep, verdict: "not_scored", explanation: `Horizon "${rep.horizonLabel}" is not a fiscal year, half or quarter.` });
      continue;
    }

    const elapsed = input.asOf.getTime() > endOfDay(period.end);
    if (elapsed) {
      const a = input.actuals(rep.metric, period);
      if (rep.scope === "segment") {
        entries.push({ ...base, representative: rep, verdict: "not_scored", explanation: `Guided ${what} (${rep.saidIn}); cannot be scored: only company-wide actuals are available, not segment figures.${withdrawalNote}` });
      } else if (a.status === "not_computable") {
        entries.push({ ...base, representative: rep, verdict: "not_scored", explanation: `Guided ${what} (${rep.saidIn}); cannot be scored: ${a.reason}.${withdrawalNote}` });
      } else if (a.status === "not_available") {
        entries.push({ ...base, representative: rep, verdict: "pending", explanation: `Guided ${what} (${rep.saidIn}); ${period.label} has ended but ${a.reason}.${withdrawalNote}` });
      } else {
        const j = judge(rep, a.value, tolerance);
        entries.push({
          ...base,
          representative: rep,
          verdict: j.verdict,
          actual: a.value,
          actualPeriod: a.period,
          actualSource: a.source,
          explanation: `Guided ${what} (${rep.saidIn}); actual ${fmt(a.value, rep.unit)} (${a.detail}), ${j.note}.${revisionNote}${withdrawalNote}`,
        });
      }
      continue;
    }

    if (withdrawal) {
      entries.push({ ...base, representative: rep, verdict: "not_scored", explanation: `Guided ${what} (${rep.saidIn}).${withdrawalNote}` });
      continue;
    }

    const mentions = [...statements, ...input.items.filter((i) => sameSubject(rep, i))];
    const lastMention = mentions.reduce((d, s) => ((s.saidOn ?? "") > d ? (s.saidOn ?? "") : d), "");
    const laterCalls = input.transcripts.filter((t) => t.callDate > lastMention).sort((a, b) => a.callDate.localeCompare(b.callDate));
    if (lastMention && laterCalls.length >= dropAfter) {
      entries.push({
        ...base,
        representative: rep,
        verdict: "quietly_dropped",
        explanation: `Guided ${what} (${rep.saidIn}); not mentioned again in the ${laterCalls.map((c) => c.label).join(", ")} while ${period.label} is still open, and never explicitly withdrawn.${revisionNote}`,
      });
      continue;
    }

    entries.push({ ...base, representative: rep, verdict: "pending", explanation: `Guided ${what} (${rep.saidIn}); ${period.label} ends ${period.end}.${revisionNote}` });
  }
  return entries.sort((a, b) => byDate(a.representative, b.representative));
}

export function summariseLedger(entries: readonly LedgerEntry[]): LedgerSummary {
  const count = (v: Verdict) => entries.filter((e) => e.verdict === v).length;
  const delivered = count("delivered");
  const missed = count("missed");
  return { elapsed: delivered + missed, delivered, missed, pending: count("pending"), quietlyDropped: count("quietly_dropped"), notScored: count("not_scored") };
}

/** "5 of 8 elapsed promises delivered, 1 quietly dropped, 2 pending" — always a fraction, never a score. */
export function ledgerSummaryText(s: Omit<LedgerSummary, "notScored"> & { notScored?: number }): string {
  const parts: string[] = [];
  if (s.elapsed > 0) parts.push(`${s.delivered} of ${s.elapsed} elapsed promise${s.elapsed === 1 ? "" : "s"} delivered`);
  else parts.push("No elapsed promises to score yet");
  if (s.quietlyDropped > 0) parts.push(`${s.quietlyDropped} quietly dropped`);
  if (s.pending > 0) parts.push(`${s.pending} pending`);
  return parts.join(", ");
}
