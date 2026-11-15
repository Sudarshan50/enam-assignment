import type { ParsedFiling, XbrlContext } from "../types";
import { CORE_CONTEXTS, readXbrlDocument, XbrlParseError } from "./document";
import { detectTaxonomy } from "./family";

export interface ParseXbrlOptions {
  /** Used only when the filing omits NatureOfReportStandaloneConsolidated (e.g. taken from the NSE index row). */
  fallbackBasis?: ParsedFiling["basis"];
}

export function parseIntegratedXbrl(xml: string, options: ParseXbrlOptions = {}): ParsedFiling {
  const doc = readXbrlDocument(xml);
  const quarter = doc.contexts.OneD;
  if (!quarter?.start || !quarter.end) throw new XbrlParseError("Filing has no OneD (quarter) context");

  const byContext = Object.fromEntries(CORE_CONTEXTS.map((c) => [c, {}])) as Record<XbrlContext, Record<string, number>>;
  for (const f of doc.numeric) byContext[f.context][f.concept] = f.value;

  const meta = doc.text.OneD ?? {};
  const { family, taxonomy } = detectTaxonomy(xml, byContext.OneD);

  return {
    statementFamily: family,
    basis: parseBasis(meta.NatureOfReportStandaloneConsolidated) ?? requireFallback(options.fallbackBasis),
    // Exact match: "Unaudited" / "Un-Audited" are non-empty strings and must not read as audited.
    audited: meta.WhetherResultsAreAuditedOrUnaudited === "Audited",
    periodStart: quarter.start,
    periodEnd: quarter.end,
    ytdStart: doc.contexts.FourD?.start ?? null,
    currency: meta.DescriptionOfPresentationCurrency || "INR",
    facts: doc.numeric,
    byContext,
    taxonomy,
    symbol: meta.Symbol ?? null,
    companyName: meta.NameOfTheCompany ?? meta.NameOfBank ?? null,
  };
}

function parseBasis(value: string | undefined): ParsedFiling["basis"] | null {
  const v = value?.trim().toLowerCase();
  return v === "consolidated" ? "consolidated" : v === "standalone" ? "standalone" : null;
}

function requireFallback(basis: ParsedFiling["basis"] | undefined): ParsedFiling["basis"] {
  if (!basis) throw new XbrlParseError("Filing does not state standalone/consolidated and no fallback basis was given");
  return basis;
}

export { XbrlParseError };
