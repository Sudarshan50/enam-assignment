import { fiscalQuarterLabel, formatInr, formatPct, pctChange } from "@finn/shared/format";
import type { ProvenancedNumber, ResultsCard, ResultsMetric } from "@finn/shared/contracts/cards";
import type { StatementFamily } from "@finn/shared/taxonomy";
import { strategyFor, type StrategyResolver } from "../metrics/registry";
import type { MarginSpec, MetricStrategy } from "../metrics/strategy";
import type { BuildResultsCard, BuildResultsCardInput, HeadlineMetric, HeadlineMetricKey, ParsedFiling } from "../types";
import { previousQuarterEnd, yearAgoQuarterEnd } from "./periods";

export class ResultsCardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultsCardInputError";
  }
}

interface Slot {
  metrics: Map<HeadlineMetricKey, HeadlineMetric>;
  ref: string | undefined;
}

export function createResultsCardBuilder(resolve: StrategyResolver = strategyFor): BuildResultsCard {
  return (input) => {
    const { current } = input;
    const strategy = resolve(current.statementFamily);
    assertComparable(current, input.previousQuarter, previousQuarterEnd(current.periodEnd), "previousQuarter");
    assertComparable(current, input.yearAgoQuarter, yearAgoQuarterEnd(current.periodEnd), "yearAgoQuarter");

    const cur = slot(strategy, current, input.sourceRef);
    const prev = input.previousQuarter ? slot(strategy, input.previousQuarter, input.previousQuarterRef) : null;
    const yago = input.yearAgoQuarter ? slot(strategy, input.yearAgoQuarter, input.yearAgoQuarterRef) : null;

    const checksPass = strategy.checks(current).every((c) => c.passed);
    const metrics = strategy.cardMetricKeys.map((key) => cardMetric(key, cur, prev, yago));
    const margin = strategy.margin ? marginBps(strategy.margin, cur, prev, yago) : null;
    const periodLabel = fiscalQuarterLabel(current.periodEnd);

    return {
      kind: "results",
      periodEnd: current.periodEnd,
      periodLabel,
      basis: current.basis,
      statementFamily: current.statementFamily,
      audited: current.audited,
      status: checksPass ? "ready" : "under_review",
      metrics,
      marginBps: margin,
      read: checksPass ? readSentence(periodLabel, current.basis, metrics, margin) : underReviewSentence(periodLabel),
      ebitdaDefinition: strategy.ebitdaDefinition,
    };
  };
}

export const buildResultsCard: BuildResultsCard = createResultsCardBuilder();

/** Card for a results announcement whose XBRL has not been published yet; never carries figures. */
export function notFiledResultsCard(args: { periodEnd: string; basis: ResultsCard["basis"]; statementFamily: StatementFamily }): ResultsCard {
  const periodLabel = fiscalQuarterLabel(args.periodEnd);
  return {
    kind: "results",
    periodEnd: args.periodEnd,
    periodLabel,
    basis: args.basis,
    statementFamily: args.statementFamily,
    audited: false,
    status: "not_filed_yet",
    metrics: [],
    marginBps: null,
    read: `${periodLabel} numbers not filed yet.`,
    ebitdaDefinition: null,
  };
}

function assertComparable(current: ParsedFiling, other: ParsedFiling | null, expectedEnd: string, slotName: string): void {
  if (!other) return;
  if (other.basis !== current.basis) {
    throw new ResultsCardInputError(`${slotName} is ${other.basis} but current is ${current.basis}; bases must not be mixed`);
  }
  if (other.statementFamily !== current.statementFamily) {
    throw new ResultsCardInputError(`${slotName} is ${other.statementFamily} but current is ${current.statementFamily}`);
  }
  if (other.periodEnd !== expectedEnd) {
    throw new ResultsCardInputError(`${slotName} ends ${other.periodEnd}, expected ${expectedEnd}`);
  }
}

function slot(strategy: MetricStrategy, filing: ParsedFiling, ref: string | undefined): Slot {
  return { metrics: new Map(strategy.headline(filing, "OneD").map((m) => [m.key, m])), ref };
}

function provenanced(metric: HeadlineMetric | undefined, ref: string | undefined): ProvenancedNumber {
  return {
    value: metric?.value ?? null,
    unit: "inr",
    derived: metric?.derived ?? false,
    ...(ref ? { source: { kind: "xbrl" as const, ref } } : {}),
  };
}

function cardMetric(key: HeadlineMetricKey, cur: Slot, prev: Slot | null, yago: Slot | null): ResultsMetric {
  const metric = cur.metrics.get(key);
  const value = metric?.value ?? null;
  const prevValue = prev?.metrics.get(key)?.value ?? null;
  const yagoValue = yago?.metrics.get(key)?.value ?? null;
  return {
    key,
    label: metric?.label ?? key,
    current: provenanced(metric, cur.ref),
    previousQuarter: prev ? provenanced(prev.metrics.get(key), prev.ref) : null,
    yearAgoQuarter: yago ? provenanced(yago.metrics.get(key), yago.ref) : null,
    qoqPct: pctChange(value, prevValue),
    yoyPct: pctChange(value, yagoValue),
  };
}

function marginPct(spec: MarginSpec, s: Slot | null): number | null {
  const num = s?.metrics.get(spec.numerator)?.value ?? null;
  const den = s?.metrics.get(spec.denominator)?.value ?? null;
  if (num === null || den === null || den <= 0) return null;
  return (num / den) * 100;
}

function marginBps(spec: MarginSpec, cur: Slot, prev: Slot | null, yago: Slot | null): NonNullable<ResultsCard["marginBps"]> {
  const now = marginPct(spec, cur);
  const before = marginPct(spec, prev);
  const yearAgo = marginPct(spec, yago);
  const bps = (base: number | null) => (now === null || base === null ? null : Math.round((now - base) * 100));
  return {
    label: spec.label,
    current: now === null ? null : Math.round(now * 100) / 100,
    qoqBps: bps(before),
    yoyBps: bps(yearAgo),
  };
}

function change(m: ResultsMetric): string {
  if (m.yoyPct !== null) return ` (${formatPct(m.yoyPct)} YoY)`;
  if (m.qoqPct !== null) return ` (${formatPct(m.qoqPct)} QoQ)`;
  return "";
}

function readSentence(
  periodLabel: string,
  basis: ResultsCard["basis"],
  metrics: ResultsMetric[],
  margin: ResultsCard["marginBps"],
): string {
  const lead = metrics[0];
  const pat = metrics.find((m) => m.key === "pat");
  const parts: string[] = [];
  if (lead && lead.current.value !== null) parts.push(`${lead.label} ${formatInr(lead.current.value)}${change(lead)}`);
  if (margin?.current != null) {
    const delta = margin.yoyBps !== null ? ` (${margin.yoyBps >= 0 ? "+" : ""}${margin.yoyBps} bps YoY)` : "";
    parts.push(`${margin.label} ${margin.current.toFixed(1)}%${delta}`);
  }
  if (pat && pat !== lead && pat.current.value !== null) parts.push(`PAT ${formatInr(pat.current.value)}${change(pat)}`);
  const basisNote = basis === "standalone" ? " (standalone)" : "";
  return parts.length ? `${periodLabel}${basisNote}: ${parts.join(", ")}.` : `${periodLabel}${basisNote} results filed.`;
}

function underReviewSentence(periodLabel: string): string {
  return `${periodLabel} numbers under review: the filing's totals did not reconcile.`;
}
