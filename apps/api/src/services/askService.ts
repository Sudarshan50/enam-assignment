import type { z } from "zod";
import type { AskResponseSchema } from "@finn/shared";
import { HttpError, llmBudgetExhausted, llmUnavailable, notFound } from "../http/errors";

export type AskResponse = z.infer<typeof AskResponseSchema>;

/** Answers a question from a company's indexed chunks (implemented by @finn/ai/ask/answer). */
export interface AskEngine {
  answer(req: { symbol: string; question: string }): Promise<AskResponse>;
}

export interface AskService {
  ask(req: { symbol: string; question: string }): Promise<AskResponse>;
}

/** Maps the LLM client's errors by name so this module does not depend on @finn/ai. */
export function mapAskError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === "BudgetExceededError") return llmBudgetExhausted();
  if (name === "LlmUnavailableError") return llmUnavailable();
  return err;
}

export function createAskService(deps: { engine: AskEngine; companyExists: (symbol: string) => Promise<boolean> }): AskService {
  return {
    async ask(req) {
      if (!(await deps.companyExists(req.symbol))) throw notFound(`Company ${req.symbol}`);
      try {
        return await deps.engine.answer(req);
      } catch (err) {
        throw mapAskError(err);
      }
    },
  };
}
