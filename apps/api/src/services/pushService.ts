import type { Logger } from "../lib/logger";

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRepository {
  upsert(sub: StoredSubscription): Promise<void>;
  remove(endpoint: string): Promise<boolean>;
  list(): Promise<StoredSubscription[]>;
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
  sendTest(): Promise<{ sent: number; failed: number; pruned: number }>;
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
    async sendTest() {
      if (!sender) return { sent: 0, failed: 0, pruned: 0 };
      const payload = { title: "FINN", body: "Push notifications are working.", url: "/" };
      let sent = 0;
      let failed = 0;
      let pruned = 0;
      for (const sub of await repo.list()) {
        const result = await sender.send(sub, payload);
        if (result.ok) {
          sent++;
          await repo.markOk(sub.endpoint);
        } else if (result.gone) {
          pruned++;
          await repo.remove(sub.endpoint);
        } else {
          failed++;
          log.warn({ error: result.error }, "test push failed");
        }
      }
      return { sent, failed, pruned };
    },
  };
}
