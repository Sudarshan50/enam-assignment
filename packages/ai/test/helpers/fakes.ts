import type { EmbedDocumentInput, EmbeddingPort, EmbeddingTask, LlmPort, StructuredCompletionRequest } from "@finn/shared/ports";

export const DIMS = 768;

/** Unit vector along `axis`, with an optional small component on `nearAxis` (so cosine distance is tunable). */
export function oneHot(axis: number, nearAxis?: number, weight = 0.2): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis % DIMS] = 1;
  if (nearAxis !== undefined) v[nearAxis % DIMS] = weight;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

export type LlmResponder = (req: StructuredCompletionRequest<unknown>) => unknown;

/** LLM double: routes by task, validates through the request's own zod parser like the real client. */
export function fakeLlm(respond: LlmResponder | Record<string, LlmResponder>): LlmPort & { calls: StructuredCompletionRequest<unknown>[] } {
  const calls: StructuredCompletionRequest<unknown>[] = [];
  return {
    calls,
    async complete<T>(req: StructuredCompletionRequest<T>): Promise<T> {
      const r = req as StructuredCompletionRequest<unknown>;
      calls.push(r);
      const fn = typeof respond === "function" ? respond : (respond[req.task] ?? respond["*"]);
      if (!fn) throw new Error(`fakeLlm: no response for task ${req.task}`);
      return req.parse(fn(r));
    },
  };
}

/**
 * Embedding double. Documents map to the axis of the first keyword they contain; queries likewise, so a
 * query for "dealers" lands nearest the chunk about dealers.
 */
export function fakeEmbeddings(keywords: Record<string, number>, opts: { model?: string } = {}): EmbeddingPort & {
  documentCalls: EmbedDocumentInput[][];
  queryCalls: { text: string; task: Exclude<EmbeddingTask, "document"> | undefined }[];
} {
  const documentCalls: EmbedDocumentInput[][] = [];
  const queryCalls: { text: string; task: Exclude<EmbeddingTask, "document"> | undefined }[] = [];
  const axisFor = (text: string) => {
    const lower = text.toLowerCase();
    for (const [k, axis] of Object.entries(keywords)) if (lower.includes(k)) return axis;
    return DIMS - 1;
  };
  return {
    model: opts.model ?? "fake-embed",
    dims: DIMS,
    documentCalls,
    queryCalls,
    async embedDocuments(inputs) {
      documentCalls.push(inputs);
      return inputs.map((i) => oneHot(axisFor(i.text)));
    },
    async embedQuery(text, task) {
      queryCalls.push({ text, task });
      return oneHot(axisFor(text));
    },
  };
}

/** Sources the model sees in a prompt: alias (S1...) and the fenced text. */
export function parseSources(user: string): { alias: string; text: string }[] {
  return [...user.matchAll(/<source id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)].map((m) => ({ alias: m[1]!, text: m[2]! }));
}

/** Alias of the first source whose text contains `needle` (throws if absent, so a test fails loudly). */
export function aliasFor(user: string, needle: string): string {
  const hit = parseSources(user).find((s) => s.text.includes(needle));
  if (!hit) throw new Error(`no source contains ${JSON.stringify(needle)}`);
  return hit.alias;
}

/** Quote helper: the first `words` words of a text, copied verbatim. */
export function firstWords(text: string, words = 10): string {
  return text.split(/\s+/).slice(0, words).join(" ");
}
