import type { EmbeddingTask } from "@finn/shared/ports";

const QUERY_TASK_LABEL: Record<Exclude<EmbeddingTask, "document">, string> = {
  search_query: "search result",
  question_answering: "question answering",
  clustering: "clustering",
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** EmbeddingGemma document prompt: `title: {title} | text: {text}` ("none" when there is no title). */
export function documentPrompt(title: string, text: string): string {
  return `title: ${oneLine(title) || "none"} | text: ${text.trim()}`;
}

/** EmbeddingGemma query prompt, e.g. `task: search result | query: {q}`. */
export function queryPrompt(text: string, task: Exclude<EmbeddingTask, "document"> = "search_query"): string {
  return `task: ${QUERY_TASK_LABEL[task]} | query: ${oneLine(text)}`;
}
