import type { Sql } from "../client";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: Date;
  lastOkAt: Date | null;
}

export interface PendingDelivery {
  alertId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  symbol: string;
  kind: string;
  title: string;
  body: string;
  announcementSeqId: string | null;
}

export type DeliveryStatus = "pending" | "sent" | "failed" | "gone";

export function pushRepo(sql: Sql) {
  return {
    async upsertSubscription(sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
      await sql`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (${sub.endpoint}, ${sub.p256dh}, ${sub.auth})
        ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`;
    },

    async deleteSubscription(endpoint: string): Promise<boolean> {
      const res = await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
      return (res.count ?? 0) > 0;
    },

    async listSubscriptions(): Promise<PushSubscriptionRow[]> {
      return sql<PushSubscriptionRow[]>`
        SELECT endpoint, p256dh, auth, created_at AS "createdAt", last_ok_at AS "lastOkAt" FROM push_subscriptions`;
    },

    async markSubscriptionOk(endpoint: string): Promise<void> {
      await sql`UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = ${endpoint}`;
    },

    /**
     * Recent (alert, subscription) pairs that have never been attempted, or failed with retries left.
     * A delivery stuck in 'pending' (worker died mid-send) is never retried: at most one push per pair.
     */
    async listUndelivered(opts: { sinceHours?: number; maxAttempts?: number; limit?: number } = {}): Promise<PendingDelivery[]> {
      return sql<PendingDelivery[]>`
        SELECT a.id AS "alertId", s.endpoint, s.p256dh, s.auth, a.symbol, a.kind, a.title, a.body,
               a.announcement_seq_id AS "announcementSeqId"
        FROM alerts a
        CROSS JOIN push_subscriptions s
        LEFT JOIN notification_deliveries d ON d.alert_id = a.id AND d.endpoint = s.endpoint
        WHERE a.created_at > now() - make_interval(hours => ${opts.sinceHours ?? 24})
          AND (d.alert_id IS NULL OR (d.status = 'failed' AND d.attempts < ${opts.maxAttempts ?? 3}))
        ORDER BY a.created_at ASC
        LIMIT ${opts.limit ?? 200}`;
    },

    /** Claims a delivery before sending. False means another run already owns or finished it. */
    async claimDelivery(alertId: string, endpoint: string, maxAttempts = 3): Promise<boolean> {
      const [row] = await sql<{ attempts: number }[]>`
        INSERT INTO notification_deliveries (alert_id, endpoint, status, attempts) VALUES (${alertId}, ${endpoint}, 'pending', 1)
        ON CONFLICT (alert_id, endpoint) DO UPDATE SET status = 'pending', attempts = notification_deliveries.attempts + 1, updated_at = now()
        WHERE notification_deliveries.status = 'failed' AND notification_deliveries.attempts < ${maxAttempts}
        RETURNING attempts`;
      return Boolean(row);
    },

    async markDelivery(alertId: string, endpoint: string, status: DeliveryStatus, error?: string): Promise<void> {
      await sql`
        UPDATE notification_deliveries SET status = ${status}, last_error = ${error?.slice(0, 500) ?? null}, updated_at = now()
        WHERE alert_id = ${alertId} AND endpoint = ${endpoint}`;
    },

    async countDeliveries(): Promise<Record<string, number>> {
      const rows = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM notification_deliveries GROUP BY status`;
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
  };
}

export type PushRepo = ReturnType<typeof pushRepo>;
