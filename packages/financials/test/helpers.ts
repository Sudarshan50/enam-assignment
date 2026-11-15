import { readFileSync, readdirSync } from "node:fs";
import { parseIntegratedXbrl } from "../src/xbrl/parse";
import type { ParsedFiling } from "../src/types";

const dir = new URL("./fixtures/", import.meta.url);

export const FIXTURE_FILES = readdirSync(dir).filter((f) => f.endsWith(".xml")).sort();

export function readXml(name: string): string {
  return readFileSync(new URL(name, dir), "utf8");
}

export function filing(symbol: string, quarter: string): ParsedFiling {
  return parseIntegratedXbrl(readXml(`${symbol}_${quarter}_consolidated.xml`));
}

/** Crore -> rupees, for readable expectations. */
export const cr = (n: number) => Math.round(n * 1e7);

export interface SyntheticXbrlOptions {
  /** Taxonomy segment of the entry-point namespace: IndAS, Banking, NBFC, or anything else. */
  taxonomy: string;
  periodStart: string;
  periodEnd: string;
  ytdStart?: string;
  /** Values in crore; written as rupees. */
  oneD: Record<string, number>;
  fourD?: Record<string, number>;
  /** null omits NatureOfReportStandaloneConsolidated. */
  basis?: "Consolidated" | "Standalone" | null;
  audited?: string;
  decimals?: string;
  meta?: Record<string, string>;
  /** Raw XML inserted before </xbrli:xbrl>. */
  extra?: string;
}

/** Minimal SEBI integrated-filing instance with the core contexts and the given facts. */
export function syntheticXbrl(o: SyntheticXbrlOptions): string {
  const entity = `<xbrli:entity><xbrli:identifier scheme="http://www.sebi.gov.in/in-capmkt/ScripCode">999999</xbrli:identifier></xbrli:entity>`;
  const duration = (id: string, start: string, end: string) =>
    `<xbrli:context id="${id}">${entity}<xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
  const facts = (ctx: string, values: Record<string, number>) =>
    Object.entries(values)
      .map(([c, v]) => `<in-capmkt:${c} contextRef="${ctx}" decimals="${o.decimals ?? "-7"}" unitRef="INR">${cr(v)}</in-capmkt:${c}>`)
      .join("");
  const meta: Record<string, string> = {
    Symbol: "ACME",
    NameOfTheCompany: "Acme Limited",
    WhetherResultsAreAuditedOrUnaudited: o.audited ?? "Unaudited",
    ...(o.basis === null ? {} : { NatureOfReportStandaloneConsolidated: o.basis ?? "Consolidated" }),
    ...o.meta,
  };
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-capmkt="http://www.sebi.gov.in/xbrl/2026-01-31/in-capmkt"`,
    ` xmlns:in-capmkt-ent="http://www.sebi.gov.in/xbrl/IntegratedFinance_${o.taxonomy}/2026-01-31/in-capmkt/in-capmkt-ent">`,
    `<link:schemaRef xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="x.xsd" xlink:type="simple"/>`,
    duration("OneD", o.periodStart, o.periodEnd),
    `<xbrli:context id="OneI">${entity}<xbrli:period><xbrli:instant>${o.periodEnd}</xbrli:instant></xbrli:period></xbrli:context>`,
    o.ytdStart ? duration("FourD", o.ytdStart, o.periodEnd) : "",
    `<xbrli:unit id="INR"><xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>`,
    Object.entries(meta)
      .map(([k, v]) => `<in-capmkt:${k} contextRef="OneD">${v}</in-capmkt:${k}>`)
      .join(""),
    facts("OneD", o.oneD),
    o.fourD ? facts("FourD", o.fourD) : "",
    o.extra ?? "",
    `</xbrli:xbrl>`,
  ].join("\n");
}

/** Reconciling industrial quarter, in crore. EBITDA = 250 + 20 + 30 - 50 = 250. */
export const INDUSTRIAL_Q = {
  RevenueFromOperations: 1000,
  OtherIncome: 50,
  Income: 1050,
  Expenses: 800,
  FinanceCosts: 20,
  DepreciationDepletionAndAmortisationExpense: 30,
  ProfitBeforeExceptionalItemsAndTax: 250,
  ExceptionalItemsBeforeTax: -10,
  ProfitBeforeTax: 240,
  TaxExpense: 60,
  ProfitLossForPeriod: 180,
  ProfitOrLossAttributableToOwnersOfParent: 175,
  ProfitOrLossAttributableToNonControllingInterests: 5,
};

/** Reconciling bank quarter, in crore. NII = 400, PPOP = 300. */
export const BANKING_Q = {
  InterestEarned: 1000,
  OtherIncome: 200,
  Income: 1200,
  InterestExpended: 600,
  ExpenditureExcludingProvisionsAndContingencies: 900,
  OperatingProfitBeforeProvisionAndContingencies: 300,
  ProvisionsOtherThanTaxAndContingencies: 100,
  ProfitLossFromOrdinaryActivitiesBeforeTax: 200,
  TaxExpense: 50,
  ProfitLossForThePeriod: 150,
  ProfitLossOfMinorityInterest: 10,
  ShareOfProfitLossOfAssociates: 5,
  ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates: 145,
};

/** Reconciling NBFC quarter, in crore. NII = 900 - 400 = 500, PPOP = 400 + 100 = 500. */
export const NBFC_Q = {
  RevenueFromOperations: 1000,
  InterestEarned: 900,
  OtherIncome: 10,
  Income: 1010,
  FinanceCosts: 400,
  ImpairmentOnFinancialInstruments: 100,
  Expenses: 610,
  ProfitBeforeExceptionalItemsAndTax: 400,
  ProfitBeforeTax: 400,
  TaxExpense: 100,
  ProfitLossForPeriod: 300,
};
