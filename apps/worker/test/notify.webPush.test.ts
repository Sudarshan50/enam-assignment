import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendNotification } from "web-push";
import type { Sql } from "@finn/db";
import { alertsRepo } from "@finn/db/repositories/alerts";
import { PENDING_CLAIM_TIMEOUT_SECONDS, pushRepo } from "@finn/db/repositories/push";
import { createWebPushSender, deliverPendingPushes, type PushResult, type PushSender, type PushTarget } from "../src/notify/webPush";
import { cleanupScope, connectTestDb, insertCompany } from "./support/db";
import { fakeContext } from "./support/fakes";
import { scope, setScope } from "./support/scope";

vi.mock("@finn/db/repositories/push", async (orig) => (await import("./support/scope")).scopePush(await orig()));
vi.mock("web-push", () => ({ sendNotification: vi.fn() }));

setScope("ZTDN");
const SYMBOL = `${scope.symbol}ALPHA`;
const endpoint = (name: string) => `${scope.endpoint}${name}`;

/** Records every send; per-endpoint results default to ok. */
function fakeSender(results: Record<string, PushResult | (() => PushResult)> = {}) {
  const sent: { target: PushTarget; payload: Record<string, unknown> }[] = [];
  const sender: PushSender & { sent: typeof sent } = {
    sent,
    async send(target, payload) {
      sent.push({ target, payload: JSON.parse(payload) as Record<string, unknown> });
      const r = results[target.endpoint];
      return (typeof r === "function" ? r() : r) ?? { ok: true };
    },
  };
  return sender;
}

describe("createWebPushSender", () => {
  const mocked = vi.mocked(sendNotification);

  it("is null without VAPID keys", () => {
    expect(createWebPushSender({})).toBeNull();
    expect(createWebPushSender({ VAPID_PUBLIC_KEY: "pub" })).toBeNull();
  });

  it("maps web-push outcomes: ok, gone on 404/410, failed otherwise", async () => {
    const sender = createWebPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" })!;
    const target = { endpoint: "https://fcm.googleapis.com/fcm/send/ztdn-x", p256dh: "p", auth: "a" };

    mocked.mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} });
    expect(await sender.send(target, "{}")).toEqual({ ok: true });
    expect(mocked).toHaveBeenLastCalledWith(
      { endpoint: target.endpoint, keys: { p256dh: "p", auth: "a" } },
      "{}",
      expect.objectContaining({ vapidDetails: { subject: "mailto:finn@example.com", publicKey: "pub", privateKey: "priv" }, TTL: 21600, timeout: 30_000 }),
    );

    for (const statusCode of [404, 410]) {
      mocked.mockRejectedValueOnce(Object.assign(new Error("Gone"), { statusCode }));
      expect(await sender.send(target, "{}")).toEqual({ ok: false, gone: true, error: "Gone" });
    }
    mocked.mockRejectedValueOnce(Object.assign(new Error("Server error"), { statusCode: 500 }));
    expect(await sender.send(target, "{}")).toEqual({ ok: false, gone: false, error: "Server error" });
    mocked.mockRejectedValueOnce("socket hang up");
    expect(await sender.send(target, "{}")).toEqual({ ok: false, gone: false, error: "socket hang up" });
  });

  it("uses VAPID_SUBJECT when given", async () => {
    const sender = createWebPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:ops@ztd.test" })!;
    mocked.mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} });
    await sender.send({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/ztdn-y", p256dh: "p", auth: "a" }, "{}");
    expect(mocked.mock.lastCall?.[2]?.vapidDetails?.subject).toBe("mailto:ops@ztd.test");
  });

  it.each(["https://ztdn.push.test/x", "http://fcm.googleapis.com/fcm/send/x", "https://169.254.169.254/latest", "https://fcm.googleapis.com.evil.test/x", "not a url"])(
    "never sends to %s, which is not a known Web Push service",
    async (endpoint) => {
      const sender = createWebPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" })!;
      mocked.mockClear();
      expect(await sender.send({ endpoint, p256dh: "p", auth: "a" }, "{}")).toEqual({
        ok: false,
        gone: false,
        error: "Endpoint is not a known Web Push service; not sent",
      });
      expect(mocked).not.toHaveBeenCalled();
    },
  );
});

const sql = (await connectTestDb()) as Sql;

describe.skipIf(sql === null)("deliverPendingPushes against the local database", () => {
  const { ctx, log } = fakeContext(sql);
  let ruleId = "";
  let n = 0;

  async function alerts(count: number, opts: { symbol?: string; announcementSeqId?: string | null } = {}) {
    const drafts = Array.from({ length: count }, () => {
      n++;
      return {
        ruleId,
        symbol: opts.symbol ?? SYMBOL,
        kind: "price_move" as const,
        eventKey: `2026-11-${String(n).padStart(2, "0")}-${n}`,
        title: `${opts.symbol ?? SYMBOL} alert ${n}`,
        body: `body ${n}`,
        sessionDate: null,
        announcementSeqId: opts.announcementSeqId ?? null,
      };
    });
    return alertsRepo(sql).insertMany(drafts);
  }
  const subscribe = (name: string) => pushRepo(sql).upsertSubscription({ endpoint: endpoint(name), p256dh: `p-${name}`, auth: `a-${name}` });
  const deliveries = () => sql<{ endpoint: string; status: string; attempts: number; last_error: string | null }[]>`
    SELECT d.endpoint, d.status, d.attempts, d.last_error FROM notification_deliveries d JOIN alerts a ON a.id = d.alert_id
    WHERE a.symbol LIKE ${`${scope.symbol}%`} ORDER BY d.endpoint, a.created_at`;

  beforeAll(async () => {
    await cleanupScope(sql, scope);
    await insertCompany(sql, SYMBOL);
    await sql`INSERT INTO announcements (seq_id, symbol, headline, published_at, raw) VALUES (${`${scope.seq}-ann`}, ${SYMBOL}, 'h', now(), '{}')`;
    ruleId = (await alertsRepo(sql).createRule(`${scope.rule}-rule`, { type: "price_move", scope: { kind: "symbols", symbols: [SYMBOL] }, direction: "either", thresholdPct: 1 })).id;
  });

  afterAll(async () => {
    await cleanupScope(sql, scope);
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM alerts WHERE symbol LIKE ${`${scope.symbol}%`}`;
    await sql`DELETE FROM push_subscriptions WHERE endpoint LIKE ${`${scope.endpoint}%`}`;
  });

  it("does nothing (but reports unconfigured) without a sender", async () => {
    await subscribe("a");
    await alerts(1);
    expect(await deliverPendingPushes(ctx, null)).toEqual({ sent: 0, failed: 0, gone: 0, skipped: 0, configured: false });
    expect(await deliverPendingPushes(ctx)).toMatchObject({ configured: false });
    expect(await deliveries()).toEqual([]);
  });

  it("sends each alert once per subscription and never again on re-run", async () => {
    await subscribe("a");
    await subscribe("b");
    await alerts(1, { announcementSeqId: `${scope.seq}-ann` });
    await alerts(1);
    const sender = fakeSender();
    expect(await deliverPendingPushes(ctx, sender)).toEqual({ sent: 4, failed: 0, gone: 0, skipped: 0, configured: true });
    expect(sender.sent).toHaveLength(4);
    const toA = sender.sent.filter((s) => s.target.endpoint === endpoint("a"));
    expect(toA.map((s) => s.target)).toEqual([
      { endpoint: endpoint("a"), p256dh: "p-a", auth: "a-a" },
      { endpoint: endpoint("a"), p256dh: "p-a", auth: "a-a" },
    ]);
    expect(toA[0]!.payload).toMatchObject({ title: `${SYMBOL} alert ${n - 1}`, url: `/?item=${scope.seq}-ann`, tag: expect.stringMatching(/^alert-/) });
    expect(toA[1]!.payload).toMatchObject({ url: "/watch" });
    expect((await deliveries()).every((d) => d.status === "sent" && d.attempts === 1)).toBe(true);
    const subs = await pushRepo(sql).listSubscriptions();
    expect(subs.filter((s) => s.endpoint.startsWith(scope.endpoint)).every((s) => s.lastOkAt !== null)).toBe(true);

    const again = fakeSender();
    expect(await deliverPendingPushes(ctx, again)).toMatchObject({ sent: 0 });
    expect(again.sent).toEqual([]);
  });

  it("batches more than 3 alerts per device into one summary; exactly 3 go out individually", async () => {
    await subscribe("batch");
    await alerts(5);
    const sender = fakeSender();
    expect(await deliverPendingPushes(ctx, sender)).toMatchObject({ sent: 5 });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.payload).toMatchObject({ title: "5 new alerts", tag: "alert-batch", url: "/watch", symbols: [SYMBOL] });
    expect((sender.sent[0]!.payload.body as string).split(" · ")).toHaveLength(4);
    expect((await deliveries()).filter((d) => d.status === "sent")).toHaveLength(5);

    await sql`DELETE FROM alerts WHERE symbol LIKE ${`${scope.symbol}%`}`;
    await alerts(3);
    const three = fakeSender();
    expect(await deliverPendingPushes(ctx, three)).toMatchObject({ sent: 3 });
    expect(three.sent).toHaveLength(3);
    expect(three.sent.every((s) => s.payload.tag !== "alert-batch")).toBe(true);
  });

  it.each([404, 410])("a %s from the push service deletes the subscription and stops sending to it", async (status) => {
    await subscribe("gone");
    await subscribe("ok");
    await alerts(2);
    const sender = fakeSender({ [endpoint("gone")]: { ok: false, gone: true, error: `HTTP ${status}` } });
    const summary = await deliverPendingPushes(ctx, sender);
    expect(summary).toMatchObject({ sent: 2, gone: 1 });
    expect(sender.sent.filter((s) => s.target.endpoint === endpoint("gone"))).toHaveLength(1);
    const remaining = (await pushRepo(sql).listSubscriptions()).map((s) => s.endpoint).filter((e) => e.startsWith(scope.endpoint));
    expect(remaining).toEqual([endpoint("ok")]);
    expect((await deliveries()).every((d) => d.endpoint === endpoint("ok"))).toBe(true);
    expect(log.messages("info")).toContain("Push subscription gone; removed");
  });

  it("transient failures are recorded and retried until 3 attempts, then left alone", async () => {
    await subscribe("flaky");
    await alerts(1);
    const failing = fakeSender({ [endpoint("flaky")]: { ok: false, gone: false, error: "HTTP 500" } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await deliverPendingPushes(ctx, failing)).toMatchObject({ failed: 1, sent: 0 });
      expect(await deliveries()).toEqual([{ endpoint: endpoint("flaky"), status: "failed", attempts: attempt, last_error: "HTTP 500" }]);
    }
    expect(await deliverPendingPushes(ctx, failing)).toMatchObject({ failed: 0, sent: 0 });
    expect(failing.sent).toHaveLength(3);
    expect(log.messages("warn")).toContain("Push delivery failed");
  });

  it("a failed delivery succeeds on retry without duplicating", async () => {
    await subscribe("retry");
    await alerts(1);
    let fail = true;
    const sender = fakeSender({ [endpoint("retry")]: () => (fail ? { ok: false, gone: false, error: "timeout" } : { ok: true }) });
    await deliverPendingPushes(ctx, sender);
    fail = false;
    expect(await deliverPendingPushes(ctx, sender)).toMatchObject({ sent: 1 });
    expect(await deliveries()).toEqual([{ endpoint: endpoint("retry"), status: "sent", attempts: 2, last_error: null }]);
    expect((await deliverPendingPushes(ctx, sender)).sent).toBe(0);
  });

  it("two concurrent runs (or a crash and a re-run) never double-send: deliveries are claimed first", async () => {
    await subscribe("race");
    await alerts(2);
    const a = fakeSender();
    const b = fakeSender();
    const [ra, rb] = await Promise.all([deliverPendingPushes(ctx, a), deliverPendingPushes(ctx, b)]);
    expect(a.sent.length + b.sent.length).toBe(2);
    expect(ra.sent + rb.sent).toBe(2);
    expect(ra.skipped + rb.skipped).toBeLessThanOrEqual(2);
    expect((await deliveries()).map((d) => [d.status, d.attempts])).toEqual([["sent", 1], ["sent", 1]]);

    // A fresh 'pending' claim belongs to a run that may still be sending, so it is left alone.
    await sql`DELETE FROM alerts WHERE symbol LIKE ${`${scope.symbol}%`}`;
    const [crashed] = await alerts(1);
    expect(await pushRepo(sql).claimDelivery(crashed!.id, endpoint("race"))).toBe(true);
    const after = fakeSender();
    expect(await deliverPendingPushes(ctx, after)).toMatchObject({ sent: 0 });
    expect(after.sent).toEqual([]);
  });

  it("a claim abandoned mid-send becomes reclaimable after the timeout, within the attempt budget", async () => {
    await subscribe("crash");
    const [alert] = await alerts(1);
    const abandon = async () => {
      expect(await pushRepo(sql).claimDelivery(alert!.id, endpoint("crash"))).toBe(true);
      await sql`UPDATE notification_deliveries SET updated_at = now() - make_interval(secs => ${PENDING_CLAIM_TIMEOUT_SECONDS + 1}) WHERE alert_id = ${alert!.id}`;
    };

    await abandon();
    const retry = fakeSender({ [endpoint("crash")]: { ok: false, gone: false, error: "HTTP 503" } });
    expect(await deliverPendingPushes(ctx, retry)).toMatchObject({ failed: 1 });
    expect(await deliveries()).toEqual([{ endpoint: endpoint("crash"), status: "failed", attempts: 2, last_error: "HTTP 503" }]);

    // The third (last) attempt is abandoned too: nothing is left to retry.
    await sql`UPDATE notification_deliveries SET status = 'pending', attempts = 3, updated_at = now() - interval '1 hour' WHERE alert_id = ${alert!.id}`;
    const exhausted = fakeSender();
    expect(await deliverPendingPushes(ctx, exhausted)).toMatchObject({ sent: 0, failed: 0 });
    expect(exhausted.sent).toEqual([]);
  });

  it("a sender that throws releases the claim as failed so the next run retries it", async () => {
    await subscribe("throws");
    await alerts(1);
    let explode = true;
    const sender: PushSender = {
      async send() {
        if (explode) throw new Error("socket closed");
        return { ok: true };
      },
    };
    expect(await deliverPendingPushes(ctx, sender)).toMatchObject({ failed: 1, sent: 0 });
    expect(await deliveries()).toEqual([{ endpoint: endpoint("throws"), status: "failed", attempts: 1, last_error: "socket closed" }]);
    explode = false;
    expect(await deliverPendingPushes(ctx, sender)).toMatchObject({ sent: 1 });
    expect(await deliveries()).toEqual([{ endpoint: endpoint("throws"), status: "sent", attempts: 2, last_error: null }]);
  });
});
