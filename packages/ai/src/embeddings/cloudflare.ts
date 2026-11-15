import type { Sql } from "@finn/db";
import type { EmbedDocumentInput, EmbeddingPort, EmbeddingTask } from "@finn/shared/ports";
import { createSqlLedger, type LlmLedger } from "../llm/ledger";
import { backoffMs, sleep as realSleep } from "../util/concurrency";
import { documentPrompt, queryPrompt } from "./prefix";

export interface EmbeddingClientOptions {
  accountId: string;
  apiToken: string;
  model: string;
  dims: number;
  sql?: Sql;
  batchSize?: number;
  retries?: number;
  /** Characters per input; EmbeddingGemma accepts ~8k tokens, chunks are far smaller. */
  maxInputChars?: number;
  fetchImpl?: typeof fetch;
  ledger?: LlmLedger;
  sleep?: (ms: number) => Promise<void>;
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** Verified live: `{ input: string[], dimensions }` -> `result.data[i].embedding`, `result.usage.{prompt_tokens, neurons}`. */
interface WorkersAiEmbeddingResponse {
  success?: boolean;
  errors?: { message?: string; code?: number }[];
  result?: {
    data?: { index?: number; embedding?: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number; neurons?: number };
  };
}

export function createEmbeddingClient(opts: EmbeddingClientOptions): EmbeddingPort {
  const batchSize = opts.batchSize ?? 32;
  const retries = opts.retries ?? 3;
  const maxChars = opts.maxInputChars ?? 24_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const ledger = opts.ledger ?? (opts.sql ? createSqlLedger(opts.sql) : null);
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${opts.model}`;

  async function runBatch(inputs: string[], purpose: string): Promise<number[][]> {
    let lastError: Error = new EmbeddingError("No attempt made");
    for (let attempt = 0; attempt <= retries; attempt++) {
      const started = Date.now();
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: inputs.map((t) => t.slice(0, maxChars)), dimensions: opts.dims }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json().catch(() => ({}))) as WorkersAiEmbeddingResponse;
        if (!res.ok || body.success === false) {
          const msg = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
          const err = new EmbeddingError(`Embedding request failed: ${msg.slice(0, 300)}`, res.status);
          if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true });
          throw err;
        }
        const data = [...(body.result?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const vectors = data.map((d) => d.embedding ?? []);
        if (vectors.length !== inputs.length) throw new EmbeddingError(`Expected ${inputs.length} vectors, got ${vectors.length}`);
        const bad = vectors.find((v) => v.length !== opts.dims);
        if (bad) throw Object.assign(new EmbeddingError(`Expected ${opts.dims}-dim vectors, got ${bad.length}`), { fatal: true });
        await ledger?.record({
          provider: "cloudflare",
          model: opts.model,
          task: purpose,
          promptTokens: body.result?.usage?.prompt_tokens ?? null,
          neurons: body.result?.usage?.neurons ?? null,
          cacheHit: false,
          latencyMs: Date.now() - started,
          status: "ok",
          attempt: attempt + 1,
        });
        return vectors;
      } catch (err) {
        lastError = err instanceof Error ? err : new EmbeddingError(String(err));
        await ledger?.record({
          provider: "cloudflare",
          model: opts.model,
          task: purpose,
          cacheHit: false,
          latencyMs: Date.now() - started,
          status: "error",
          error: lastError.message,
          attempt: attempt + 1,
        });
        if ((err as { fatal?: boolean }).fatal) throw lastError;
        if (attempt < retries) await sleep(backoffMs(attempt, 1_000, 15_000));
      }
    }
    throw lastError;
  }

  return {
    model: opts.model,
    dims: opts.dims,
    async embedDocuments(inputs: EmbedDocumentInput[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < inputs.length; i += batchSize) {
        const batch = inputs.slice(i, i + batchSize).map((d) => documentPrompt(d.title, d.text));
        out.push(...(await runBatch(batch, "embed")));
      }
      return out;
    },
    async embedQuery(text: string, task: Exclude<EmbeddingTask, "document"> = "search_query"): Promise<number[]> {
      const [vector] = await runBatch([queryPrompt(text, task)], "embed");
      return vector!;
    },
  };
}
