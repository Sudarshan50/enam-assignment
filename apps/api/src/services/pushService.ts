import { notFound } from "../http/errors";
import type { Logger } from "../lib/logger";

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRepository {
  upsert(sub: StoredSubscription): Promise<void>;
  remove(endpoint: string): Promise<boolean>;
  find(endpoint: string): Promise<StoredSubscription | null>;
  markOk(endpoint: string): Promise<void>;
}

export type PushSendResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  send(sub: StoredSubscription, payload: Record<string, unknown>): Promise<PushSendResult>;
}

export interface PushService {
  publicKey(): { enabled: boolean; publicKey: string | null };
  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  /** Sends one test notification to a subscription that is already stored; never to anyone else. */
  sendTest(endpoint: string): Promise<{ sent: number; failed: number; pruned: number }>;
}

export function createPushService(deps: {
  repo: PushRepository;
  sender: PushSender | null;
  vapidPublicKey: string | null;
  log: Logger;
}): PushService {
  const { repo, sender, log } = deps;
  return {
    publicKey() {
      const enabled = Boolean(sender && deps.vapidPublicKey);
      return { enabled, publicKey: enabled ? deps.vapidPublicKey : null };
    },
    async subscribe(sub) {
      await repo.upsert({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    },
    async unsubscribe(endpoint) {
      await repo.remove(endpoint);
    },
    async sendTest(endpoint) {
      if (!sender) return { sent: 0, failed: 0, pruned: 0 };
      const sub = await repo.find(endpoint);
      if (!sub) throw notFound("Push subscription");
      const result = await sender.send(sub, { title: "FINN", body: "Push notifications are working.", url: "/" });
      if (result.ok) {
        await repo.markOk(sub.endpoint);
        return { sent: 1, failed: 0, pruned: 0 };
      }
      if (result.gone) {
        await repo.remove(sub.endpoint);
        return { sent: 0, failed: 0, pruned: 1 };
      }
      log.warn({ error: result.error }, "test push failed");
      return { sent: 0, failed: 1, pruned: 0 };
    },
  };
}
