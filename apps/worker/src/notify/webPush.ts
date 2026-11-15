import { sendNotification } from "web-push";
import { pushRepo, type PendingDelivery } from "@finn/db/repositories/push";
import type { WorkerContext } from "../context";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  send(target: PushTarget, payload: string): Promise<PushResult>;
}

/** Null when VAPID keys aren't configured; alerts are still stored and shown in-app. */
export function createWebPushSender(env: NodeJS.ProcessEnv): PushSender | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  const vapidDetails = { subject: VAPID_SUBJECT || "mailto:finn@example.com", publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
  return {
    async send(target, payload) {
      try {
        await sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
          vapidDetails,
          TTL: 6 * 60 * 60,
          urgency: "normal",
        });
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** More than this many alerts for one device in a run collapse into a single summary notification. */
const BATCH_THRESHOLD = 3;

export interface DeliverySummary {
  sent: number;
  failed: number;
  gone: number;
  skipped: number;
  configured: boolean;
}

function payloadFor(items: PendingDelivery[]): string {
  if (items.length === 1) {
    const a = items[0]!;
    return JSON.stringify({
      title: a.title,
      body: a.body,
      tag: `alert-${a.alertId}`,
      url: a.announcementSeqId ? `/?item=${encodeURIComponent(a.announcementSeqId)}` : "/watch",
    });
  }
  const symbols = [...new Set(items.map((i) => i.symbol))];
  return JSON.stringify({
    title: `${items.length} new alerts`,
    body: items
      .slice(0, 4)
      .map((i) => i.title)
      .join(" · ")
      .slice(0, 240),
    tag: "alert-batch",
    url: "/watch",
    symbols,
  });
}

/**
 * Sends every alert that has no delivery record yet for each subscription. Each (alert, endpoint) is
 * claimed in notification_deliveries before sending, so a crash or a re-run can never double-send.
 */
export async function deliverPendingPushes(ctx: WorkerContext, sender: PushSender | null = createWebPushSender(ctx.env)): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, failed: 0, gone: 0, skipped: 0, configured: sender !== null };
  if (!sender) return summary;
  const repo = pushRepo(ctx.sql);
  const pending = await repo.listUndelivered({ sinceHours: 24 });
  if (pending.length === 0) return summary;

  const byEndpoint = new Map<string, PendingDelivery[]>();
  for (const p of pending) {
    if (!(await repo.claimDelivery(p.alertId, p.endpoint))) {
      summary.skipped++;
      continue;
    }
    const list = byEndpoint.get(p.endpoint) ?? [];
    list.push(p);
    byEndpoint.set(p.endpoint, list);
  }

  for (const [endpoint, items] of byEndpoint) {
    const first = items[0]!;
    const groups = items.length > BATCH_THRESHOLD ? [items] : items.map((i) => [i]);
    for (const group of groups) {
      const result = await sender.send({ endpoint, p256dh: first.p256dh, auth: first.auth }, payloadFor(group));
      if (result.ok) {
        for (const g of group) await repo.markDelivery(g.alertId, endpoint, "sent");
        await repo.markSubscriptionOk(endpoint);
        summary.sent += group.length;
      } else if (result.gone) {
        await repo.deleteSubscription(endpoint);
        summary.gone += group.length;
        ctx.log.info({ endpoint: endpoint.slice(0, 60) }, "Push subscription gone; removed");
        break;
      } else {
        for (const g of group) await repo.markDelivery(g.alertId, endpoint, "failed", result.error);
        summary.failed += group.length;
        ctx.log.warn({ error: result.error }, "Push delivery failed");
      }
    }
  }
  return summary;
}
