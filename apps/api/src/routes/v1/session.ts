import { type CookieOptions, Router } from "express";
import { OkSchema, SessionRequestSchema } from "../../contracts";
import { unauthorized } from "../../http/errors";
import { sendJson } from "../../http/respond";
import { ACCESS_COOKIE, safeEqual } from "../../middleware/auth";
import { validate } from "../../middleware/validate";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionRouter(opts: { demoAccessToken: string; secureCookie: boolean }): Router {
  const router = Router();
  const cookie: CookieOptions = { httpOnly: true, sameSite: "lax", secure: opts.secureCookie, path: "/" };

  router.post(
    "/session",
    validate({ body: SessionRequestSchema }, ({ body }, _req, res) => {
      if (!safeEqual(body.token, opts.demoAccessToken)) throw unauthorized();
      res.cookie(ACCESS_COOKIE, opts.demoAccessToken, { ...cookie, maxAge: THIRTY_DAYS_MS });
      sendJson(res, OkSchema, { ok: true });
    }),
  );

  router.delete("/session", (_req, res) => {
    res.clearCookie(ACCESS_COOKIE, cookie);
    res.status(204).end();
  });

  return router;
}
