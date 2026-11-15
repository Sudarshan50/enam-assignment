import type { AnnouncementDetail } from "../contracts";
import { notFound } from "../http/errors";
import type { Logger } from "../lib/logger";
import { type AnnouncementRow, toDigestItem } from "./announcementMapper";

export interface AnnouncementDetailRow extends AnnouncementRow {
  bodyText: string | null;
}

export interface AnnouncementRepository {
  getBySeqId(seqId: string): Promise<AnnouncementDetailRow | null>;
  listChildren(parentSeqId: string): Promise<AnnouncementRow[]>;
}

export interface AnnouncementService {
  getDetail(seqId: string): Promise<AnnouncementDetail>;
}

export function createAnnouncementService(deps: { repo: AnnouncementRepository; log?: Logger }): AnnouncementService {
  return {
    async getDetail(seqId) {
      const row = await deps.repo.getBySeqId(seqId);
      if (!row) throw notFound("Announcement");
      const children = await deps.repo.listChildren(seqId);
      return {
        ...toDigestItem(row, children, deps.log),
        bodyText: row.bodyText,
        parentId: row.parentSeqId,
        status: row.status,
        dismissed: row.dismissed,
      };
    },
  };
}
