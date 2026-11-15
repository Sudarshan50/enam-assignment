export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const unauthorized = () => new HttpError(401, "unauthorized", "A valid access token is required");
export const rateLimited = (message = "Too many requests, slow down a little.") => new HttpError(429, "rate_limited", message);

export const llmBudgetExhausted = () =>
  new HttpError(
    429,
    "llm_budget_exhausted",
    "FINN has used today's AI budget. Questions open again after midnight IST; the digest, cards and saved research still work.",
  );

export const llmUnavailable = () =>
  new HttpError(503, "llm_unavailable", "The AI model is not reachable right now. Try again in a minute; cited research already saved still works.");

export const researchLimitReached = (limit: number) =>
  new HttpError(429, "research_limit_reached", `Today's limit of ${limit} new research runs is used up. Saved research stays available.`);

/** Thrown by sendJson in strict mode when a handler returns something that breaks its contract. */
export class ResponseContractError extends Error {
  constructor(readonly issues: unknown) {
    super("Response failed its schema");
    this.name = "ResponseContractError";
  }
}
