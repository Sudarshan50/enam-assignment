/**
 * Live smoke test of the real adapters against the local DB.
 * Run: node --env-file=.env --import tsx packages/ai/scripts/live-check.ts
 * Prints shapes, timings and usage only, never credentials.
 */
import { closeDb, getDb } from "@finn/db";
import { z } from "zod";
import { createEmbeddingClient } from "../src/embeddings/cloudflare";
import { createLlmClient } from "../src/llm/client";
import { toStrictJsonSchema } from "../src/util/schema";

const env = process.env;
const sql = getDb();

const llm = createLlmClient({ baseURL: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL!, sql, dailyCallBudget: Number(env.LLM_DAILY_CALL_BUDGET ?? 2000) });
const Schema = z.object({ metric: z.enum(["revenue_growth", "ebitda_margin", "capex"]), low: z.number().nullable(), high: z.number().nullable(), horizon: z.string() });

let started = Date.now();
const result = await llm.complete({
  task: "live_check",
  promptVersion: "live_check.v1",
  system: "Extract the forward-looking guidance from the sentence.",
  user: "We expect EBITDA margins of 21 to 22 percent for FY27.",
  jsonSchema: toStrictJsonSchema(Schema),
  parse: (v) => Schema.parse(v),
  noCache: true,
});
console.log("llm.result", JSON.stringify(result), "ms", Date.now() - started);

const embeddings = createEmbeddingClient({ accountId: env.CLOUDFLARE_ACCOUNT_ID!, apiToken: env.CLOUDFLARE_API_TOKEN!, model: env.EMBEDDING_MODEL!, dims: Number(env.EMBEDDING_DIMS ?? 768), sql });
started = Date.now();
const docs = await embeddings.embedDocuments(
  Array.from({ length: 40 }, (_, i) => ({ title: "CDSL Annual Report FY26", text: `Passage ${i}: CDSL added ${i} lakh demat accounts in the quarter.` })),
);
const query = await embeddings.embedQuery("how many demat accounts were added?", "question_answering");
const dims = new Set(docs.map((v) => v.length));
console.log("emb.vectors", docs.length, "dims", [...dims], "query_dims", query.length, "ms", Date.now() - started);
if (dims.size !== 1 || !dims.has(768) || query.length !== 768) throw new Error("unexpected embedding dims");
const norm = Math.sqrt(docs[0]!.reduce((s, x) => s + x * x, 0));
console.log("emb.norm_first", norm.toFixed(4));

const rows = await sql`
  SELECT provider, purpose, status, cache_hit, prompt_tokens, completion_tokens, neurons, latency_ms
  FROM llm_calls WHERE created_at > now() - interval '5 minutes' ORDER BY id`;
console.log("ledger", JSON.stringify(rows));
await closeDb();
