import { Router } from "express";
import { PushSubscriptionSchema } from "@finn/shared";
import { DeletePushSubscriptionSchema, OkSchema, PushTestResponseSchema, VapidKeyResponseSchema } from "../../contracts";
import { sendJson } from "../../http/respond";
import { validate } from "../../middleware/validate";
import type { PushService } from "../../services/pushService";

export function pushRouter(push: PushService): Router {
  const router = Router();

  router.get("/push/vapid-public-key", (_req, res) => {
    sendJson(res, VapidKeyResponseSchema, push.publicKey());
  });

  router.post(
    "/push-subscriptions",
    validate({ body: PushSubscriptionSchema }, async ({ body }, _req, res) => {
      await push.subscribe(body);
      sendJson(res, OkSchema, { ok: true }, 201);
    }),
  );

  router.delete(
    "/push-subscriptions",
    validate({ body: DeletePushSubscriptionSchema }, async ({ body }, _req, res) => {
      await push.unsubscribe(body.endpoint);
      res.status(204).end();
    }),
  );

  router.post("/push/test", async (_req, res) => {
    sendJson(res, PushTestResponseSchema, await push.sendTest());
  });

  return router;
}
