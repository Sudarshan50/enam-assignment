import { BullBearPayloadSchema } from "@finn/shared/contracts/research";
import { groundClaims } from "../citations/ground";
import * as prompt from "../prompts/bullBear";
import { buildSourcesBlock } from "../prompts/sources";
import { retrieveMulti } from "../retrieval/hybrid";
import { toStrictJsonSchema } from "../util/schema";
import { insufficient, type ResearchModuleRunner } from "./types";

const MIN_CHUNKS = 6;
const MAX_POINTS = 4;

export const bullBearModule: ResearchModuleRunner = {
  key: "bull_bear",
  version: `2+${prompt.PROMPT_VERSION}`,
  inputs: { documents: true, history: false },
  async run(ctx) {
    if (ctx.documents.length === 0) return insufficient("No annual reports or transcripts could be processed for this company.");
    const chunks = await retrieveMulti(
      { sql: ctx.sql, embeddings: ctx.embeddings },
      { symbol: ctx.symbol, queries: prompt.RETRIEVAL_QUERIES, perQuery: 6, k: 20, docKinds: ["annual_report", "transcript"] },
    );
    if (chunks.length < MIN_CHUNKS) return insufficient(`Only ${chunks.length} relevant passages found; too few for a balanced bull/bear case.`);

    const sources = buildSourcesBlock(chunks);
    const ref = ctx.runId ? { kind: "research_run" as const, id: ctx.runId } : undefined;
    const res = await ctx.llm.complete({
      task: prompt.TASK,
      promptVersion: prompt.PROMPT_VERSION,
      system: prompt.SYSTEM,
      user: prompt.buildUser(ctx.companyName, ctx.symbol, sources.block),
      jsonSchema: toStrictJsonSchema(prompt.BullBearResponseSchema),
      parse: (v) => prompt.BullBearResponseSchema.parse(v),
      ref,
      maxTokens: 4_000,
    });
    if (res.bull.length + res.bear.length === 0) return insufficient("The sources did not support any bull or bear points.");

    const bull = res.bull.slice(0, MAX_POINTS);
    const bear = res.bear.slice(0, MAX_POINTS);
    const grounded = await groundClaims([...bull, ...bear], { llm: ctx.llm, task: prompt.TASK, sources, chunks, ref });
    const payload = BullBearPayloadSchema.parse({ bull: grounded.slice(0, bull.length), bear: grounded.slice(bull.length) });
    return { status: "done", payload };
  },
};
