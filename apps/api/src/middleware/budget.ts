import type { RequestHandler } from "express";
import { llmBudgetExhausted } from "../http/errors";

export interface LlmBudget {
  /** LLM calls left today (IST), never negative. */
  remaining(): Promise<number>;
}

/**
 * Early refusal before any LLM work starts. The LLM client enforces the same cap per call
 * (BudgetExceededError), this just avoids starting a request that cannot finish.
 */
export function requireLlmBudget(budget: LlmBudget): RequestHandler {
  return async (_req, _res, next) => {
    if ((await budget.remaining()) <= 0) throw llmBudgetExhausted();
    next();
  };
}
