import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { rateLimited } from "../http/errors";

export interface RateLimitRule {
  windowMs: number;
  limit: number;
}

/** Per-IP fixed window (in-memory; one Render instance). Relies on `trust proxy` for the client IP. */
export function createRateLimiter(name: string, rule: RateLimitRule, message?: string): RequestHandler {
  return rateLimit({
    windowMs: rule.windowMs,
    limit: rule.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    identifier: name,
    handler: (_req, _res, next) => next(rateLimited(message)),
  });
}
