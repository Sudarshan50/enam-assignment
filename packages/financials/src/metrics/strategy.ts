import type { StatementFamily } from "@finn/shared/taxonomy";
import type { DurationContext, HeadlineMetric, HeadlineMetricKey, IdentityCheck, ParsedFiling } from "../types";

export interface MarginSpec {
  label: string;
  numerator: HeadlineMetricKey;
  denominator: HeadlineMetricKey;
}

/** One per statement family. Adding a family means adding a strategy, not editing the card builder. */
export interface MetricStrategy {
  readonly family: StatementFamily;
  /** Metrics shown on the results card, in display order. */
  readonly cardMetricKeys: readonly HeadlineMetricKey[];
  readonly margin: MarginSpec | null;
  readonly ebitdaDefinition: string | null;
  headline(filing: ParsedFiling, context: DurationContext): HeadlineMetric[];
  checks(filing: ParsedFiling): IdentityCheck[];
}
