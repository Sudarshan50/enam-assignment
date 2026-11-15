import type { IdentityCheck, ParsedFiling } from "../types";
import { closest, combine, compact, durationContexts, identityChecker, reader } from "./facts";

/** Statement identities shared by the Ind AS templates (industrial and NBFC). */
export function indAsChecks(filing: ParsedFiling): IdentityCheck[] {
  const identity = identityChecker(filing);
  return durationContexts(filing).flatMap((ctx) => {
    const f = reader(filing, ctx);
    const zero = (c: string) => f(c) ?? 0;
    const pat = f("ProfitLossForPeriod");
    const patBeforeAssociates = combine([
      [1, f("ProfitBeforeTax")],
      [-1, f("TaxExpense")],
      [1, zero("ProfitLossFromDiscontinuedOperationsAfterTax")],
      [1, zero("NetMovementInRegulatoryDeferralAccountBalancesRelatedToProfitOrLossAndTheRelatedDeferredTaxMovement")],
    ]);
    const patWithAssociates = combine([
      [1, patBeforeAssociates],
      [1, zero("ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod")],
    ]);
    const owners = f("ProfitOrLossAttributableToOwnersOfParent");

    return compact([
      identity(`${ctx}: total income = revenue + other income`, combine([[1, f("RevenueFromOperations")], [1, f("OtherIncome")]]), f("Income")),
      identity(`${ctx}: profit before exceptional items = income - expenses`, combine([[1, f("Income")], [-1, f("Expenses")]]), f("ProfitBeforeExceptionalItemsAndTax")),
      identity(
        `${ctx}: PBT = profit before exceptional items + exceptional items`,
        combine([[1, f("ProfitBeforeExceptionalItemsAndTax")], [1, zero("ExceptionalItemsBeforeTax")]]),
        f("ProfitBeforeTax"),
      ),
      // Some filers already include associates above PBT, so either placement is accepted.
      identity(`${ctx}: PAT = PBT - tax (+ discontinued ops, associates)`, closest(pat, [patWithAssociates, patBeforeAssociates]), pat),
      owners === null
        ? null
        : identity(
            `${ctx}: PAT = owners' share + non-controlling interests`,
            combine([[1, owners], [1, zero("ProfitOrLossAttributableToNonControllingInterests")]]),
            pat,
          ),
    ]);
  });
}
