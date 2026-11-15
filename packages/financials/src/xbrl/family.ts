import type { StatementFamily } from "@finn/shared/taxonomy";

const FAMILY_BY_TAXONOMY: Record<string, StatementFamily> = {
  IndAS: "industrial",
  Banking: "banking",
  NBFC: "nbfc",
};

export interface TaxonomyInfo {
  family: StatementFamily;
  /** e.g. "IntegratedFinance_Banking/2026-01-31". */
  taxonomy: string;
}

/**
 * The entry-point namespace names the SEBI template
 * (http://www.sebi.gov.in/xbrl/IntegratedFinance_<IndAS|Banking|NBFC>/<date>/...).
 * Falls back to concepts unique to each template when the namespace is unrecognised.
 */
export function detectTaxonomy(xml: string, oneDConcepts: Record<string, number>): TaxonomyInfo {
  const head = xml.slice(0, 4096);
  const m = /IntegratedFinance_([A-Za-z]+)\/(\d{4}-\d{2}-\d{2})/.exec(head);
  const byNamespace = m ? FAMILY_BY_TAXONOMY[m[1]!] : undefined;
  if (m && byNamespace) return { family: byNamespace, taxonomy: `IntegratedFinance_${m[1]}/${m[2]}` };
  return { family: familyFromConcepts(oneDConcepts), taxonomy: m ? `IntegratedFinance_${m[1]}/${m[2]}` : "unknown" };
}

function familyFromConcepts(concepts: Record<string, number>): StatementFamily {
  if ("OperatingProfitBeforeProvisionAndContingencies" in concepts || "InterestExpended" in concepts) return "banking";
  if ("ImpairmentOnFinancialInstruments" in concepts && "InterestEarned" in concepts) return "nbfc";
  return "industrial";
}
