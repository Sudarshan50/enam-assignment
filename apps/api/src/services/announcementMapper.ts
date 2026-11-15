import {
  type Card,
  CardSchema,
  type Category,
  CategorySchema,
  type DigestItem,
  TIER_THRESHOLDS,
  type Tier,
  TierSchema,
} from "@finn/shared";
import type { Logger } from "../lib/logger";
import { toIsoRequired } from "../lib/time";

/** One announcement row as the read models return it. */
export interface AnnouncementRow {
  seqId: string;
  symbol: string;
  companyName: string;
  headline: string;
  oneLiner: string | null;
  publishedAt: Date;
  pdfUrl: string | null;
  category: string | null;
  tier: string | null;
  score: number | null;
  reasonCodes: string[];
  card: unknown;
  parentSeqId: string | null;
  status: string;
  /** Opened, dismissed or pinned at least once. */
  read: boolean;
  /** Latest dismiss/undo interaction is a dismiss. */
  dismissed: boolean;
}

export function toCategory(value: string | null): Category {
  const parsed = CategorySchema.safeParse(value);
  return parsed.success ? parsed.data : "unclassified";
}

export function toTier(value: string | null, score: number): Tier {
  const parsed = TierSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return score >= TIER_THRESHOLDS.act ? "act" : score >= TIER_THRESHOLDS.know ? "know" : "noise";
}

export function toCard(value: unknown, seqId: string, log?: Logger): Card | null {
  if (value == null) return null;
  const parsed = CardSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn({ seqId, issues: parsed.error.issues.slice(0, 3) }, "stored card does not match CardSchema; omitting it");
  return null;
}

export function toLinked(rows: AnnouncementRow[]): DigestItem["linked"] {
  return [...rows]
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())
    .map((r) => ({ seqId: r.seqId, headline: r.headline, pdfUrl: r.pdfUrl, publishedAt: toIsoRequired(r.publishedAt) }));
}

export function toDigestItem(row: AnnouncementRow, children: AnnouncementRow[], log?: Logger): DigestItem {
  const score = row.score ?? 0;
  return {
    id: row.seqId,
    symbol: row.symbol,
    companyName: row.companyName,
    category: toCategory(row.category),
    tier: toTier(row.tier, score),
    score,
    reasonCodes: row.reasonCodes,
    headline: row.headline,
    oneLiner: row.oneLiner,
    publishedAt: toIsoRequired(row.publishedAt),
    pdfUrl: row.pdfUrl,
    card: toCard(row.card, row.seqId, log),
    linked: toLinked(children),
  };
}
