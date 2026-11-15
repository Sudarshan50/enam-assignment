import { combine, derived, reader, reported, requiredConcepts } from "./facts";
import { indAsChecks } from "./indAsChecks";
import type { MetricStrategy } from "./strategy";

const REQUIRED = [
  "RevenueFromOperations",
  "InterestEarned",
  "FinanceCosts",
  "ImpairmentOnFinancialInstruments",
  "ProfitBeforeExceptionalItemsAndTax",
  "ProfitBeforeTax",
  "ProfitLossForPeriod",
];

export const nbfcStrategy: MetricStrategy = {
  family: "nbfc",
  cardMetricKeys: ["nii", "ppop", "pbt", "pat"],
  margin: null,
  ebitdaDefinition: null,

  headline(filing, context) {
    const f = reader(filing, context);
    const metrics = [
      reported("revenue", "Revenue", f, "RevenueFromOperations"),
      derived("nii", "NII", combine([[1, f("InterestEarned")], [-1, f("FinanceCosts")]]), ["InterestEarned", "FinanceCosts"]),
      derived(
        "ppop",
        "PPOP",
        combine([[1, f("ProfitBeforeExceptionalItemsAndTax")], [1, f("ImpairmentOnFinancialInstruments")]]),
        ["ProfitBeforeExceptionalItemsAndTax", "ImpairmentOnFinancialInstruments"],
      ),
      reported("provisions", "Impairment on financial instruments", f, "ImpairmentOnFinancialInstruments"),
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
