import type { Response } from "express";
import type { z } from "zod";
import { ResponseContractError } from "./errors";

export type ResponseValidationMode = "strict" | "warn" | "off";

/**
 * Sends a JSON body after checking it against its contract. `strict` (tests) turns a mismatch into a 500,
 * `warn` (development) logs it and sends anyway, `off` (production) skips the check.
 */
export function sendJson<S extends z.ZodType>(res: Response, schema: S, body: z.input<S>, status = 200): void {
  const mode = (res.app.locals.responseValidation ?? "off") as ResponseValidationMode;
  if (mode !== "off") {
    const result = schema.safeParse(body);
    if (!result.success) {
      if (mode === "strict") throw new ResponseContractError(result.error.issues);
      res.req.log?.warn({ issues: result.error.issues, path: res.req.path }, "response does not match its schema");
    }
  }
  res.status(status).json(body);
}
