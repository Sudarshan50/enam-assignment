import type { Sql } from "@finn/db";
import type { Config } from "../config";
import { HttpError, llmBudgetExhausted, llmUnavailable } from "../http/errors";
import type { Logger } from "../lib/logger";
import type { RuleParser } from "../services/alertRuleService";
import type { AskEngine } from "../services/askService";
import type { WeightLearner } from "../services/interactionService";

/**
 * Adapters from @finn/domain and @finn/ai to the API's own service interfaces. Modules are imported
 * lazily so the API still boots (with that feature degraded) if one is missing or fails to load.
 */

function describe(err: unknown): { code?: string; message: string } {
  const e = err as { code?: string; message?: string };
  return { code: e?.code, message: e?.message ?? String(err) };
}

function reportMissing(log: Logger, module: string, err: unknown, effect: string) {
  const info = describe(err);
  const level = info.code === "ERR_MODULE_NOT_FOUND" ? "warn" : "error";
  log[level]({ module, ...info }, `${module} unavailable; ${effect}`);
}

export async function loadRuleParser(log: Logger): Promise<RuleParser> {
  try {
    const mod = await import("@finn/domain/alerts/parseRuleText");
    return { parse: (text, ctx) => mod.parseRuleText(text, ctx), explain: (definition) => mod.explain(definition) };
  } catch (err) {
    reportMissing(log, "@finn/domain/alerts/parseRuleText", err, "alert rule previews cannot parse text");
    return { parse: () => null, explain: () => "" };
  }
}

export async function loadWeightLearner(log: Logger): Promise<WeightLearner> {
  try {
    const mod = await import("@finn/domain/weights/learn");
    return { adjust: (current, action) => mod.adjustWeight(current, action) };
  } catch (err) {
    reportMissing(log, "@finn/domain/weights/learn", err, "interactions are recorded but weights stay unchanged");
    return { adjust: (current) => current };
  }
}

const askNotReady = (reason: string): AskEngine => ({
  async answer() {
    throw new HttpError(503, "ask_unavailable", `Ask is not available on this server yet (${reason}).`);
  },
});

export async function loadAskEngine(config: Config, sql: Sql, log: Logger): Promise<AskEngine> {
  const { LLM_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = config;
  if (!LLM_API_KEY || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    log.warn("LLM or Cloudflare credentials missing; Ask disabled");
    return askNotReady("AI credentials are not configured");
  }
  try {
    const [llmMod, embeddingMod, askMod] = await Promise.all([
      import("@finn/ai/llm/client"),
      import("@finn/ai/embeddings/cloudflare"),
      import("@finn/ai/ask/answer"),
    ]);
    const llm = llmMod.createLlmClient({
      baseURL: config.LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: config.LLM_MODEL,
      sql,
      dailyCallBudget: config.LLM_DAILY_CALL_BUDGET,
    });
    const embeddings = embeddingMod.createEmbeddingClient({
      accountId: CLOUDFLARE_ACCOUNT_ID,
      apiToken: CLOUDFLARE_API_TOKEN,
      model: config.EMBEDDING_MODEL,
      dims: config.EMBEDDING_DIMS,
      sql,
    });
    return {
      async answer(req) {
        try {
          return await askMod.answerQuestion({ sql, llm, embeddings }, req);
        } catch (err) {
          if (err instanceof llmMod.BudgetExceededError) throw llmBudgetExhausted();
          if (err instanceof llmMod.LlmUnavailableError) throw llmUnavailable();
          throw err;
        }
      },
    };
  } catch (err) {
    reportMissing(log, "@finn/ai (llm/client, embeddings/cloudflare, ask/answer)", err, "Ask disabled");
    return askNotReady("the AI package is not installed");
  }
}
