import type { Sql } from "@finn/db";
import { documentsRepo } from "@finn/db/repositories/documents";
import { AskResponseSchema } from "@finn/shared/contracts/research";
import type { EmbeddingPort, LlmPort } from "@finn/shared/ports";
import type { z } from "zod";
import { groundClaims } from "../citations/ground";
import * as prompt from "../prompts/ask";
import { buildSourcesBlock } from "../prompts/sources";
import { isWeakRetrieval, retrieve } from "../retrieval/hybrid";
import { hashParts } from "../util/hash";
import { toStrictJsonSchema } from "../util/schema";

export type AskResponse = z.infer<typeof AskResponseSchema>;

export interface AnswerDeps {
  sql: Sql;
  llm: LlmPort;
  embeddings: EmbeddingPort;
}

const NONE: AskResponse = { answer: [], insufficientSources: true };

/** Answers a typed question only from cited chunks of the company's own filings. */
export async function answerQuestion(deps: AnswerDeps, req: { symbol: string; question: string }): Promise<AskResponse> {
  const symbol = req.symbol.trim().toUpperCase();
  const question = req.question.trim();
  const chunks = await retrieve(deps, { symbol, query: question, k: 8, task: "question_answering" });
  if (isWeakRetrieval(chunks)) return NONE;

  const companyName = (await documentsRepo(deps.sql).companyName(symbol)) ?? symbol;
  const sources = buildSourcesBlock(chunks);
  const ref = { kind: "ask" as const, id: hashParts(symbol, question).slice(0, 16) };
  const res = await deps.llm.complete({
    task: prompt.TASK,
    promptVersion: prompt.PROMPT_VERSION,
    system: prompt.SYSTEM,
    user: prompt.buildUser(companyName, symbol, question, sources.block),
    jsonSchema: toStrictJsonSchema(prompt.AskLlmResponseSchema),
    parse: (v) => prompt.AskLlmResponseSchema.parse(v),
    ref,
    maxTokens: 2_000,
  });
  if (!res.answerable || res.claims.length === 0) return NONE;

  const answer = await groundClaims(res.claims.slice(0, 4), { llm: deps.llm, task: prompt.TASK, sources, chunks, ref });
  return AskResponseSchema.parse({ answer, insufficientSources: false });
}
