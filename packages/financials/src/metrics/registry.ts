import type { StatementFamily } from "@finn/shared/taxonomy";
import type { DurationContext, ParsedFiling, QuarterMetrics } from "../types";
import { bankingStrategy } from "./banking";
import { industrialStrategy } from "./industrial";
import { nbfcStrategy } from "./nbfc";
import type { MetricStrategy } from "./strategy";

const STRATEGIES: Readonly<Record<StatementFamily, MetricStrategy>> = {
  industrial: industrialStrategy,
  banking: bankingStrategy,
  nbfc: nbfcStrategy,
};

export type StrategyResolver = (family: StatementFamily) => MetricStrategy;

export const strategyFor: StrategyResolver = (family) => STRATEGIES[family];

/** Headline metrics plus identity checks for one filing, via its family's strategy. */
export function quarterMetrics(filing: ParsedFiling, context: DurationContext = "OneD", resolve: StrategyResolver = strategyFor): QuarterMetrics {
  const strategy = resolve(filing.statementFamily);
  return {
    periodEnd: filing.periodEnd,
    statementFamily: filing.statementFamily,
    metrics: strategy.headline(filing, context),
    checks: strategy.checks(filing),
  };
}
