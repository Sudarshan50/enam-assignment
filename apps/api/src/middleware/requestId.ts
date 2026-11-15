import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const ACCEPTED_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Reuses an upstream x-request-id when it looks sane (Render, Vercel), otherwise mints one. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get("x-request-id");
    const id = incoming && ACCEPTED_ID.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader("x-request-id", id);
    next();
  };
}
