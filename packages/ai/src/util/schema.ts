import { z } from "zod";

const UNSUPPORTED_STRICT_KEYWORDS = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "format",
  "default",
]);

function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (!UNSUPPORTED_STRICT_KEYWORDS.has(k)) out[k] = prune(v);
    return out;
  }
  return node;
}

/**
 * JSON schema for `response_format` derived from the zod schema, so the two never drift. Keywords that strict
 * structured-output modes reject are dropped; zod still enforces them when the response is parsed.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return prune(z.toJSONSchema(schema, { target: "draft-7" })) as Record<string, unknown>;
}

/** Compact zod error text that is useful to send back to the model. */
export function formatZodError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}
