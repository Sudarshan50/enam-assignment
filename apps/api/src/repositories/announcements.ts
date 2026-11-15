import type { Sql } from "@finn/db";
import type { AnnouncementRow } from "../services/announcementMapper";
import type { AnnouncementDetailRow, AnnouncementRepository } from "../services/announcementService";
import type { DigestRepository } from "../services/digestService";
import type { InteractionRepository } from "../services/interactionService";

const DB_ACTION = { open: "open", dismiss: "dismiss", undo_dismiss: "undo", pin: "pin" } as const;

/** Columns every announcement read model needs, including per-item read/dismissed state. */
function columns(sql: Sql) {
  return sql`
    a.seq_id AS "seqId", a.symbol, c.name AS "companyName", a.headline, a.one_liner AS "oneLiner",
    a.published_at AS "publishedAt", a.pdf_url AS "pdfUrl", a.category, a.tier, a.score::float8 AS score,
    a.reason_codes AS "reasonCodes", a.card, a.parent_seq_id AS "parentSeqId", a.status,
    EXISTS (SELECT 1 FROM interactions i WHERE i.seq_id = a.seq_id AND i.action IN ('open','dismiss','pin')) AS read,
    COALESCE((SELECT i.action = 'dismiss' FROM interactions i
              WHERE i.seq_id = a.seq_id AND i.action IN ('dismiss','undo') ORDER BY i.id DESC LIMIT 1), false) AS dismissed`;
}

export function createAnnouncementsRepository(sql: Sql): DigestRepository & AnnouncementRepository & InteractionRepository {
  return {
    async listWindow(from, to) {
      return sql<AnnouncementRow[]>`
        WITH heads AS (
          SELECT a.* FROM announcements a
          JOIN holdings h ON h.symbol = a.symbol
          WHERE a.status = 'ready' AND a.parent_seq_id IS NULL
            AND a.published_at >= ${from} AND a.published_at < ${to}
          ORDER BY a.published_at DESC
          LIMIT 500
        ), rows AS (
          SELECT * FROM heads
          UNION ALL
          SELECT a.* FROM announcements a WHERE a.parent_seq_id IN (SELECT seq_id FROM heads)
        )
        SELECT ${columns(sql)}
        FROM rows a JOIN companies c ON c.symbol = a.symbol
        ORDER BY a.published_at DESC`;
    },

    async getBySeqId(seqId) {
      const [row] = await sql<AnnouncementDetailRow[]>`
        SELECT ${columns(sql)}, a.body_text AS "bodyText"
        FROM announcements a JOIN companies c ON c.symbol = a.symbol
        WHERE a.seq_id = ${seqId}`;
      return row ?? null;
    },

    async listChildren(parentSeqId) {
      return sql<AnnouncementRow[]>`
        SELECT ${columns(sql)}
        FROM announcements a JOIN companies c ON c.symbol = a.symbol
        WHERE a.parent_seq_id = ${parentSeqId}
        ORDER BY a.published_at`;
    },

    async findCategory(seqId) {
      const [row] = await sql<{ category: string | null }[]>`SELECT category FROM announcements WHERE seq_id = ${seqId}`;
      return row ? row.category : undefined;
    },

    async record({ seqId, action, category }) {
      await sql`INSERT INTO interactions (seq_id, action, category) VALUES (${seqId}, ${DB_ACTION[action]}, ${category})`;
    },
  };
}
