import type { ParsedFiling } from "../types";
import { combine, compact, derived, durationContexts, identityChecker, reader, reported, requiredConcepts, type FactReader } from "./facts";
import type { MetricStrategy } from "./strategy";

const AFTER_MINORITY = "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates";

const REQUIRED = [
  "InterestEarned",
  "InterestExpended",
  "OperatingProfitBeforeProvisionAndContingencies",
  "ProvisionsOtherThanTaxAndContingencies",
  "ProfitLossFromOrdinaryActivitiesBeforeTax",
  "ProfitLossForThePeriod",
];

/** Consolidated bank PAT is the after-minority line, which matches what banks headline. */
function patConcept(filing: ParsedFiling, f: FactReader): string {
  return filing.basis === "consolidated" && f(AFTER_MINORITY) !== null ? AFTER_MINORITY : "ProfitLossForThePeriod";
}

export const bankingStrategy: MetricStrategy = {
  family: "banking",
  cardMetricKeys: ["nii", "ppop", "pbt", "pat"],
  margin: null,
  ebitdaDefinition: null,

  headline(filing, context) {
    const f = reader(filing, context);
    return [
      derived("nii", "NII", combine([[1, f("InterestEarned")], [-1, f("InterestExpended")]]), ["InterestEarned", "InterestExpended"]),
      reported("ppop", "PPOP", f, "OperatingProfitBeforeProvisionAndContingencies"),
      reported("provisions", "Provisions", f, "ProvisionsOtherThanTaxAndContingencies"),
      reported("pbt", "PBT", f, "ProfitLossFromOrdinaryActivitiesBeforeTax"),
      reported("pat", "PAT", f, patConcept(filing, f)),
      reported("total_income", "Total income", f, "Income"),
    ];
  },

  checks(filing) {
    const identity = identityChecker(filing);
    const perContext = durationContexts(filing).flatMap((ctx) => {
      const f = reader(filing, ctx);
      const zero = (c: string) => f(c) ?? 0;
      const ppop = f("OperatingProfitBeforeProvisionAndContingencies");
      const pbt = f("ProfitLossFromOrdinaryActivitiesBeforeTax");
      const pat = f("ProfitLossForThePeriod");
      return compact([
        identity(`${ctx}: total income = interest earned + other income`, combine([[1, f("InterestEarned")], [1, f("OtherIncome")]]), f("Income")),
        identity(
          `${ctx}: PPOP = total income - expenditure excl. provisions`,
          combine([[1, f("Income")], [-1, f("ExpenditureExcludingProvisionsAndContingencies")]]),
          ppop,
        ),
        identity(
          `${ctx}: PBT = PPOP - provisions + exceptional items`,
          combine([[1, ppop], [-1, f("ProvisionsOtherThanTaxAndContingencies")], [1, zero("ExceptionalItems")]]),
          pbt,
        ),
        identity(`${ctx}: PAT = PBT - tax + extraordinary items`, combine([[1, pbt], [-1, f("TaxExpense")], [1, zero("ExtraordinaryItems")]]), pat),
        identity(
          `${ctx}: PAT after minority = PAT - minority interest + associates`,
          combine([[1, pat], [-1, zero("ProfitLossOfMinorityInterest")], [1, zero("ShareOfProfitLossOfAssociates")]]),
          f(AFTER_MINORITY),
        ),
      ]);
    });
    return [requiredConcepts(filing, REQUIRED), ...perContext];
  },
};
