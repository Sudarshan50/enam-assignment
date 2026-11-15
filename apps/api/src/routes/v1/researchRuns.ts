import { type RequestHandler, Router } from "express";
import { CreateResearchRunSchema, ResearchRunSchema } from "@finn/shared";
import { CreateResearchRunResponseSchema, EventsQuerySchema, UuidParamSchema } from "../../contracts";
import { notFound } from "../../http/errors";
import { sendJson } from "../../http/respond";
import type { Logger } from "../../lib/logger";
import { validate } from "../../middleware/validate";
import { type ResearchEventsSource, type SseOptions, parseLastEventId, streamResearchEvents } from "../../services/researchEventStream";
import type { ResearchService } from "../../services/researchService";

export function researchRunsRouter(deps: {
  research: ResearchService;
  events: ResearchEventsSource;
  createLimiter: RequestHandler;
  sse: SseOptions;
  log: Logger;
  shutdownSignal?: AbortSignal;
}): Router {
  const router = Router();

  router.post(
    "/research-runs",
    deps.createLimiter,
    validate({ body: CreateResearchRunSchema }, async ({ body }, req, res) => {
      const result = await deps.research.create(body, { requestedBy: req.ip });
      sendJson(res, CreateResearchRunResponseSchema, result.body, result.status);
    }),
  );

  router.get(
    "/research-runs/:id",
    validate({ params: UuidParamSchema }, async ({ params }, _req, res) => {
      sendJson(res, ResearchRunSchema, await deps.research.getRun(params.id));
    }),
  );

  router.get(
    "/research-runs/:id/events",
    validate({ params: UuidParamSchema, query: EventsQuerySchema }, async ({ params, query }, req, res) => {
      if ((await deps.events.runStatus(params.id)) === null) throw notFound("Research run");
      await streamResearchEvents(req, res, {
        source: deps.events,
        runId: params.id,
        lastEventId: parseLastEventId(req.get("last-event-id"), query.lastEventId),
        options: deps.sse,
        log: req.log ?? deps.log,
        signal: deps.shutdownSignal,
      });
    }),
  );

  return router;
}
