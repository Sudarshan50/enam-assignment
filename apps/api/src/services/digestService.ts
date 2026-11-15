import type { DigestItem, DigestQuery, DigestResponse, Tier } from "@finn/shared";
import { badRequest } from "../http/errors";
import type { Logger } from "../lib/logger";
import { type Clock, DAY, HOUR, systemClock } from "../lib/time";
import { type AnnouncementRow, toDigestItem } from "./announcementMapper";
import { type SourceHealthService, isAnnouncementSource } from "./sourceHealthService";

export interface DigestRepository {
  /**
   * Ready cluster heads (parent_seq_id IS NULL) for holdings published in [from, to), plus every
   * child of those heads regardless of status or date.
   */
  listWindow(from: Date, to: Date): Promise<AnnouncementRow[]>;
}

export interface DigestService {
  getDigest(query: DigestQuery): Promise<DigestResponse>;
}

const WINDOW_MS = { "24h": 24 * HOUR, "3d": 3 * DAY, "7d": 7 * DAY } as const;
const MAX_RANGE_MS = 31 * DAY;

export function resolveWindow(query: DigestQuery, now: Date): { from: Date; to: Date } {
  if (query.from || query.to) {
    const to = query.to ? new Date(query.to) : now;
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - WINDOW_MS["24h"]);
    if (from.getTime() >= to.getTime()) throw badRequest("`from` must be before `to`");
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw badRequest("The window can span at most 31 days");
    return { from, to };
  }
  return { from: new Date(now.getTime() - WINDOW_MS[query.window ?? "24h"]), to: now };
}

const byPriority = (a: DigestItem, b: DigestItem) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt);

export function createDigestService(deps: {
  repo: DigestRepository;
  sourceHealth: SourceHealthService;
  now?: Clock;
  log?: Logger;
}): DigestService {
  const now = deps.now ?? systemClock;
  return {
    async getDigest(query) {
      const at = now();
      const { from, to } = resolveWindow(query, at);
      const [rows, sourceHealth] = await Promise.all([deps.repo.listWindow(from, to), deps.sourceHealth.list()]);

      const children = new Map<string, AnnouncementRow[]>();
      for (const row of rows) {
        if (row.parentSeqId === null) continue;
        const list = children.get(row.parentSeqId) ?? [];
        list.push(row);
        children.set(row.parentSeqId, list);
      }

      const buckets: Record<Tier, DigestItem[]> = { act: [], know: [], noise: [] };
      let unreadAct = 0;
      for (const row of rows) {
        if (row.parentSeqId !== null || row.status !== "ready" || row.dismissed) continue;
        const item = toDigestItem(row, children.get(row.seqId) ?? [], deps.log);
        buckets[item.tier].push(item);
        if (item.tier === "act" && !row.read) unreadAct++;
      }
      for (const list of Object.values(buckets)) list.sort(byPriority);

      const announcementHealth = sourceHealth.filter((s) => isAnnouncementSource(s.source));
      const ingestStale = announcementHealth.length === 0 || announcementHealth.some((s) => s.stale);
      const asOf =
        announcementHealth
          .map((s) => s.lastSuccessAt)
          .filter((v): v is string => v !== null)
          .sort()
          .at(-1) ?? null;

      return {
        window: { from: from.toISOString(), to: to.toISOString() },
        asOf,
        caughtUp: unreadAct === 0 && !ingestStale,
        counts: { act: buckets.act.length, know: buckets.know.length, noise: buckets.noise.length },
        act: buckets.act,
        know: buckets.know,
        noise: buckets.noise,
        sourceHealth,
      };
    },
  };
}
