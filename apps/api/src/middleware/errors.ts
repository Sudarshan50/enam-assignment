import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { type ErrorBody, HttpError, ResponseContractError } from "../http/errors";
import type { Logger } from "../lib/logger";

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => next(new HttpError(404, "not_found", `No route for ${req.method} ${req.path}`));
}

interface Mapped {
  status: number;
  body: ErrorBody;
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError || (err instanceof Error && err.name === "ZodError" && "issues" in err);
}

export function toErrorResponse(err: unknown, exposeInternals: boolean): Mapped {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } } };
  }
  if (isZodError(err)) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    const message = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : "Invalid request";
    return { status: 400, body: { error: { code: "validation_error", message, details: issues } } };
  }
  const bodyParserType = (err as { type?: string } | null)?.type;
  if (bodyParserType === "entity.too.large") {
    return { status: 413, body: { error: { code: "payload_too_large", message: "Request body is too large" } } };
  }
  if (bodyParserType === "entity.parse.failed") {
    return { status: 400, body: { error: { code: "invalid_json", message: "Request body is not valid JSON" } } };
  }
  if (err instanceof ResponseContractError) {
    return {
      status: 500,
      body: { error: { code: "response_contract", message: err.message, ...(exposeInternals ? { details: err.issues } : {}) } },
    };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "Something went wrong on our side" } } };
}

export function errorHandler(logger: Logger, exposeInternals: boolean): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const { status, body } = toErrorResponse(err, exposeInternals);
    if (status >= 500) (req.log ?? logger).error({ err }, "request failed");
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(body);
  };
}
