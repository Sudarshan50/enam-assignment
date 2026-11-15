import { BusinessSnapshotPayloadSchema } from "@finn/shared/contracts/research";
import { groundClaims } from "../citations/ground";
import { extractNumbers, numberSupported } from "../citations/numbers";
import * as prompt from "../prompts/businessSnapshot";
import { buildSourcesBlock } from "../prompts/sources";
import { retrieveMulti, type RetrievedChunk } from "../retrieval/hybrid";
import { toStrictJsonSchema } from "../util/schema";
import { insufficient, type ResearchModuleRunner } from "./types";

const MIN_CHUNKS = 4;
const MAX_SEGMENTS = 6;

export const businessSnapshotModule: ResearchModuleRunner = {
  key: "business_snapshot",
  version: `2+${prompt.PROMPT_VERSION}`,
  inputs: { documents: true, history: false },
  async run(ctx) {
    if (ctx.documents.length === 0) return insufficient("No annual reports or transcripts could be processed for this company.");
    const deps = { sql: ctx.sql, embeddings: ctx.embeddings };
    const base = { symbol: ctx.symbol, queries: prompt.RETRIEVAL_QUERIES, perQuery: 6 };
    let chunks: RetrievedChunk[] = await retrieveMulti(deps, { ...base, k: 14, docKinds: ["annual_report"] });
    if (chunks.length < MIN_CHUNKS) chunks = await retrieveMulti(deps, { ...base, k: 14, docKinds: ["annual_report", "transcript"] });
    if (chunks.length < MIN_CHUNKS) return insufficient("Too few passages describe the business.");

    const sources = buildSourcesBlock(chunks);
    const ref = ctx.runId ? { kind: "research_run" as const, id: ctx.runId } : undefined;
    const res = await ctx.llm.complete({
      task: prompt.TASK,
      promptVersion: prompt.PROMPT_VERSION,
      system: prompt.SYSTEM,
      user: prompt.buildUser(ctx.companyName, ctx.symbol, sources.block),
      jsonSchema: toStrictJsonSchema(prompt.BusinessSnapshotResponseSchema),
      parse: (v) => prompt.BusinessSnapshotResponseSchema.parse(v),
      ref,
      maxTokens: 4_000,
    });
    if (!res.description && res.segments.length === 0) return insufficient("The sources do not describe the business.");

    const segments = res.segments.slice(0, MAX_SEGMENTS);
    const raw = [...(res.description ? [res.description] : []), ...segments.map((s) => s.claim)];
    const grounded = await groundClaims(raw, { llm: ctx.llm, task: prompt.TASK, sources, chunks, ref });
    const description = res.description ? grounded[0]! : null;
    const segClaims = grounded.slice(res.description ? 1 : 0);
    const textById = new Map(chunks.map((c) => [c.chunkId, c.text] as const));

    const payload = BusinessSnapshotPayloadSchema.parse({
      description,
      segments: segments.map((s, i) => {
        const claim = segClaims[i]!;
        // A revenue share is shown only if that percentage literally appears in the segment's cited sources.
        const cited = claim.citations.flatMap((c) => extractNumbers(textById.get(c.chunkId) ?? ""));
        const share =
          s.sharePct !== null && claim.grounded && numberSupported({ raw: `${s.sharePct}%`, value: s.sharePct, decimals: String(s.sharePct).split(".")[1]?.length ?? 0, dimension: "pct", rupees: null }, cited)
            ? s.sharePct
            : null;
        return { name: s.name, sharePct: share, claim };
      }),
    });
    return { status: "done", payload };
  },
};
