import type { LlmPort, StructuredCompletionRequest } from "@finn/shared/ports";
import { z } from "zod";
import { RawClaimSchema, type ClaimRegenerator, type RawClaim } from "../citations/validator";
import { toStrictJsonSchema } from "../util/schema";
import { CLAIM_RULES, UNTRUSTED_DATA_RULES, type SourcesBlock } from "./sources";

export const PROMPT_VERSION = "regenerate_claims.v1";

const ResponseSchema = z.object({ claims: z.array(RawClaimSchema) });

const SYSTEM = [
  "You repair investor-research claims that failed a citation check.",
  UNTRUSTED_DATA_RULES,
  CLAIM_RULES,
  "For each failed claim, return a corrected version in the same order: fix the quotes so they are verbatim, cite the right source, and remove or correct any number the sources do not contain. If a claim cannot be supported at all, return it with an empty citations array.",
].join("\n\n");

/** Builds the one-shot regeneration callback used by the citation validator. */
export function createClaimRegenerator(
  llm: LlmPort,
  opts: { task: string; sources: SourcesBlock; ref?: StructuredCompletionRequest<unknown>["ref"] },
): ClaimRegenerator {
  return async (failures) => {
    const listing = failures
      .map((f, i) => `${i + 1}. Claim: ${JSON.stringify(f.claim.text)}\n   Citations: ${JSON.stringify(f.claim.citations)}\n   Problems: ${f.problems.join("; ")}`)
      .join("\n");
    const res = await llm.complete({
      task: `${opts.task}.regenerate`,
      promptVersion: PROMPT_VERSION,
      system: SYSTEM,
      user: `${opts.sources.block}\n\nFailed claims (${failures.length}):\n${listing}\n\nReturn exactly ${failures.length} claims in "claims".`,
      jsonSchema: toStrictJsonSchema(ResponseSchema),
      parse: (v) => ResponseSchema.parse(v),
      ref: opts.ref,
    });
    return res.claims.map((c): RawClaim => ({ text: c.text, citations: c.citations.map((cit) => ({ chunkId: opts.sources.resolve(cit.chunkId), quote: cit.quote })) }));
  };
}

/** Maps source aliases in model output back to chunk ids. */
export function resolveClaims(claims: RawClaim[], sources: SourcesBlock): RawClaim[] {
  return claims.map((c) => ({ text: c.text, citations: c.citations.map((cit) => ({ chunkId: sources.resolve(cit.chunkId), quote: cit.quote })) }));
}
