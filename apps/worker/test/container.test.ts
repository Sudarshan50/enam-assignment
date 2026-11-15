import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pino: [] as { level: string; args: unknown[] }[],
  pinoOptions: [] as unknown[],
  getDb: vi.fn((_opts: { url?: string }) => ({ fake: "sql" })),
  createLlmClient: vi.fn((_opts: Record<string, unknown>) => ({ complete: vi.fn(async () => "real llm") })),
  createEmbeddingClient: vi.fn((opts: { model: string; dims: number }) => ({ model: opts.model, dims: opts.dims, embedDocuments: vi.fn(), embedQuery: vi.fn() })),
}));

vi.mock("pino", () => ({
  default: (options: unknown) => {
    h.pinoOptions.push(options);
    const at = (level: string) => (...args: unknown[]) => h.pino.push({ level, args });
    return { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") };
  },
}));
vi.mock("@finn/db", () => ({ getDb: h.getDb }));
vi.mock("@finn/ai/llm/client", () => ({ createLlmClient: h.createLlmClient }));
vi.mock("@finn/ai/embeddings/cloudflare", () => ({ createEmbeddingClient: h.createEmbeddingClient }));

const { createLogger, createWorkerContext, NotConfiguredError } = await import("../src/container");

beforeEach(() => {
  h.pino.length = 0;
  h.pinoOptions.length = 0;
  vi.clearAllMocks();
});

describe("createLogger", () => {
  it("defaults to info, honours LOG_LEVEL and passes string vs object calls through", () => {
    const log = createLogger({});
    createLogger({ LOG_LEVEL: "silent" });
    expect(h.pinoOptions).toEqual([
      { level: "info", base: { app: "finn-worker" } },
      { level: "silent", base: { app: "finn-worker" } },
    ]);
    log.info("plain");
    log.warn({ a: 1 }, "with object");
    log.error({ b: 2 });
    log.debug("dbg", "ignored message");
    expect(h.pino).toEqual([
      { level: "info", args: ["plain"] },
      { level: "warn", args: [{ a: 1 }, "with object"] },
      { level: "error", args: [{ b: 2 }, undefined] },
      { level: "debug", args: ["dbg"] },
    ]);
  });
});

describe("createWorkerContext", () => {
  it("without credentials: LLM and embeddings fail fast with NotConfiguredError, and a warning is logged", async () => {
    const env = { DATABASE_URL: "postgres://ztd@localhost:1/none", LLM_API_KEY: "   " };
    const ctx = createWorkerContext(env);
    expect(h.getDb).toHaveBeenCalledWith({ url: env.DATABASE_URL });
    expect(ctx.sql).toEqual({ fake: "sql" });
    expect(ctx.env).toBe(env);
    expect(h.createLlmClient).not.toHaveBeenCalled();
    expect(h.createEmbeddingClient).not.toHaveBeenCalled();

    const llmErr = await ctx.llm.complete({ messages: [] } as never).catch((e: unknown) => e);
    expect(llmErr).toBeInstanceOf(NotConfiguredError);
    expect((llmErr as Error).name).toBe("NotConfiguredError");
    expect((llmErr as Error).message).toBe("LLM is not configured (missing LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)");

    expect(ctx.embeddings).toMatchObject({ model: "@cf/google/embeddinggemma-2", dims: 768 });
    await expect(ctx.embeddings.embedQuery("x")).rejects.toThrow("Embeddings is not configured (missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN)");
    await expect(ctx.embeddings.embedDocuments([{ title: "t", text: "x" }])).rejects.toBeInstanceOf(NotConfiguredError);

    expect(h.pino).toContainEqual({ level: "warn", args: [{ missing: ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] }, "LLM not configured; rule-based classification only"] });
    expect(typeof ctx.classifier.classify).toBe("function");
    expect(typeof ctx.enricher.enrich).toBe("function");
  });

  it("with credentials: builds the real clients with parsed numbers and no warning", () => {
    const env = {
      LLM_BASE_URL: "https://llm.ztd.test/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
      LLM_DAILY_CALL_BUDGET: "25",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
      EMBEDDING_MODEL: "@cf/ztd/model",
      EMBEDDING_DIMS: "384",
    };
    const ctx = createWorkerContext(env);
    expect(h.createLlmClient).toHaveBeenCalledWith({ baseURL: "https://llm.ztd.test/v1", apiKey: "k", model: "m", sql: ctx.sql, dailyCallBudget: 25 });
    expect(h.createEmbeddingClient).toHaveBeenCalledWith({ accountId: "acct", apiToken: "tok", model: "@cf/ztd/model", dims: 384, sql: ctx.sql });
    expect(ctx.embeddings).toMatchObject({ model: "@cf/ztd/model", dims: 384 });
    expect(h.pino.filter((p) => p.level === "warn")).toEqual([]);
    expect(createWorkerContext({ ...env, LLM_DAILY_CALL_BUDGET: undefined }) && h.createLlmClient.mock.lastCall?.[0]).toMatchObject({ dailyCallBudget: 2000 });
  });

  it("the HTTP client only allows the configured hosts", () => {
    const { http } = createWorkerContext({});
    expect(http.isAllowed("https://www.nseindia.com/api/x")).toBe(true);
    expect(http.isAllowed("https://ztd.example.invalid/")).toBe(false);
  });
});
