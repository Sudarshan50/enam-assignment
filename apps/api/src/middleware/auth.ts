import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { unauthorized } from "../http/errors";

/** Constant-time comparison; hashing first makes the comparison length-independent. */
export function safeEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <secret>` for machine callers (cron, GitHub Actions). */
export function requireBearer(secret: string): RequestHandler {
  return (req, _res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
    if (match?.[1] && safeEqual(match[1].trim(), secret)) return next();
    next(unauthorized());
  };
}
