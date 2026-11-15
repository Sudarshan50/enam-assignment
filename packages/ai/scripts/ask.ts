/**
 * Ask a grounded question against already-ingested documents.
 * Run: node --env-file=.env --import tsx packages/ai/scripts/ask.ts CDSL "What drives transaction revenue?"
 */
import { closeDb, getDb } from "@finn/db";
import { answerQuestion } from "../src/ask/answer";
import { createEmbeddingClient } from "../src/embeddings/cloudflare";
import { createLlmClient } from "../src/llm/client";

const [symbol, question] = process.argv.slice(2);
if (!symbol || !question) {
  console.error('usage: ask.ts SYMBOL "question"');
  process.exit(2);
}

const env = process.env;
const sql = getDb();
const llm = createLlmClient({ baseURL: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL!, sql, dailyCallBudget: Number(env.LLM_DAILY_CALL_BUDGET ?? 2000) });
const embeddings = createEmbeddingClient({ accountId: env.CLOUDFLARE_ACCOUNT_ID!, apiToken: env.CLOUDFLARE_API_TOKEN!, model: env.EMBEDDING_MODEL!, dims: Number(env.EMBEDDING_DIMS ?? 768), sql });

const started = Date.now();
try {
  const res = await answerQuestion({ sql, llm, embeddings }, { symbol: symbol.toUpperCase(), question });
  console.log(JSON.stringify(res, null, 2));
  console.log("ms", Date.now() - started);
} finally {
  await closeDb();
}
