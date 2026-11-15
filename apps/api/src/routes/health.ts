import type { RequestHandler } from "express";
import { HealthSchema } from "../contracts";
import { sendJson } from "../http/respond";
import type { HealthService } from "../services/healthService";

/** Unauthenticated; also the keep-alive target for cron-job.org. */
export function healthHandler(service: HealthService): RequestHandler {
  return async (_req, res) => {
    const health = await service.check();
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, HealthSchema, health, health.ok ? 200 : 503);
  };
}
