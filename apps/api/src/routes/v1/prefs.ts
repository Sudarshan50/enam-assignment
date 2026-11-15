import { Router } from "express";
import { PrefsSchema, UpdatePrefsSchema } from "../../contracts";
import { sendJson } from "../../http/respond";
import { validate } from "../../middleware/validate";
import type { PrefsService } from "../../services/prefsService";

export function prefsRouter(prefs: PrefsService): Router {
  const router = Router();

  router.get("/prefs", async (_req, res) => {
    sendJson(res, PrefsSchema, await prefs.get());
  });

  router.put(
    "/prefs",
    validate({ body: UpdatePrefsSchema }, async ({ body }, _req, res) => {
      sendJson(res, PrefsSchema, await prefs.update(body));
    }),
  );

  return router;
}
