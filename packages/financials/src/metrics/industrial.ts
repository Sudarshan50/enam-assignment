import { combine, derived, reader, reported, requiredConcepts } from "./facts";
import { indAsChecks } from "./indAsChecks";
import type { MetricStrategy } from "./strategy";

const EBITDA_CONCEPTS = [
  "ProfitBeforeExceptionalItemsAndTax",
  "FinanceCosts",
  "DepreciationDepletionAndAmortisationExpense",
  "OtherIncome",
];

const REQUIRED = ["RevenueFromOperations", ...EBITDA_CONCEPTS, "ProfitBeforeTax", "ProfitLossForPeriod"];

export const industrialStrategy: MetricStrategy = {
  family: "industrial",
  cardMetricKeys: ["revenue", "ebitda", "pbt", "pat"],
  margin: { label: "EBITDA margin", numerator: "ebitda", denominator: "revenue" },
  ebitdaDefinition:
    "EBITDA (computed) = Profit before exceptional items and tax + Finance costs + Depreciation and amortisation - Other income. Exceptional items are excluded.",

  headline(filing, context) {
    const f = reader(filing, context);
    const ebitda = combine([
      [1, f("ProfitBeforeExceptionalItemsAndTax")],
      [1, f("FinanceCosts")],
      [1, f("DepreciationDepletionAndAmortisationExpense")],
      [-1, f("OtherIncome")],
    ]);
    const metrics = [
      reported("revenue", "Revenue", f, "RevenueFromOperations"),
      derived("ebitda", "EBITDA", ebitda, EBITDA_CONCEPTS),
      reported("pbt", "PBT", f, "ProfitBeforeTax"),
      reported("pat", "PAT", f, "ProfitLossForPeriod"),
    ];
    if (f("ProfitOrLossAttributableToOwnersOfParent") !== null) {
      metrics.push(reported("pat_owners", "PAT (owners' share)", f, "ProfitOrLossAttributableToOwnersOfParent"));
    }
    return metrics;
  },

  checks(filing) {
    return [requiredConcepts(filing, REQUIRED), ...indAsChecks(filing)];
  },
};
