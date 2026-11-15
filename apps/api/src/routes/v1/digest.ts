import { Router } from "express";
import { DigestQuerySchema, DigestResponseSchema } from "@finn/shared";
import { AnnouncementDetailSchema, InteractionRequestSchema, InteractionResponseSchema, SeqIdParamSchema } from "../../contracts";
import { sendJson } from "../../http/respond";
import { validate } from "../../middleware/validate";
import type { AnnouncementService } from "../../services/announcementService";
import type { DigestService } from "../../services/digestService";
import type { InteractionService } from "../../services/interactionService";

export function digestRouter(deps: { digest: DigestService; announcements: AnnouncementService; interactions: InteractionService }): Router {
  const router = Router();

  router.get(
    "/digest",
    validate({ query: DigestQuerySchema }, async ({ query }, _req, res) => {
      sendJson(res, DigestResponseSchema, await deps.digest.getDigest(query));
    }),
  );

  router.get(
    "/announcements/:seqId",
    validate({ params: SeqIdParamSchema }, async ({ params }, _req, res) => {
      sendJson(res, AnnouncementDetailSchema, await deps.announcements.getDetail(params.seqId));
    }),
  );

  router.post(
    "/interactions",
    validate({ body: InteractionRequestSchema }, async ({ body }, _req, res) => {
      sendJson(res, InteractionResponseSchema, await deps.interactions.record(body), 201);
    }),
  );

  return router;
}
