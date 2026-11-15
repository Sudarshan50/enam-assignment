import { Router } from "express";
import { z } from "zod";
import { AlertRuleSchema, AlertSchema, CreateAlertRuleSchema, PreviewAlertRuleSchema } from "@finn/shared";
import { AlertsQuerySchema, PreviewResponseSchema, UpdateAlertRuleSchema, UuidParamSchema } from "../../contracts";
import { sendJson } from "../../http/respond";
import { validate } from "../../middleware/validate";
import type { AlertRuleService, AlertService } from "../../services/alertRuleService";

export function alertsRouter(deps: { rules: AlertRuleService; alerts: AlertService }): Router {
  const router = Router();

  router.get("/alert-rules", async (_req, res) => {
    sendJson(res, z.array(AlertRuleSchema), await deps.rules.list());
  });

  router.post(
    "/alert-rules/preview",
    validate({ body: PreviewAlertRuleSchema }, async ({ body }, _req, res) => {
      sendJson(res, PreviewResponseSchema, await deps.rules.preview(body.text));
    }),
  );

  router.post(
    "/alert-rules",
    validate({ body: CreateAlertRuleSchema }, async ({ body }, _req, res) => {
      sendJson(res, AlertRuleSchema, await deps.rules.create(body), 201);
    }),
  );

  router.patch(
    "/alert-rules/:id",
    validate({ params: UuidParamSchema, body: UpdateAlertRuleSchema }, async ({ params, body }, _req, res) => {
      sendJson(res, AlertRuleSchema, await deps.rules.update(params.id, body));
    }),
  );

  router.delete(
    "/alert-rules/:id",
    validate({ params: UuidParamSchema }, async ({ params }, _req, res) => {
      await deps.rules.remove(params.id);
      res.status(204).end();
    }),
  );

  router.get(
    "/alerts",
    validate({ query: AlertsQuerySchema }, async ({ query }, _req, res) => {
      sendJson(res, z.array(AlertSchema), await deps.alerts.list(query.limit));
    }),
  );

  router.post(
    "/alerts/:id/read",
    validate({ params: UuidParamSchema }, async ({ params }, _req, res) => {
      await deps.alerts.markRead(params.id);
      res.status(204).end();
    }),
  );

  return router;
}
