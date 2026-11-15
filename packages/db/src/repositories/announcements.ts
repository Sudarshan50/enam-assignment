import type postgres from "postgres";
import type { Card } from "@finn/shared/contracts/cards";
import type { Category, Tier } from "@finn/shared/taxonomy";
import type { Sql } from "../client";

export type AnnouncementStatus = "raw" | "classified" | "enriched" | "ready" | "failed" | "review";
export type CategorySource = "rule" | "llm_text" | "llm_pdf" | "fallback";

export interface NewAnnouncement {
  seqId: string;
  symbol: string;
  /** NSE subject bucket; kept inside `raw` as `desc` (the original feed field). */
  subject: string;
  headline: string;
  bodyText: string | null;
  pdfUrl: string | null;
  publishedAt: Date;
  raw: Record<string, unknown>;
}

export interface AnnouncementRow {
  seqId: string;
  symbol: string;
  companyName: string;
  subject: string;
  headline: string;
  bodyText: string | null;
  pdfUrl: string | null;
  publishedAt: Date;
  category: Category | null;
  categoryConfidence: number | null;
  categorySource: CategorySource | null;
  score: number | null;
  reasonCodes: string[];
  tier: Tier | null;
  clusterKey: string | null;
  parentSeqId: string | null;
  oneLiner: string | null;
  card: Card | null;
  status: AnnouncementStatus;
  error: string | null;
  attempts: number;
}

export interface ClassificationUpdate {
  category: Category;
  confidence: number;
  source: CategorySource;
  reasonCodes: string[];
  score: number;
  tier: Tier;
  clusterKey: string;
  oneLiner: string | null;
}

export interface ClusterMemberRow {
  seqId: string;
  score: number | null;
  publishedAt: Date;
}

export interface CorporateActionRow {
  symbol: string;
  publishedAt: Date;
  /** From a corporate_action card, when enrichment extracted one. */
  recordDate: string | null;
  /** Exchange text and summary. */
  text: string;
}

const json = (sql: Sql, value: unknown) => sql.json(value as postgres.JSONValue);

export function announcementsRepo(sql: Sql) {
  const columns = () => sql`
    a.seq_id AS "seqId", a.symbol, c.name AS "companyName",
    COALESCE(a.raw->>'desc', a.raw->>'subject', '') AS subject,
    a.headline, a.body_text AS "bodyText", a.pdf_url AS "pdfUrl", a.published_at AS "publishedAt",
    a.category, a.category_confidence AS "categoryConfidence", a.category_source AS "categorySource",
    a.score, a.reason_codes AS "reasonCodes", a.tier, a.cluster_key AS "clusterKey", a.parent_seq_id AS "parentSeqId",
    a.one_liner AS "oneLiner", a.card, a.status, a.error, a.attempts`;

  return {
    /**
     * Idempotent on seq_id. Existing rows only get their raw payload refreshed (NSE sometimes fixes an
     * attachment link); classification and cards are left alone. Returns seq ids that were new.
     */
    async upsertRaw(rows: readonly NewAnnouncement[]): Promise<string[]> {
      const inserted: string[] = [];
      for (const r of rows) {
        const raw = { ...r.raw, desc: r.raw.desc ?? r.subject };
        const [res] = await sql<{ seq_id: string; inserted: boolean }[]>`
          INSERT INTO announcements (seq_id, symbol, headline, body_text, pdf_url, published_at, raw)
          VALUES (${r.seqId}, ${r.symbol}, ${r.headline}, ${r.bodyText}, ${r.pdfUrl}, ${r.publishedAt}, ${json(sql, raw)})
          ON CONFLICT (seq_id) DO UPDATE SET
            raw = EXCLUDED.raw,
            pdf_url = COALESCE(EXCLUDED.pdf_url, announcements.pdf_url),
            body_text = COALESCE(EXCLUDED.body_text, announcements.body_text),
            updated_at = now()
          WHERE announcements.raw IS DISTINCT FROM EXCLUDED.raw
          RETURNING seq_id, (xmax = 0) AS inserted`;
        if (res?.inserted) inserted.push(res.seq_id);
      }
      return inserted;
    },

    async get(seqId: string): Promise<AnnouncementRow | null> {
      const [row] = await sql<AnnouncementRow[]>`
        SELECT ${columns()} FROM announcements a JOIN companies c ON c.symbol = a.symbol WHERE a.seq_id = ${seqId}`;
      return row ?? null;
    },

    /**
     * Work queue for the ingest pipeline: new rows, retryable failures, and recent rows that were
     * published in a degraded form (rule-only category or generic card because the LLM was down).
     */
    async listPending(opts: { limit?: number; maxAttempts?: number } = {}): Promise<AnnouncementRow[]> {
      const limit = opts.limit ?? 300;
      const maxAttempts = opts.maxAttempts ?? 3;
      return sql<AnnouncementRow[]>`
        SELECT ${columns()} FROM announcements a JOIN companies c ON c.symbol = a.symbol
        WHERE a.attempts < ${maxAttempts}
          AND (a.status IN ('raw', 'classified', 'enriched', 'failed')
               OR ((a.category_source = 'fallback' OR (a.status = 'ready' AND a.error IS NOT NULL))
                   AND a.published_at > now() - interval '2 days'))
        ORDER BY a.published_at ASC
        LIMIT ${limit}`;
    },

    async saveClassification(seqId: string, c: ClassificationUpdate): Promise<void> {
      await sql`
        UPDATE announcements SET
          category = ${c.category}, category_confidence = ${c.confidence}, category_source = ${c.source},
          reason_codes = ${c.reasonCodes}, score = ${c.score}, tier = ${c.tier}, cluster_key = ${c.clusterKey},
          one_liner = COALESCE(${c.oneLiner}, one_liner),
          status = 'classified', error = NULL, attempts = attempts + 1, updated_at = now()
        WHERE seq_id = ${seqId}`;
    },

    /** A non-null `error` publishes the card but keeps the row in the retry queue (e.g. generic card while the LLM is down). */
    async saveCard(seqId: string, card: Card | null, status: AnnouncementStatus = "ready", error: string | null = null): Promise<void> {
      await sql`
        UPDATE announcements SET card = ${card ? json(sql, card) : null}, status = ${status},
          error = ${error?.slice(0, 1000) ?? null}, updated_at = now()
        WHERE seq_id = ${seqId}`;
    },

    async setOneLiner(seqId: string, oneLiner: string): Promise<void> {
      await sql`UPDATE announcements SET one_liner = ${oneLiner}, updated_at = now() WHERE seq_id = ${seqId}`;
    },

    async markStatus(seqId: string, status: AnnouncementStatus): Promise<void> {
      await sql`UPDATE announcements SET status = ${status}, updated_at = now() WHERE seq_id = ${seqId}`;
    },

    /** `countAttempt` for failures that happened before saveClassification (which counts the attempt itself). */
    async markFailed(seqId: string, error: string, countAttempt = false): Promise<void> {
      await sql`
        UPDATE announcements SET status = 'failed', error = ${error.slice(0, 1000)},
          attempts = attempts + ${countAttempt ? 1 : 0}, updated_at = now()
        WHERE seq_id = ${seqId}`;
    },

    async listClusterMembers(clusterKey: string): Promise<ClusterMemberRow[]> {
      return sql<ClusterMemberRow[]>`
        SELECT seq_id AS "seqId", score, published_at AS "publishedAt"
        FROM announcements WHERE cluster_key = ${clusterKey}`;
    },

    /** Head gets parent NULL; every other member points at it. */
    async setClusterHead(clusterKey: string, headSeqId: string): Promise<void> {
      await sql`
        UPDATE announcements SET
          parent_seq_id = CASE WHEN seq_id = ${headSeqId} THEN NULL ELSE ${headSeqId} END,
          updated_at = now()
        WHERE cluster_key = ${clusterKey}
          AND parent_seq_id IS DISTINCT FROM (CASE WHEN seq_id = ${headSeqId} THEN NULL ELSE ${headSeqId} END)`;
    },

    /** Attaches a results card to every results filing in the (symbol, period) cluster. Returns rows updated. */
    async attachResultsCard(clusterKey: string, card: Card): Promise<number> {
      const res = await sql`
        UPDATE announcements SET card = ${json(sql, card)}, status = 'ready', error = NULL, updated_at = now()
        WHERE cluster_key = ${clusterKey} AND category = 'results'`;
      return res.count ?? 0;
    },

    /** Results clusters whose numbers haven't arrived yet (no card, or the not-filed-yet placeholder). */
    async listResultsAwaitingXbrl(sinceDays = 10): Promise<{ symbol: string; clusterKey: string }[]> {
      return sql<{ symbol: string; clusterKey: string }[]>`
        SELECT DISTINCT symbol, cluster_key AS "clusterKey" FROM announcements
        WHERE category = 'results' AND cluster_key IS NOT NULL
          AND published_at > now() - make_interval(days => ${sinceDays})
          AND (card IS NULL OR card->>'status' = 'not_filed_yet')`;
    },

    /** Filings of a category (bonus/split) published in the window, with whatever dates they carry; drives price-alert suppression. */
    async corporateActionsBetween(category: Category, from: Date, to: Date): Promise<CorporateActionRow[]> {
      return sql<CorporateActionRow[]>`
        SELECT symbol, published_at AS "publishedAt",
               CASE WHEN card->>'kind' = 'corporate_action' THEN card->>'recordDate' END AS "recordDate",
               concat_ws(E'\n', headline, body_text) AS text
        FROM announcements
        WHERE category = ${category} AND published_at >= ${from} AND published_at < ${to}`;
    },

    /** Ready cluster heads in a window: the digest's read model. */
    async listReadyHeads(opts: { from: Date; to: Date; limit?: number }): Promise<AnnouncementRow[]> {
      return sql<AnnouncementRow[]>`
        SELECT ${columns()} FROM announcements a JOIN companies c ON c.symbol = a.symbol
        WHERE a.status = 'ready' AND a.parent_seq_id IS NULL
          AND a.published_at >= ${opts.from} AND a.published_at < ${opts.to}
        ORDER BY a.score DESC NULLS LAST, a.published_at DESC
        LIMIT ${opts.limit ?? 500}`;
    },

    async listChildren(parentSeqIds: readonly string[]): Promise<AnnouncementRow[]> {
      if (parentSeqIds.length === 0) return [];
      return sql<AnnouncementRow[]>`
        SELECT ${columns()} FROM announcements a JOIN companies c ON c.symbol = a.symbol
        WHERE a.parent_seq_id = ANY(${[...parentSeqIds]})
        ORDER BY a.published_at ASC`;
    },

    async listBySymbol(symbol: string, limit = 50): Promise<AnnouncementRow[]> {
      return sql<AnnouncementRow[]>`
        SELECT ${columns()} FROM announcements a JOIN companies c ON c.symbol = a.symbol
        WHERE a.symbol = ${symbol.toUpperCase()}
        ORDER BY a.published_at DESC LIMIT ${limit}`;
    },

    async countByStatus(): Promise<Record<string, number>> {
      const rows = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM announcements GROUP BY status`;
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
  };
}

export type AnnouncementsRepo = ReturnType<typeof announcementsRepo>;
