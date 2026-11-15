import type { Sql } from "@finn/db";
import type { PushRepository, StoredSubscription } from "../services/pushService";

export function createPushRepository(sql: Sql): PushRepository {
  return {
    async upsert(sub) {
      await sql`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (${sub.endpoint}, ${sub.p256dh}, ${sub.auth})
        ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`;
    },
    async remove(endpoint) {
      const rows = await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} RETURNING endpoint`;
      return rows.length > 0;
    },
    async list() {
      return sql<StoredSubscription[]>`SELECT endpoint, p256dh, auth FROM push_subscriptions`;
    },
    async markOk(endpoint) {
      await sql`UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = ${endpoint}`;
    },
  };
}
