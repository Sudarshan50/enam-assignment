import { type RequestHandler, Router } from "express";
import { AskRequestSchema, AskResponseSchema } from "@finn/shared";
import { sendJson } from "../../http/respond";
import { type LlmBudget, requireLlmBudget } from "../../middleware/budget";
import { validate } from "../../middleware/validate";
import type { AskService } from "../../services/askService";

export function askRouter(deps: { ask: AskService; budget: LlmBudget; limiter: RequestHandler }): Router {
  const router = Router();
  router.post(
    "/ask",
    deps.limiter,
    requireLlmBudget(deps.budget),
    validate({ body: AskRequestSchema }, async ({ body }, _req, res) => {
      sendJson(res, AskResponseSchema, await deps.ask.ask(body));
    }),
  );
  return router;
}
