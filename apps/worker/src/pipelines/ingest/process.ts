import { classifyByRules, needsLlmFallback } from "@finn/domain/classify/rules";
import { clusterKey, inferPeriodEnd } from "@finn/domain/cluster/clusterKey";
import { scoreAnnouncement } from "@finn/domain/score/score";
import type { AnnouncementRow, AnnouncementsRepo, CategorySource } from "@finn/db/repositories/announcements";
import type { CategoryWeights } from "@finn/db/repositories/prefs";
import type { Card } from "@finn/shared/contracts/cards";
import { ENRICHED_CATEGORIES, type Category, type Tier } from "@finn/shared/taxonomy";
import { extractPdfPages } from "@finn/sources/pdf/extract";
import type { WorkerContext } from "../../context";

export const MAX_ATTEMPTS = 3;
const PDF_PAGES = 6;
const ATTACHMENT_TEXT_CHARS = 16_000;

export interface ProcessedAnnouncement {
  seqId: string;
  symbol: string;
  category: Category;
  tier: Tier;
  clusterKey: string;
  previousClusterKey: string | null;
  periodEnd: string | null;
  status: "ready" | "failed";
  headline: string;
  oneLiner: string | null;
  publishedAt: Date;
}

interface Classified {
  category: Category;
  confidence: number;
  source: CategorySource;
  reasonCodes: string[];
  impact: number | null;
  oneLiner: string | null;
  pinned: "act" | null;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function firstSentence(text: string | null): string | null {
  if (!text) return null;
  const m = /^(.{20,280}?[.!?])(\s|$)/s.exec(text.trim());
  return (m?.[1] ?? text.trim().slice(0, 240)).trim() || null;
}

/** Rules first; the LLM only when the rules are unsure. An LLM failure keeps the rule result. */
async function classify(ctx: WorkerContext, row: AnnouncementRow): Promise<Classified> {
  const rule = classifyByRules({ subject: row.subject, text: row.headline, exchangeSummary: row.bodyText });
  const result: Classified = {
    category: rule.category,
    confidence: rule.confidence,
    source: "rule",
    reasonCodes: [...rule.reasonCodes],
    impact: null,
    oneLiner: null,
    pinned: rule.pinned,
  };
  if (!needsLlmFallback(rule)) return result;
  try {
    const llm = await ctx.classifier.classify({
      symbol: row.symbol,
      companyName: row.companyName,
      subject: row.subject,
      text: row.headline,
      exchangeSummary: row.bodyText,
    });
    result.category = llm.category;
    result.confidence = llm.confidence;
    result.source = "llm_text";
    result.impact = llm.impact;
    result.oneLiner = llm.oneLiner || null;
    result.reasonCodes.push(...llm.reasonCodes.map((r) => `llm:${r}`));
  } catch (err) {
    result.source = "fallback";
    result.reasonCodes.push("llm_unavailable");
    ctx.log.warn({ seqId: row.seqId, error: errorMessage(err) }, "LLM classifier failed; keeping rule result");
  }
  return result;
}

async function attachmentText(ctx: WorkerContext, row: AnnouncementRow): Promise<string | null> {
  if (!row.pdfUrl || !/\.pdf($|\?)/i.test(row.pdfUrl) || !ctx.http.isAllowed(row.pdfUrl)) return null;
  try {
    const buf = await ctx.http.getBuffer(row.pdfUrl);
    const pages = await extractPdfPages(buf, { maxPages: PDF_PAGES });
    const text = pages.map((p) => `[page ${p.page}]\n${p.text}`).join("\n\n").slice(0, ATTACHMENT_TEXT_CHARS);
    return text.trim() ? text : null;
  } catch (err) {
    ctx.log.warn({ seqId: row.seqId, error: errorMessage(err) }, "Attachment PDF unavailable; enriching from text only");
    return null;
  }
}

/**
 * Classifies, scores and routes one announcement. Results wait for the results pipeline (status ready,
 * card attached later); enriched categories get a typed card from the PDF; everything else a generic card.
 */
export async function processAnnouncement(
  ctx: WorkerContext,
  repo: AnnouncementsRepo,
  row: AnnouncementRow,
  weights: CategoryWeights,
): Promise<ProcessedAnnouncement> {
  const c = await classify(ctx, row);
  const { score, tier } = scoreAnnouncement({ category: c.category, userWeight: weights[c.category] ?? null, impact: c.impact, pinned: c.pinned });
  const periodEnd = c.category === "results" ? inferPeriodEnd(`${row.headline}\n${row.bodyText ?? ""}`, row.publishedAt) : null;
  const key = clusterKey({ symbol: row.symbol, category: c.category, publishedAt: row.publishedAt, periodEnd });
  const oneLiner = c.oneLiner ?? row.oneLiner ?? firstSentence(row.bodyText);

  await repo.saveClassification(row.seqId, {
    category: c.category,
    confidence: c.confidence,
    source: c.source,
    reasonCodes: c.reasonCodes,
    score,
    tier,
    clusterKey: key,
    oneLiner,
  });
  const attempts = row.attempts + 1;
  const base = {
    seqId: row.seqId,
    symbol: row.symbol,
    category: c.category,
    tier,
    clusterKey: key,
    previousClusterKey: row.clusterKey && row.clusterKey !== key ? row.clusterKey : null,
    periodEnd,
    headline: row.headline,
    oneLiner,
    publishedAt: row.publishedAt,
  };

  if (c.category === "results") {
    await repo.markStatus(row.seqId, "ready");
    return { ...base, status: "ready" };
  }

  let card: Card = { kind: "generic", oneLiner };
  let enrichmentError: string | null = null;
  if (ENRICHED_CATEGORIES.has(c.category)) {
    try {
      const enriched = await ctx.enricher.enrich({
        seqId: row.seqId,
        symbol: row.symbol,
        companyName: row.companyName,
        category: c.category,
        subject: row.subject,
        text: row.headline,
        exchangeSummary: row.bodyText,
        attachmentText: await attachmentText(ctx, row),
        attachmentUrl: row.pdfUrl,
        publishedAt: row.publishedAt,
      });
      if (enriched) card = enriched;
    } catch (err) {
      const error = errorMessage(err);
      if (attempts < MAX_ATTEMPTS) enrichmentError = `enrichment: ${error}`;
      ctx.log.warn({ seqId: row.seqId, attempts, error }, attempts < MAX_ATTEMPTS ? "Enrichment failed; generic card now, retry next poll" : "Enrichment failed on final attempt; keeping generic card");
    }
  }
  await repo.saveCard(row.seqId, card, "ready", enrichmentError);
  return { ...base, status: "ready" };
}
