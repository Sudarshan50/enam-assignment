import { type RequestHandler, Router } from "express";
import { z } from "zod";
import { isPushServiceEndpoint } from "@finn/db/repositories/push";
import { PushSubscriptionSchema } from "@finn/shared";
import { DeletePushSubscriptionSchema, OkSchema, PushTestResponseSchema, VapidKeyResponseSchema } from "../../contracts";
import { sendJson } from "../../http/respond";
import { validate } from "../../middleware/validate";
import type { PushService } from "../../services/pushService";

const PushEndpointSchema = z.url().refine(isPushServiceEndpoint, "Must be an https endpoint of a known Web Push service");
const SubscribeSchema = PushSubscriptionSchema.extend({ endpoint: PushEndpointSchema });
const PushTestSchema = z.object({ endpoint: PushEndpointSchema });

export function pushRouter(deps: { push: PushService; testLimiter: RequestHandler }): Router {
  const { push } = deps;
  const router = Router();

  router.get("/push/vapid-public-key", (_req, res) => {
    sendJson(res, VapidKeyResponseSchema, push.publicKey());
  });

  router.post(
    "/push-subscriptions",
    validate({ body: SubscribeSchema }, async ({ body }, _req, res) => {
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

  router.post(
    "/push/test",
    deps.testLimiter,
    validate({ body: PushTestSchema }, async ({ body }, _req, res) => {
      sendJson(res, PushTestResponseSchema, await push.sendTest(body.endpoint));
    }),
  );

  return router;
}
