import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { unauthorized } from "../http/errors";

export const ACCESS_COOKIE = "finn_access";
export const ACCESS_HEADER = "x-finn-access";

/** Constant-time comparison; hashing first makes the comparison length-independent. */
export function safeEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedTokens(req: Request): string[] {
  const tokens: string[] = [];
  const header = req.get(ACCESS_HEADER);
  if (header) tokens.push(header);
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[ACCESS_COOKIE];
  if (typeof cookie === "string" && cookie) tokens.push(cookie);
  return tokens;
}

/** Single-user demo gate: the shared access token via the `finn_access` cookie or `x-finn-access` header. */
export function requireDemoToken(expected: string): RequestHandler {
  return (req, _res, next) => {
    if (presentedTokens(req).some((t) => safeEqual(t, expected))) return next();
    next(unauthorized());
  };
}

/** `Authorization: Bearer <secret>` for machine callers (cron, GitHub Actions). */
export function requireBearer(secret: string): RequestHandler {
  return (req, _res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
    if (match?.[1] && safeEqual(match[1].trim(), secret)) return next();
    next(unauthorized());
  };
}
