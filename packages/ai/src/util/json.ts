/** Removes reasoning blocks some models emit before the answer. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

/**
 * Parses the JSON payload of a model response: strips reasoning and code fences, then falls back to the
 * outermost {...} or [...] span when the model wrapped the JSON in prose.
 */
export function parseModelJson(raw: string): unknown {
  const text = stripReasoning(raw)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch (first) {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw first;
  }
}
