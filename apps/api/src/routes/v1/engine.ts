import { Router } from "express";
import { EngineResponseSchema } from "../../contracts";
import { sendJson } from "../../http/respond";
import type { EngineService } from "../../services/engineService";

export function engineRouter(engine: EngineService): Router {
  const router = Router();
  router.get("/engine", async (_req, res) => {
    sendJson(res, EngineResponseSchema, await engine.stats());
  });
  return router;
}
