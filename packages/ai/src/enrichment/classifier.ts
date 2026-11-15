import type { AnnouncementClassifier, ClassificationInput, ClassificationResult, LlmPort } from "@finn/shared/ports";
import { IMPACT_RANGE } from "@finn/shared/taxonomy";
import * as prompt from "../prompts/classify";
import { toStrictJsonSchema } from "../util/schema";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : (lo + hi) / 2));

/** LLM fallback classifier, used after the rule classifier returns unclassified or low confidence. */
export function createLlmClassifier(llm: LlmPort): AnnouncementClassifier {
  const jsonSchema = toStrictJsonSchema(prompt.ClassificationResponseSchema);
  return {
    async classify(input: ClassificationInput): Promise<ClassificationResult> {
      const res = await llm.complete({
        task: prompt.TASK,
        promptVersion: prompt.PROMPT_VERSION,
        system: prompt.SYSTEM,
        user: prompt.buildUser(input),
        jsonSchema,
        parse: (v) => prompt.ClassificationResponseSchema.parse(v),
        maxTokens: 400,
      });
      return {
        category: res.category,
        impact: clamp(res.impact, IMPACT_RANGE.min, IMPACT_RANGE.max),
        confidence: clamp(res.confidence, 0, 1),
        oneLiner: res.oneLiner.trim().slice(0, 200),
        reasonCodes: res.reasonCodes.map((r) => r.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")).filter(Boolean).slice(0, 3),
      };
    },
  };
}
