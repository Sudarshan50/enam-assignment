import { createHash } from "node:crypto";
import { clusterKey } from "@finn/domain/cluster/clusterKey";
import { announcementsRepo } from "@finn/db/repositories/announcements";
import { companiesRepo } from "@finn/db/repositories/companies";
import { filingsRepo, type FactContext, type FactUpsert } from "@finn/db/repositories/filings";
import { buildResultsCard } from "@finn/financials/results/buildResultsCard";
import type { ParsedFiling } from "@finn/financials/types";
import { parseIntegratedXbrl } from "@finn/financials/xbrl/parse";
import type { ResultsCard } from "@finn/shared/contracts/cards";
import { fiscalQuarterLabel } from "@finn/shared/format";
import type { StatementFamily } from "@finn/shared/taxonomy";
import { fetchXbrl, latestPeriodEnd, listIntegratedFilings, selectFilingsForCard } from "@finn/sources/nse/integratedFilings";
import type { IntegratedFilingRef } from "@finn/sources/types";
import { argIsoDate, requireString } from "../../args";
import type { Command, WorkerContext } from "../../context";

export const RESULTS_PARSER_VERSION = 1;
const FACT_CONTEXTS: readonly FactContext[] = ["OneD", "FourD", "OneI", "PY_I"];

export type ResultsOutcome = "ready" | "under_review" | "not_filed_yet" | "no_filings";

export interface ResultsRunSummary {
  symbol: string;
  periodEnd: string | null;
  outcome: ResultsOutcome;
  basis: "consolidated" | "standalone" | null;
  filingsParsed: number;
  factsWritten: number;
  announcementsUpdated: number;
}

/** Balance-sheet "previous year" instant: the March 31 that opened the fiscal year. */
function previousFyEnd(periodEnd: string): string {
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  return `${m <= 3 ? y - 1 : y}-03-31`;
}

function factsFor(parsed: ParsedFiling): FactUpsert[] {
  const window: Record<FactContext, { start: string | null; end: string }> = {
    OneD: { start: parsed.periodStart, end: parsed.periodEnd },
    FourD: { start: parsed.ytdStart, end: parsed.periodEnd },
    OneI: { start: null, end: parsed.periodEnd },
    PY_I: { start: null, end: previousFyEnd(parsed.periodEnd) },
  };
  return parsed.facts
    .filter((f) => FACT_CONTEXTS.includes(f.context))
    .map((f) => ({
      concept: f.concept,
      context: f.context,
      periodStart: window[f.context].start,
      periodEnd: window[f.context].end,
      value: f.value,
      unit: f.unit ?? "INR",
      derived: false,
    }));
}

/** Placeholder card for a results announcement whose XBRL isn't on NSE yet; never asks a model for numbers. */
export function placeholderCard(input: {
  periodEnd: string;
  status: "not_filed_yet" | "under_review";
  basis?: "consolidated" | "standalone";
  statementFamily: StatementFamily;
  audited?: boolean;
}): ResultsCard {
  return {
    kind: "results",
    periodEnd: input.periodEnd,
    periodLabel: fiscalQuarterLabel(input.periodEnd),
    basis: input.basis ?? "consolidated",
    statementFamily: input.statementFamily,
    audited: input.audited ?? false,
    status: input.status,
    metrics: [],
    marginBps: null,
    read: null,
    ebitdaDefinition: null,
  };
}

interface LoadedFiling {
  parsed: ParsedFiling | null;
  facts: number;
}

/** Fetch, hash, parse and persist one filing. Parse failures mark the filing failed and leave earlier facts alone. */
async function loadFiling(ctx: WorkerContext, ref: IntegratedFilingRef): Promise<LoadedFiling> {
  const filings = filingsRepo(ctx.sql);
  const base = {
    seqId: ref.seqId,
    symbol: ref.symbol,
    periodEnd: ref.periodEnd,
    basis: ref.basis,
    statementFamily: ref.statementFamily,
    audited: ref.audited,
    revision: ref.revision,
    broadcastAt: ref.broadcastAt,
    xbrlUrl: ref.xbrlUrl,
    parserVersion: RESULTS_PARSER_VERSION,
  };
  let xml: string;
  try {
    xml = await fetchXbrl(ctx.http, ref.xbrlUrl);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await filings.upsertFiling({ ...base, periodStart: null, taxonomy: "unknown", sha256: null, status: "failed", error });
    throw err;
  }
  const sha256 = createHash("sha256").update(xml).digest("hex");
  try {
    const parsed = parseIntegratedXbrl(xml, { fallbackBasis: ref.basis });
    await filings.upsertFiling({
      ...base,
      periodStart: parsed.periodStart,
      basis: parsed.basis,
      statementFamily: parsed.statementFamily,
      audited: parsed.audited,
      taxonomy: parsed.taxonomy ?? "unknown",
      sha256,
      status: "parsed",
      error: null,
    });
    const facts = await filings.upsertFacts(ref.seqId, factsFor(parsed));
    return { parsed, facts };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.log.warn({ seqId: ref.seqId, symbol: ref.symbol, error }, "XBRL parse failed");
    const existing = await filings.get(ref.seqId);
    if (existing?.status === "parsed") await filings.markFailed(ref.seqId, error);
    else await filings.upsertFiling({ ...base, periodStart: null, taxonomy: "unknown", sha256, status: "failed", error });
    return { parsed: null, facts: 0 };
  }
}

/**
 * Builds the results card for (symbol, period) from exchange XBRL and attaches it to the matching
 * results announcements. Idempotent: filings upsert on seq id, facts on (filing, concept, context),
 * and the card is overwritten in place.
 */
export async function runResults(ctx: WorkerContext, opts: { symbol: string; period?: string }): Promise<ResultsRunSummary> {
  const symbol = opts.symbol.toUpperCase();
  const companies = companiesRepo(ctx.sql);
  const company = await companies.get(symbol);
  if (!company) throw new Error(`Unknown symbol ${symbol}; run master-list or add it to companies first`);

  const refs = await listIntegratedFilings(ctx.http, symbol);
  const periodEnd = opts.period ?? latestPeriodEnd(refs);
  const summary: ResultsRunSummary = {
    symbol,
    periodEnd,
    outcome: "no_filings",
    basis: null,
    filingsParsed: 0,
    factsWritten: 0,
    announcementsUpdated: 0,
  };
  if (!periodEnd) return summary;

  const key = clusterKey({ symbol, category: "results", publishedAt: new Date(), periodEnd });
  const announcements = announcementsRepo(ctx.sql);
  const family = company.statementFamily ?? "industrial";
  const selection = selectFilingsForCard(refs, periodEnd);
  summary.basis = selection.basis;

  if (!selection.current) {
    summary.outcome = "not_filed_yet";
    summary.announcementsUpdated = await announcements.attachResultsCard(key, placeholderCard({ periodEnd, status: "not_filed_yet", statementFamily: family }));
    return summary;
  }

  const current = await loadFiling(ctx, selection.current);
  summary.factsWritten += current.facts;
  if (!current.parsed) {
    summary.outcome = "under_review";
    summary.announcementsUpdated = await announcements.attachResultsCard(
      key,
      placeholderCard({ periodEnd, status: "under_review", basis: selection.basis, statementFamily: selection.current.statementFamily, audited: selection.current.audited }),
    );
    return summary;
  }
  summary.filingsParsed++;

  const comparison = async (ref: IntegratedFilingRef | null): Promise<ParsedFiling | null> => {
    if (!ref) return null;
    try {
      const loaded = await loadFiling(ctx, ref);
      summary.factsWritten += loaded.facts;
      if (loaded.parsed) summary.filingsParsed++;
      return loaded.parsed;
    } catch (err) {
      ctx.log.warn({ seqId: ref.seqId, error: err instanceof Error ? err.message : String(err) }, "Comparison filing unavailable");
      return null;
    }
  };
  const previousQuarter = await comparison(selection.previousQuarter);
  const yearAgoQuarter = await comparison(selection.yearAgoQuarter);

  const card = buildResultsCard({ current: current.parsed, previousQuarter, yearAgoQuarter, sourceRef: selection.current.xbrlUrl });
  await companies.setStatementFamily(symbol, current.parsed.statementFamily);
  summary.outcome = card.status === "ready" ? "ready" : card.status === "under_review" ? "under_review" : "not_filed_yet";
  summary.announcementsUpdated = await announcements.attachResultsCard(key, card);
  return summary;
}

export const resultsCommand: Command = {
  name: "results",
  description: "Fetch and parse integrated-filing XBRL for a symbol and attach the results card (--symbol X [--period YYYY-MM-DD])",
  async run(ctx, args) {
    const summary = await runResults(ctx, { symbol: requireString(args, "symbol"), period: argIsoDate(args, "period") });
    ctx.log.info(summary, "Results processed");
  },
};

export const resultsBackfillCommand: Command = {
  name: "results-backfill",
  description: "Latest-quarter results for every holding",
  async run(ctx) {
    const symbols = await companiesRepo(ctx.sql).listHoldingSymbols();
    const failures: string[] = [];
    for (const symbol of symbols) {
      try {
        const summary = await runResults(ctx, { symbol });
        ctx.log.info(summary, "Results processed");
      } catch (err) {
        failures.push(symbol);
        ctx.log.error({ symbol, error: err instanceof Error ? err.message : String(err) }, "Results failed");
      }
    }
    if (failures.length) throw new Error(`results-backfill failed for ${failures.join(", ")}`);
  },
};
