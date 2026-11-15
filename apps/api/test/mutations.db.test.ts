import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Sql, closeDb, getDb } from "@finn/db";
import { AlertRuleSchema, AlertSchema, DigestResponseSchema, USER_WEIGHT_RANGE } from "@finn/shared";
import { AnnouncementDetailSchema, CompanySearchResultSchema, FinancialsResponseSchema, InteractionResponseSchema, PrefsSchema, PreviewResponseSchema } from "../src/contracts";
import { createPushRepository } from "../src/repositories/push";
import { type PushSender, createPushService } from "../src/services/pushService";
import { auth, silentLog } from "./helpers";
import { buildDbApp, cleanupPrefix, dbReachable, expectParse, inRollback, insertCompany, testPushEndpoint } from "./support/db";

const dbUp = await dbReachable();
const P = "ZTPM";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface AnnouncementSeed {
  seq: string;
  symbol: string;
  at: Date;
  status?: string;
  tier?: string | null;
  score?: number | null;
  category?: string | null;
  parent?: string | null;
  card?: unknown;
}

async function insertAnnouncement(sql: Sql, a: AnnouncementSeed) {
  await sql`
    INSERT INTO announcements (seq_id, symbol, headline, published_at, raw, category, score, tier, parent_seq_id, card, status, one_liner)
    VALUES (${a.seq}, ${a.symbol}, ${`Headline ${a.seq}`}, ${a.at}, ${sql.json({ seq: a.seq })}, ${"category" in a ? (a.category ?? null) : "results"},
            ${a.score ?? 50}, ${a.tier === undefined ? "know" : a.tier}, ${a.parent ?? null},
            ${a.card === undefined ? null : sql.json(a.card as never)}, ${a.status ?? "ready"}, ${`One liner ${a.seq}`})`;
}

async function insertPrices(sql: Sql, symbol: string, closes: number[], volumes?: number[]) {
  const start = Date.UTC(2026, 9, 1);
  for (let i = 0; i < closes.length; i++) {
    const day = new Date(start + i * DAY).toISOString().slice(0, 10);
    await sql`
      INSERT INTO prices_eod (symbol, session_date, close, prev_close, volume)
      VALUES (${symbol}, ${day}, ${closes[i]!}, NULL, ${volumes?.[i] ?? 1_000_000})`;
  }
}

describe.skipIf(!dbUp)("writes against the local database", async () => {
  if (!dbUp) return it.skip("needs the local database", () => {});
  const sql = getDb();

  beforeAll(async () => {
    await cleanupPrefix(sql, P);
  });

  afterAll(async () => {
    await cleanupPrefix(sql, P);
    const [left] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM alert_rules WHERE name LIKE ${`${P}%`})
           + (SELECT count(*) FROM push_subscriptions WHERE endpoint LIKE ${`${testPushEndpoint(P)}%`})
           + (SELECT count(*) FROM companies WHERE symbol LIKE ${`${P}%`}) AS n`;
    expect(Number(left!.n)).toBe(0);
    await closeDb();
  });

  describe("alert rules CRUD (committed ZTPM rows, removed in afterAll)", () => {
    it("creates, lists, toggles, renames, retunes and deletes a price rule", async () => {
      const { app } = await buildDbApp(sql);
      const created = await request(app)
        .post("/api/v1/alert-rules")
        .set(auth)
        .send({ name: `${P} drop`, definition: { type: "price_move", scope: { kind: "symbols", symbols: ["TCS"] }, direction: "down", thresholdPct: 4 } });
      expect(created.status).toBe(201);
      const rule = expectParse(AlertRuleSchema, created.body, "created rule");
      expect(rule).toMatchObject({ name: `${P} drop`, enabled: true });

      const list = expectParse(z.array(AlertRuleSchema), (await request(app).get("/api/v1/alert-rules").set(auth)).body, "rules");
      expect(list.find((r) => r.id === rule.id)).toEqual(rule);

      const patch = (body: object) => request(app).patch(`/api/v1/alert-rules/${rule.id}`).set(auth).send(body);
      expect((await patch({ enabled: false })).body).toMatchObject({ enabled: false, name: `${P} drop` });
      expect((await patch({ name: `${P} renamed` })).body).toMatchObject({ enabled: false, name: `${P} renamed` });
      const retuned = await patch({ threshold: 6.5 });
      expect(retuned.body.definition).toEqual({ type: "price_move", scope: { kind: "symbols", symbols: ["TCS"] }, direction: "down", thresholdPct: 6.5 });
      const [stored] = await sql<{ definition: { thresholdPct: number }; enabled: boolean }[]>`SELECT definition, enabled FROM alert_rules WHERE id = ${rule.id}`;
      expect(stored).toMatchObject({ enabled: false, definition: { thresholdPct: 6.5 } });

      const tooBig = await patch({ threshold: 25 });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.error.code).toBe("validation_error");

      expect((await request(app).delete(`/api/v1/alert-rules/${rule.id}`).set(auth)).status).toBe(204);
      expect((await request(app).delete(`/api/v1/alert-rules/${rule.id}`).set(auth)).status).toBe(404);
      expect((await patch({ enabled: true })).status).toBe(404);
      expect((await request(app).get("/api/v1/alert-rules").set(auth)).body.some((r: { id: string }) => r.id === rule.id)).toBe(false);
    });

    it("retunes a volume rule's multiple and refuses a threshold on category rules", async () => {
      const { app } = await buildDbApp(sql);
      const volume = await request(app)
        .post("/api/v1/alert-rules")
        .set(auth)
        .send({ name: `${P} volume`, definition: { type: "volume_spike", scope: { kind: "portfolio" }, multiple: 2 } });
      const retuned = await request(app).patch(`/api/v1/alert-rules/${volume.body.id}`).set(auth).send({ threshold: 3 });
      expect(retuned.body.definition).toEqual({ type: "volume_spike", scope: { kind: "portfolio" }, multiple: 3 });

      const category = await request(app)
        .post("/api/v1/alert-rules")
        .set(auth)
        .send({ name: `${P} filings`, definition: { type: "category", scope: { kind: "statement_family", family: "banking" }, categories: ["results", "dividend"] } });
      expect(category.status).toBe(201);
      const refused = await request(app).patch(`/api/v1/alert-rules/${category.body.id}`).set(auth).send({ threshold: 3 });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toEqual({ code: "bad_request", message: "Category rules have no threshold" });
    });

    it("hides a rule whose stored definition no longer validates, and refuses to retune it", async () => {
      const [broken] = await sql<{ id: string }[]>`
        INSERT INTO alert_rules (name, definition) VALUES (${`${P} broken`}, ${sql.json({ type: "price_move", thresholdPct: "lots" })})
        RETURNING id`;
      const { app } = await buildDbApp(sql);
      const list = (await request(app).get("/api/v1/alert-rules").set(auth)).body as { id: string }[];
      expect(list.some((r) => r.id === broken!.id)).toBe(false);
      const retune = await request(app).patch(`/api/v1/alert-rules/${broken!.id}`).set(auth).send({ threshold: 5 });
      expect(retune.status).toBe(400);
      expect(retune.body.error.message).toContain("stored definition is invalid");

      const rename = await request(app).patch(`/api/v1/alert-rules/${broken!.id}`).set(auth).send({ name: `${P} renamed`, enabled: false });
      expect(rename.status).toBe(400);
      expect(rename.body.error.message).toContain("stored definition is invalid");
      const [after] = await sql<{ name: string; enabled: boolean }[]>`SELECT name, enabled FROM alert_rules WHERE id = ${broken!.id}`;
      expect(after).toEqual({ name: `${P} broken`, enabled: true });
    });

    it("lists alerts newest first as Alert[] and marks one read idempotently", async () => {
      const { app } = await buildDbApp(sql);
      const rule = await request(app)
        .post("/api/v1/alert-rules")
        .set(auth)
        .send({ name: `${P} alerts`, definition: { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 3 } });
      const [alert] = await sql<{ id: string }[]>`
        INSERT INTO alerts (rule_id, symbol, kind, event_key, title, body, session_date)
        VALUES (${rule.body.id}, ${`${P}X`}, 'price_move', ${`${P}-event-1`}, 'ZTPMX up 3.2%', 'Closed at 101', '2026-11-13')
        RETURNING id`;
      const list = expectParse(z.array(AlertSchema), (await request(app).get("/api/v1/alerts?limit=100").set(auth)).body, "alerts");
      const mine = list.find((a) => a.id === alert!.id);
      expect(mine).toMatchObject({ ruleId: rule.body.id, ruleName: `${P} alerts`, sessionDate: "2026-11-13", announcementId: null, readAt: null });

      expect((await request(app).post(`/api/v1/alerts/${alert!.id}/read`).set(auth)).status).toBe(204);
      const [first] = await sql<{ readAt: Date }[]>`SELECT read_at AS "readAt" FROM alerts WHERE id = ${alert!.id}`;
      expect(first!.readAt).toBeInstanceOf(Date);
      expect((await request(app).post(`/api/v1/alerts/${alert!.id}/read`).set(auth)).status).toBe(204);
      const [second] = await sql<{ readAt: Date }[]>`SELECT read_at AS "readAt" FROM alerts WHERE id = ${alert!.id}`;
      expect(second!.readAt.getTime()).toBe(first!.readAt.getTime());
      const refreshed = (await request(app).get("/api/v1/alerts?limit=100").set(auth)).body as { id: string; readAt: string | null }[];
      expect(refreshed.find((a) => a.id === alert!.id)!.readAt).toBe(first!.readAt.toISOString());

      expect((await request(app).post("/api/v1/alerts/00000000-0000-4000-8000-000000000000/read").set(auth)).status).toBe(404);
    });
  });

  describe("push subscriptions (committed ZTPM endpoints, removed in afterAll)", () => {
    const endpoint = `${testPushEndpoint(P)}-${Date.now()}`;
    const keysFor = () => sql<{ p256dh: string; auth: string }[]>`SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ${endpoint}`;

    it("upserts by endpoint and deletes idempotently", async () => {
      const { app } = await buildDbApp(sql);
      const first = await request(app).post("/api/v1/push-subscriptions").set(auth).send({ endpoint, keys: { p256dh: "key-1", auth: "auth-1" } });
      expect(first.status).toBe(201);
      expect(first.body).toEqual({ ok: true });
      expect(await keysFor()).toEqual([{ p256dh: "key-1", auth: "auth-1" }]);

      const again = await request(app).post("/api/v1/push-subscriptions").set(auth).send({ endpoint, keys: { p256dh: "key-2", auth: "auth-2" } });
      expect(again.status).toBe(201);
      expect(await keysFor()).toEqual([{ p256dh: "key-2", auth: "auth-2" }]);

      expect((await request(app).delete("/api/v1/push-subscriptions").set(auth).send({ endpoint })).status).toBe(204);
      expect(await keysFor()).toEqual([]);
      expect((await request(app).delete("/api/v1/push-subscriptions").set(auth).send({ endpoint })).status).toBe(204);
    });

    it("reports push as disabled without VAPID keys and sends nothing on /push/test", async () => {
      const { app } = await buildDbApp(sql);
      expect((await request(app).get("/api/v1/push/vapid-public-key").set(auth)).body).toEqual({ enabled: false, publicKey: null });
      expect((await request(app).post("/api/v1/push/test").set(auth).send({ endpoint })).body).toEqual({ sent: 0, failed: 0, pruned: 0 });
    });

    it("/push/test sends only to the stored subscription named in the body, never to the others", async () => {
      const mine = `${testPushEndpoint(P)}-mine-${Date.now()}`;
      const other = `${testPushEndpoint(P)}-other-${Date.now()}`;
      const send = vi.fn<PushSender["send"]>(async () => ({ ok: true }));
      const push = createPushService({ repo: createPushRepository(sql), sender: { send }, vapidPublicKey: "BPK", log: silentLog });
      const { app } = await buildDbApp(sql, { services: { push } });
      for (const e of [mine, other]) {
        expect((await request(app).post("/api/v1/push-subscriptions").set(auth).send({ endpoint: e, keys: { p256dh: "k", auth: "a" } })).status).toBe(201);
      }

      const res = await request(app).post("/api/v1/push/test").set(auth).send({ endpoint: mine });
      expect(res.body).toEqual({ sent: 1, failed: 0, pruned: 0 });
      expect(send.mock.calls.map(([sub]) => sub.endpoint)).toEqual([mine]);

      const unknown = await request(app).post("/api/v1/push/test").set(auth).send({ endpoint: `${testPushEndpoint(P)}-never-registered` });
      expect(unknown.status).toBe(404);
      expect(send).toHaveBeenCalledTimes(1);
      await sql`DELETE FROM push_subscriptions WHERE endpoint IN (${mine}, ${other})`;
    });

    it("exposes the public key once VAPID is configured", async () => {
      const { app, deps } = await buildDbApp(sql, { env: { VAPID_PUBLIC_KEY: "BPublicKeyForTests", VAPID_PRIVATE_KEY: "private-key-for-tests" } });
      expect((await request(app).get("/api/v1/push/vapid-public-key").set(auth)).body).toEqual({ enabled: true, publicKey: "BPublicKeyForTests" });
      expect(deps.services.push.publicKey().enabled).toBe(true);
    });
  });

  // Everything below runs in a transaction that is rolled back, so the shared user_prefs row,
  // interactions and synthetic announcements never become visible to anyone else.
  describe("prefs (rolled back)", () => {
    it("merges category weights, keeps untouched fields and clears quiet hours with null", () =>
      inRollback(sql, async (tx) => {
        const { app } = await buildDbApp(tx);
        await tx`UPDATE user_prefs SET category_weights = '{"capex": 1.3}'::jsonb, default_window = '24h', quiet_hours = NULL WHERE id = 1`;
        const put = (body: object) => request(app).put("/api/v1/prefs").set(auth).send(body);

        const a = expectParse(PrefsSchema, (await put({ categoryWeights: { dividend: 1.2 } })).body, "prefs");
        expect(a.categoryWeights).toEqual({ capex: 1.3, dividend: 1.2 });
        expect((await put({ categoryWeights: { results: 0.8 } })).body.categoryWeights).toEqual({ capex: 1.3, dividend: 1.2, results: 0.8 });
        expect((await put({ categoryWeights: { dividend: 0.5 } })).body.categoryWeights).toEqual({ capex: 1.3, dividend: 0.5, results: 0.8 });

        const windowOnly = await put({ defaultWindow: "7d" });
        expect(windowOnly.body).toMatchObject({ defaultWindow: "7d", quietHours: null, categoryWeights: { capex: 1.3, dividend: 0.5, results: 0.8 } });

        const quiet = { enabled: true, start: "22:30", end: "07:00" };
        expect((await put({ quietHours: quiet })).body).toMatchObject({ quietHours: quiet, defaultWindow: "7d" });
        expect((await put({ categoryWeights: {} })).body.quietHours).toEqual(quiet);
        expect((await put({ quietHours: null })).body).toMatchObject({ quietHours: null, defaultWindow: "7d" });

        expect((await request(app).get("/api/v1/prefs").set(auth)).body).toMatchObject({ defaultWindow: "7d", quietHours: null });
      }));

    it("accepts USER_WEIGHT_RANGE bounds, rejects values outside, and clamps stored values on read", () =>
      inRollback(sql, async (tx) => {
        const { app } = await buildDbApp(tx);
        const put = (weight: number) => request(app).put("/api/v1/prefs").set(auth).send({ categoryWeights: { dividend: weight } });
        expect((await put(USER_WEIGHT_RANGE.max)).status).toBe(200);
        expect((await put(USER_WEIGHT_RANGE.min)).status).toBe(200);
        const over = await put(USER_WEIGHT_RANGE.max + 0.01);
        expect(over.status).toBe(400);
        expect(over.body.error.details[0].path).toBe("categoryWeights.dividend");
        expect((await put(USER_WEIGHT_RANGE.min - 0.01)).status).toBe(400);

        await tx`
          UPDATE user_prefs
          SET category_weights = '{"dividend": 9, "results": 0.01, "made_up": 1, "litigation": "1.1", "capex": "abc"}'::jsonb,
              default_window = '1y', quiet_hours = '{"enabled": "yes"}'::jsonb
          WHERE id = 1`;
        const res = await request(app).get("/api/v1/prefs").set(auth);
        expect(expectParse(PrefsSchema, res.body, "clamped prefs")).toMatchObject({
          categoryWeights: { dividend: USER_WEIGHT_RANGE.max, results: USER_WEIGHT_RANGE.min, litigation: 1.1 },
          defaultWindow: "24h",
          quietHours: null,
        });
        expect(Object.keys(res.body.categoryWeights).sort()).toEqual(["dividend", "litigation", "results"]);
      }));
  });

  describe("interactions (rolled back)", () => {
    it("records each action and nudges the category weight with the real learner, clamped to USER_WEIGHT_RANGE", () =>
      inRollback(sql, async (tx) => {
        await insertCompany(tx, `${P}I`);
        await insertAnnouncement(tx, { seq: `${P}-I-DIV`, symbol: `${P}I`, at: new Date(), category: "dividend" });
        await insertAnnouncement(tx, { seq: `${P}-I-UNC`, symbol: `${P}I`, at: new Date(), category: "unclassified" });
        await insertAnnouncement(tx, { seq: `${P}-I-NULL`, symbol: `${P}I`, at: new Date(), category: null });
        await tx`UPDATE user_prefs SET category_weights = category_weights - 'dividend' WHERE id = 1`;
        const { app } = await buildDbApp(tx);
        const act = async (seqId: string, action: string) => {
          const res = await request(app).post("/api/v1/interactions").set(auth).send({ seqId, action });
          expect(res.status).toBe(201);
          return expectParse(InteractionResponseSchema, res.body, "interaction");
        };

        expect(await act(`${P}-I-DIV`, "pin")).toEqual({ ok: true, category: "dividend", weight: 1.1 });
        expect((await act(`${P}-I-DIV`, "dismiss")).weight).toBe(1.02);
        expect((await act(`${P}-I-DIV`, "undo_dismiss")).weight).toBe(1.1);
        expect((await act(`${P}-I-DIV`, "open")).weight).toBe(1.13);
        const [stored] = await tx<{ w: number }[]>`SELECT (category_weights ->> 'dividend')::float8 AS w FROM user_prefs WHERE id = 1`;
        expect(stored!.w).toBe(1.13);
        const recorded = await tx<{ action: string; category: string }[]>`SELECT action, category FROM interactions WHERE seq_id = ${`${P}-I-DIV`} ORDER BY id`;
        expect(recorded).toEqual(["pin", "dismiss", "undo", "open"].map((action) => ({ action, category: "dividend" })));

        await request(app).put("/api/v1/prefs").set(auth).send({ categoryWeights: { dividend: 1.58 } });
        expect((await act(`${P}-I-DIV`, "pin")).weight).toBe(USER_WEIGHT_RANGE.max);
        await request(app).put("/api/v1/prefs").set(auth).send({ categoryWeights: { dividend: 0.42 } });
        expect((await act(`${P}-I-DIV`, "dismiss")).weight).toBe(USER_WEIGHT_RANGE.min);

        expect(await act(`${P}-I-UNC`, "pin")).toEqual({ ok: true, category: null, weight: null });
        expect(await act(`${P}-I-NULL`, "open")).toEqual({ ok: true, category: null, weight: null });
        const [unc] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM interactions WHERE seq_id IN (${`${P}-I-UNC`}, ${`${P}-I-NULL`})`;
        expect(unc!.n).toBe(2);

        const missing = await request(app).post("/api/v1/interactions").set(auth).send({ seqId: `${P}-NOPE`, action: "open" });
        expect(missing.status).toBe(404);
      }));
  });

  describe("digest windows and clustering (rolled back)", () => {
    it("selects heads by window, links children oldest first, and drops dismissed, non-ready and non-holding items", () =>
      inRollback(sql, async (tx) => {
        const now = Date.now();
        const ago = (ms: number) => new Date(now - ms);
        const H = `${P}H`;
        await insertCompany(tx, H, { holding: true, name: "ZTPM Holding Ltd" });
        await insertCompany(tx, `${P}N`);
        const seed: AnnouncementSeed[] = [
          { seq: `${P}-H1`, symbol: H, at: ago(2 * HOUR), tier: "act", score: 80, card: { kind: "generic", oneLiner: "x" } },
          { seq: `${P}-C1`, symbol: H, at: ago(1 * HOUR), status: "enriched", tier: "noise", parent: `${P}-H1` },
          { seq: `${P}-C2`, symbol: H, at: ago(1.5 * HOUR), parent: `${P}-H1` },
          { seq: `${P}-H4`, symbol: H, at: ago(3 * HOUR), tier: "act", score: 90 },
          { seq: `${P}-H5`, symbol: H, at: ago(4 * HOUR), tier: "know", score: 50 },
          { seq: `${P}-H6`, symbol: H, at: ago(1 * HOUR), status: "enriched", tier: "act", score: 99 },
          { seq: `${P}-H7`, symbol: `${P}N`, at: ago(1 * HOUR), tier: "act", score: 99 },
          { seq: `${P}-H2`, symbol: H, at: ago(36 * HOUR), tier: "know", score: 55 },
          { seq: `${P}-C3`, symbol: H, at: ago(10 * DAY), parent: `${P}-H2` },
          { seq: `${P}-H3`, symbol: H, at: ago(5 * DAY), tier: null, score: 10, card: { kind: "results", bogus: true } },
          { seq: `${P}-H8`, symbol: H, at: ago(20 * DAY), tier: "act", score: 75 },
        ];
        for (const a of seed) await insertAnnouncement(tx, a);
        const { app } = await buildDbApp(tx);

        const dismiss = (seqId: string, action = "dismiss") => request(app).post("/api/v1/interactions").set(auth).send({ seqId, action });
        expect((await dismiss(`${P}-H4`)).status).toBe(201);
        await dismiss(`${P}-H5`);
        await dismiss(`${P}-H5`, "undo_dismiss");

        const digest = async (query: Record<string, string>) => {
          const res = await request(app).get("/api/v1/digest").query(query).set(auth);
          expect(res.status, JSON.stringify(query)).toBe(200);
          const body = expectParse(DigestResponseSchema, res.body, `digest ${JSON.stringify(query)}`);
          const mine = [...body.act, ...body.know, ...body.noise].filter((i) => i.symbol === H);
          return { body, ids: mine.map((i) => i.id).sort(), byId: new Map(mine.map((i) => [i.id, i])) };
        };
        const iso = (ms: number) => ago(ms).toISOString();

        const day = await digest({ window: "24h" });
        expect(day.ids).toEqual([`${P}-H1`, `${P}-H5`]);
        expect(day.byId.get(`${P}-H1`)!.linked.map((l) => l.seqId)).toEqual([`${P}-C2`, `${P}-C1`]);
        expect(day.byId.get(`${P}-H1`)).toMatchObject({ tier: "act", companyName: "ZTPM Holding Ltd", card: { kind: "generic", oneLiner: "x" } });
        expect(day.body.act.map((i) => i.id)).toContain(`${P}-H1`);
        expect(day.body.know.map((i) => i.id)).toContain(`${P}-H5`);
        expect((await digest({})).ids).toEqual(day.ids);

        const three = await digest({ window: "3d" });
        expect(three.ids).toEqual([`${P}-H1`, `${P}-H2`, `${P}-H5`]);
        expect(three.byId.get(`${P}-H2`)!.linked.map((l) => l.seqId)).toEqual([`${P}-C3`]);

        const week = await digest({ window: "7d" });
        expect(week.ids).toEqual([`${P}-H1`, `${P}-H2`, `${P}-H3`, `${P}-H5`]);
        expect(week.byId.get(`${P}-H3`)).toMatchObject({ tier: "noise", card: null });

        expect((await digest({ from: iso(6 * DAY), to: iso(1 * DAY) })).ids).toEqual([`${P}-H2`, `${P}-H3`]);
        expect((await digest({ from: iso(2.5 * HOUR) })).ids).toEqual([`${P}-H1`]);
        expect((await digest({ to: iso(30 * HOUR) })).ids).toEqual([`${P}-H2`]);
        const custom = await digest({ from: iso(25 * DAY), to: iso(15 * DAY) });
        expect(custom.ids).toEqual([`${P}-H8`]);
        expect(custom.body.window).toEqual({ from: iso(25 * DAY), to: iso(15 * DAY) });

        const inverted = await request(app).get("/api/v1/digest").query({ from: iso(1 * DAY), to: iso(2 * DAY) }).set(auth);
        expect(inverted.status).toBe(400);
        expect(inverted.body.error).toEqual({ code: "bad_request", message: "`from` must be before `to`" });
        const huge = await request(app).get("/api/v1/digest").query({ from: iso(40 * DAY), to: iso(0) }).set(auth);
        expect(huge.status).toBe(400);
        const notDate = await request(app).get("/api/v1/digest").query({ from: "yesterday" }).set(auth);
        expect(notDate.status).toBe(400);
        expect(notDate.body.error.details[0].path).toBe("from");

        await dismiss(`${P}-H1`);
        expect((await digest({ window: "24h" })).ids).toEqual([`${P}-H5`]);

        const detail = await request(app).get(`/api/v1/announcements/${P}-H1`).set(auth);
        expect(expectParse(AnnouncementDetailSchema, detail.body, "detail")).toMatchObject({
          id: `${P}-H1`,
          parentId: null,
          status: "ready",
          dismissed: true,
          bodyText: null,
          linked: [{ seqId: `${P}-C2` }, { seqId: `${P}-C1` }],
        });
        const child = await request(app).get(`/api/v1/announcements/${P}-C1`).set(auth);
        expect(child.body).toMatchObject({ parentId: `${P}-H1`, status: "enriched", dismissed: false, linked: [] });
        expect((await request(app).get(`/api/v1/announcements/${P}-NOPE`).set(auth)).status).toBe(404);

        // Unread = act/know heads from the last 7 days never opened, dismissed or pinned: only H2 (H5's undo still counts as read).
        const holdings = (await request(app).get("/api/v1/holdings").set(auth)).body as { symbol: string; unreadCount: number; close: null }[];
        expect(holdings.find((h) => h.symbol === H)).toMatchObject({ unreadCount: 1, close: null, sparkline: [] });
      }));
  });

  describe("companies (rolled back)", () => {
    it("searches by symbol prefix or name and serves empty financials for a company with no filings", () =>
      inRollback(sql, async (tx) => {
        await insertCompany(tx, `${P}CO`, { name: "Zeta Tapioca Mills", family: "industrial", holding: true });
        const { app } = await buildDbApp(tx);
        const bySymbol = expectParse(z.array(CompanySearchResultSchema), (await request(app).get(`/api/v1/companies/search?q=${P.toLowerCase()}co`).set(auth)).body, "search");
        expect(bySymbol[0]).toEqual({ symbol: `${P}CO`, name: "Zeta Tapioca Mills", statementFamily: "industrial", isHolding: true });
        const byName = (await request(app).get("/api/v1/companies/search?q=tapioca").set(auth)).body as { symbol: string }[];
        expect(byName.map((r) => r.symbol)).toContain(`${P}CO`);

        const fin = await request(app).get(`/api/v1/companies/${P}CO/financials`).set(auth);
        expect(expectParse(FinancialsResponseSchema, fin.body, "financials")).toEqual({
          symbol: `${P}CO`,
          name: "Zeta Tapioca Mills",
          statementFamily: "industrial",
          basis: null,
          quarters: [],
          history: [],
        });
        expect((await request(app).get(`/api/v1/companies/${P}NONE/financials`).set(auth)).status).toBe(404);
      }));
  });

  describe("rule preview backtests on real price rows (rolled back)", () => {
    it("fires on an exact-threshold move that floating point would put just under it", () =>
      inRollback(sql, async (tx) => {
        // 3.20 -> 3.36 is exactly +5%, but (3.36 / 3.2 - 1) * 100 is 4.999999999999982 in floating point.
        expect((3.36 / 3.2 - 1) * 100).toBeLessThan(5);
        await insertCompany(tx, `${P}EX`);
        await insertPrices(tx, `${P}EX`, [3.2, 3.36, 3.36]);
        await insertCompany(tx, `${P}UN`);
        await insertPrices(tx, `${P}UN`, [100, 104.99, 104.99]);
        const { app } = await buildDbApp(tx);

        const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: `tell me when ${P}EX or ${P}UN rises 5%` });
        expect(res.status).toBe(200);
        const preview = expectParse(PreviewResponseSchema, res.body, "preview");
        expect(preview.definition).toEqual({ type: "price_move", scope: { kind: "symbols", symbols: [`${P}EX`, `${P}UN`] }, direction: "up", thresholdPct: 5 });
        expect(preview.resolvedSymbols).toEqual([`${P}EX`, `${P}UN`]);
        expect(preview.backtest).toEqual({ sessions: 3, fires: 1, bySymbol: [{ symbol: `${P}EX`, fires: 1, lastFiredOn: "2026-10-02" }], note: null });
        expect(preview.explanation).toContain(`It would have fired 1 time in the last 3 sessions (${P}EX).`);
      }));

    it("suppresses moves on bonus/split filing days and replays volume spikes", () =>
      inRollback(sql, async (tx) => {
        await insertCompany(tx, `${P}BS`);
        await insertPrices(tx, `${P}BS`, [100, 50, 50]);
        // Filed at 10:00 IST on the split day (2026-10-02).
        await insertAnnouncement(tx, { seq: `${P}-SPLIT`, symbol: `${P}BS`, at: new Date("2026-10-02T04:30:00Z"), category: "bonus_split" });
        await insertCompany(tx, `${P}VO`);
        const volumes = Array.from({ length: 25 }, (_, i) => (i === 22 ? 3_100_000 : 1_000_000));
        await insertPrices(tx, `${P}VO`, Array(25).fill(100), volumes);
        const { app } = await buildDbApp(tx);

        const split = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: `alert me if ${P}BS falls 10%` });
        expect(split.body.definition).toMatchObject({ type: "price_move", direction: "down" });
        expect(split.body.backtest).toMatchObject({ sessions: 3, fires: 0 });
        expect(split.body.explanation).toContain("would not have fired in the last 3 sessions");

        const volume = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: `volume 3x on ${P}VO` });
        expect(volume.body.definition).toEqual({ type: "volume_spike", scope: { kind: "symbols", symbols: [`${P}VO`] }, multiple: 3 });
        expect(volume.body.backtest).toMatchObject({ fires: 1, bySymbol: [{ symbol: `${P}VO`, fires: 1, lastFiredOn: "2026-10-23" }] });
      }));

    it("counts ready filings for category rules and explains empty scopes", () =>
      inRollback(sql, async (tx) => {
        await insertCompany(tx, `${P}CA`);
        await insertAnnouncement(tx, { seq: `${P}-R1`, symbol: `${P}CA`, at: new Date(Date.now() - 2 * DAY), category: "results" });
        await insertAnnouncement(tx, { seq: `${P}-R2`, symbol: `${P}CA`, at: new Date(Date.now() - 1 * DAY), category: "results", parent: `${P}-R1` });
        await insertAnnouncement(tx, { seq: `${P}-R3`, symbol: `${P}CA`, at: new Date(Date.now() - 60 * DAY), category: "results" });
        const { app } = await buildDbApp(tx);

        const res = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: `new results from ${P}CA` });
        const preview = expectParse(PreviewResponseSchema, res.body, "category preview");
        expect(preview.definition).toEqual({ type: "category", scope: { kind: "symbols", symbols: [`${P}CA`] }, categories: ["results"] });
        expect(preview.backtest).toMatchObject({ fires: 1, bySymbol: [{ symbol: `${P}CA`, fires: 1 }] });
        expect(preview.explanation).toContain("1 matching filing in the last 30 sessions.");

        const banks = await request(app).post("/api/v1/alert-rules/preview").set(auth).send({ text: "any bank moves 3%" });
        expect(banks.body.definition.scope).toEqual({ kind: "statement_family", family: "banking" });
        const bankHoldings = await tx<{ symbol: string }[]>`
          SELECT h.symbol FROM holdings h JOIN companies c USING (symbol) WHERE c.statement_family = 'banking' ORDER BY h.symbol`;
        // Other suites add and remove ZT-prefixed holdings concurrently, so compare only real holdings.
        const real = (symbols: string[]) => symbols.filter((s) => !s.startsWith("ZT"));
        expect(real(banks.body.resolvedSymbols)).toEqual(real(bankHoldings.map((r) => r.symbol)));
      }));
  });

  describe("ask and the LLM budget on the real wiring", () => {
    it("refuses up front once LLM_DAILY_CALL_BUDGET is used up", async () => {
      const { app } = await buildDbApp(sql, { env: { LLM_DAILY_CALL_BUDGET: "0" } });
      const res = await request(app).post("/api/v1/ask").set(auth).send({ symbol: "TCS", question: "What is the margin outlook?" });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("llm_budget_exhausted");
    });

    it("404s for a company that is not in the master list", async () => {
      const { app } = await buildDbApp(sql);
      const res = await request(app).post("/api/v1/ask").set(auth).send({ symbol: `${P}NONE`, question: "What is the margin outlook?" });
      expect(res.status).toBe(404);
    });
  });

  describe("maintenance jobs on the container's own registry (rolled back)", () => {
    it("lists both jobs and runs prune-llm-cache", () =>
      inRollback(sql, async (tx) => {
        const { container } = await buildDbApp(tx);
        expect(container.deps.services.jobs.list().map((j) => j.name)).toEqual(["dispatch-research", "prune-llm-cache"]);
        const result = await container.deps.services.jobs.get("prune-llm-cache")!.run();
        expect(result).toEqual({ deleted: expect.any(Number) });
        expect(await container.deps.services.health.check()).toMatchObject({ ok: true, db: "up" });
        await container.close();
      }));
  });
});
