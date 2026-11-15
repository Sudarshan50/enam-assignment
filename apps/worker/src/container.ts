import pino from "pino";
import { createCardEnricher } from "@finn/ai/enrichment/cardEnricher";
import { createLlmClassifier } from "@finn/ai/enrichment/classifier";
import { createEmbeddingClient } from "@finn/ai/embeddings/cloudflare";
import { createLlmClient } from "@finn/ai/llm/client";
import { getDb } from "@finn/db";
import type { EmbeddingPort, LlmPort } from "@finn/shared/ports";
import { createHttpClient } from "@finn/sources/http/client";
import type { Logger, WorkerContext } from "./context";
import { isNseHost, throttleHttp } from "./http/throttled";

const NSE_MIN_INTERVAL_MS = 1_000;

export class NotConfiguredError extends Error {
  constructor(what: string, missing: string[]) {
    super(`${what} is not configured (missing ${missing.join(", ")})`);
    this.name = "NotConfiguredError";
  }
}

function missing(env: NodeJS.ProcessEnv, keys: string[]): string[] {
  return keys.filter((k) => !env[k]?.trim());
}

/** Stand-in when credentials are absent: every call fails fast, so pipelines take their no-LLM paths. */
function unconfiguredLlm(missingKeys: string[]): LlmPort {
  return {
    complete() {
      return Promise.reject(new NotConfiguredError("LLM", missingKeys));
    },
  };
}

function unconfiguredEmbeddings(model: string, dims: number, missingKeys: string[]): EmbeddingPort {
  const fail = () => Promise.reject(new NotConfiguredError("Embeddings", missingKeys));
  return { model, dims, embedDocuments: fail, embedQuery: fail };
}

export function createLogger(env: NodeJS.ProcessEnv): Logger {
  const base = pino({ level: env.LOG_LEVEL ?? "info", base: { app: "finn-worker" } });
  const wrap =
    (level: "info" | "warn" | "error" | "debug") =>
    (obj: object | string, msg?: string): void => {
      if (typeof obj === "string") base[level](obj);
      else base[level](obj, msg);
    };
  return { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") };
}

/** Composition root: the only place concrete adapters are chosen. */
export function createWorkerContext(env: NodeJS.ProcessEnv = process.env): WorkerContext {
  const log = createLogger(env);
  const sql = getDb({ url: env.DATABASE_URL });
  const http = throttleHttp(createHttpClient(), { minIntervalMs: NSE_MIN_INTERVAL_MS, shouldThrottle: isNseHost });

  const llmMissing = missing(env, ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]);
  const llm =
    llmMissing.length === 0
      ? createLlmClient({
          baseURL: env.LLM_BASE_URL!,
          apiKey: env.LLM_API_KEY!,
          model: env.LLM_MODEL!,
          sql,
          dailyCallBudget: Number(env.LLM_DAILY_CALL_BUDGET ?? 2000),
        })
      : unconfiguredLlm(llmMissing);
  if (llmMissing.length) log.warn({ missing: llmMissing }, "LLM not configured; rule-based classification only");

  const embeddingModel = env.EMBEDDING_MODEL ?? "@cf/google/embeddinggemma-2";
  const embeddingDims = Number(env.EMBEDDING_DIMS ?? 768);
  const cfMissing = missing(env, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  const embeddings =
    cfMissing.length === 0
      ? createEmbeddingClient({
          accountId: env.CLOUDFLARE_ACCOUNT_ID!,
          apiToken: env.CLOUDFLARE_API_TOKEN!,
          model: embeddingModel,
          dims: embeddingDims,
          sql,
        })
      : unconfiguredEmbeddings(embeddingModel, embeddingDims, cfMissing);

  return {
    sql,
    http,
    llm,
    embeddings,
    classifier: createLlmClassifier(llm),
    enricher: createCardEnricher({ llm }),
    log,
    env,
  };
}
