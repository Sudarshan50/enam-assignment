import type { DurationContext, HeadlineMetric, HeadlineMetricKey, IdentityCheck, ParsedFiling } from "../types";

export const IDENTITY_TOLERANCE_PCT = 0.5;
/** Sums of independently rounded line items can drift by a few rounding units. */
const ROUNDING_UNITS_SLACK = 3;

export type FactReader = (concept: string) => number | null;

export function reader(filing: ParsedFiling, context: DurationContext): FactReader {
  const facts = filing.byContext[context];
  return (concept) => {
    const v = facts[concept];
    return v === undefined ? null : v;
  };
}

/** Duration contexts actually present: Q1 filings have no FourD, since the YTD is the quarter. */
export function durationContexts(filing: ParsedFiling): DurationContext[] {
  return Object.keys(filing.byContext.FourD).length > 0 ? ["OneD", "FourD"] : ["OneD"];
}

/** Sum of signed terms; null if any required term is missing. */
export function combine(terms: [sign: 1 | -1, value: number | null][]): number | null {
  let total = 0;
  for (const [sign, value] of terms) {
    if (value === null) return null;
    total += sign * value;
  }
  return total;
}

export function reported(key: HeadlineMetricKey, label: string, read: FactReader, concept: string): HeadlineMetric {
  return { key, label, value: read(concept), derived: false, concepts: [concept] };
}

export function derived(key: HeadlineMetricKey, label: string, value: number | null, concepts: string[]): HeadlineMetric {
  return { key, label, value, derived: true, concepts };
}

export type IdentityFn = (name: string, expected: number | null, actual: number | null) => IdentityCheck | null;

/** Coarsest rounding used for INR facts, from decimals="-7" (₹1 crore) etc. */
export function roundingUnit(filing: ParsedFiling): number {
  let unit = 1;
  for (const f of filing.facts) {
    const d = Number(f.decimals);
    if (f.unit === "INR" && Number.isInteger(d) && d < 0) unit = Math.max(unit, 10 ** -d);
  }
  return unit;
}

/** Relative tolerance with an absolute floor of a few rounding units; skipped (null) when an input is missing. */
export function identityChecker(filing: ParsedFiling, tolerancePct = IDENTITY_TOLERANCE_PCT): IdentityFn {
  const floor = ROUNDING_UNITS_SLACK * roundingUnit(filing);
  return (name, expected, actual) => {
    if (expected === null || actual === null) return null;
    const slack = Math.max((tolerancePct / 100) * Math.max(Math.abs(expected), Math.abs(actual)), floor);
    return { name, passed: Math.abs(actual - expected) <= slack, expected, actual, tolerancePct };
  };
}

/** Fails loudly when a concept the strategy depends on is absent (template drift, wrong family). */
export function requiredConcepts(filing: ParsedFiling, concepts: string[]): IdentityCheck {
  const missing = concepts.filter((c) => filing.byContext.OneD[c] === undefined);
  return {
    name: missing.length ? `OneD: required concepts present (missing ${missing.join(", ")})` : "OneD: required concepts present",
    passed: missing.length === 0,
    expected: concepts.length,
    actual: concepts.length - missing.length,
    tolerancePct: 0,
  };
}

/** The closest candidate wins; used where filers legitimately place an item on either side of PBT. */
export function closest(actual: number | null, candidates: (number | null)[]): number | null {
  if (actual === null) return candidates.find((c) => c !== null) ?? null;
  let best: number | null = null;
  for (const c of candidates) {
    if (c !== null && (best === null || Math.abs(c - actual) < Math.abs(best - actual))) best = c;
  }
  return best;
}

export function compact<T>(items: (T | null)[]): T[] {
  return items.filter((i): i is T => i !== null);
}
