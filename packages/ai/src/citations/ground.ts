import type { Claim } from "@finn/shared/contracts/research";
import type { LlmPort, StructuredCompletionRequest } from "@finn/shared/ports";
import { createClaimRegenerator, resolveClaims } from "../prompts/regenerate";
import type { SourcesBlock } from "../prompts/sources";
import { validateClaims, type RawClaim, type SourceChunk } from "./validator";

export interface GroundOptions {
  llm: LlmPort;
  task: string;
  sources: SourcesBlock;
  chunks: readonly SourceChunk[];
  facts?: readonly number[];
  ref?: StructuredCompletionRequest<unknown>["ref"];
}

/** Resolves source aliases, validates, regenerates failures once, and returns contract-shaped claims. */
export async function groundClaims(raw: RawClaim[], opts: GroundOptions): Promise<Claim[]> {
  return validateClaims(
    resolveClaims(raw, opts.sources),
    { chunks: opts.chunks, facts: opts.facts },
    createClaimRegenerator(opts.llm, { task: opts.task, sources: opts.sources, ref: opts.ref }),
  );
}
