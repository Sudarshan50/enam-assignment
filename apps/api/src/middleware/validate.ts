import type { Request, RequestHandler, Response } from "express";
import type { z } from "zod";

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

type Parsed<S extends Schemas, K extends keyof Schemas> = S extends { [P in K]: infer T extends z.ZodType } ? z.output<T> : undefined;

export interface ValidatedInput<S extends Schemas> {
  body: Parsed<S, "body">;
  query: Parsed<S, "query">;
  params: Parsed<S, "params">;
}

/**
 * Parses body/query/params with zod before the handler runs and hands it typed input.
 * A ZodError propagates to the error handler and becomes a 400.
 */
export function validate<S extends Schemas>(
  schemas: S,
  handler: (input: ValidatedInput<S>, req: Request, res: Response) => unknown,
): RequestHandler {
  return async (req, res) => {
    const input = {
      body: schemas.body ? schemas.body.parse(req.body ?? {}) : undefined,
      query: schemas.query ? schemas.query.parse(req.query) : undefined,
      params: schemas.params ? schemas.params.parse(req.params) : undefined,
    } as ValidatedInput<S>;
    await handler(input, req, res);
  };
}
