import { WebPushError, sendNotification } from "web-push";
import type { PushSender } from "../services/pushService";

export function createWebPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): PushSender {
  return {
    async send(sub, payload) {
      try {
        await sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
          vapidDetails: vapid,
          TTL: 3600,
          timeout: 10_000,
        });
        return { ok: true };
      } catch (err) {
        const status = err instanceof WebPushError ? err.statusCode : (err as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410, error: `${status ?? "network"}: ${(err as Error).message}`.slice(0, 300) };
      }
    },
  };
}
