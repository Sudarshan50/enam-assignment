import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryLlmCache } from "../src/llm/cache";
import { CircuitBreaker } from "../src/llm/circuitBreaker";
import { createLlmClientFromDeps, istMidnight } from "../src/llm/client";
import { BudgetExceededError, LlmTransportError, LlmUnavailableError, LlmValidationError } from "../src/llm/errors";
import { createMemoryLedger } from "../src/llm/ledger";
import type { ChatRequest, ChatResponse, ChatTransport } from "../src/llm/transport";
import { toStrictJsonSchema } from "../src/util/schema";

const Schema = z.object({ sentiment: z.enum(["positive", "negative"]) });

function request(overrides: Partial<{ user: string; noCache: boolean }> = {}) {
  return {
    task: "sentiment",
    promptVersion: "sentiment.v1",
    system: "Classify.",
    user: overrides.user ?? "Revenue grew 18%.",
    jsonSchema: toStrictJsonSchema(Schema),
    parse: (v: unknown) => Schema.parse(v),
    noCache: overrides.noCache,
    ref: { kind: "research_run" as const, id: "run-1" },
  };
}

function scripted(responses: (string | Error)[]): ChatTransport & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async chat(req): Promise<ChatResponse> {
      requests.push(structuredClone(req));
      const next = responses.shift();
      if (next === undefined) throw new Error("no scripted response left");
      if (next instanceof Error) throw next;
      return { content: next, promptTokens: 100, completionTokens: 10 };
    },
  };
}

function client(transport: ChatTransport, opts: { budget?: number; breaker?: CircuitBreaker; structuredOutput?: "json_schema" | "json_object" } = {}) {
  const cache = createMemoryLlmCache();
  const ledger = createMemoryLedger();
  const llm = createLlmClientFromDeps({
    transport,
    model: "glm-test",
    cache,
    ledger,
    dailyCallBudget: opts.budget ?? 100,
    breaker: opts.breaker,
    structuredOutput: opts.structuredOutput,
    sleep: async () => {},
  });
  return { llm, cache, ledger };
}

describe("LLM client", () => {
  it("defaults to json_object with the schema in the system prompt, validates, records the ledger and caches", async () => {
    const t = scripted(['{"sentiment":"positive"}']);
    const { llm, cache, ledger } = client(t);
    await expect(llm.complete(request())).resolves.toEqual({ sentiment: "positive" });
    expect(t.requests[0]!.responseFormat).toEqual({ type: "json_object" });
    expect(t.requests[0]!.messages[0]!.content).toMatch(/"enum":\["positive","negative"\]/);
    expect(cache.entries.size).toBe(1);
    expect(ledger.rows).toMatchObject([{ task: "sentiment", status: "ok", cacheHit: false, promptTokens: 100, completionTokens: 10, refKind: "research_run", refId: "run-1" }]);
  });

  it("serves a cache hit without calling the provider and records it", async () => {
    const t = scripted(['{"sentiment":"positive"}']);
    const { llm, ledger } = client(t);
    await llm.complete(request());
    await expect(llm.complete(request())).resolves.toEqual({ sentiment: "positive" });
    expect(t.requests).toHaveLength(1);
    expect(ledger.rows.at(-1)).toMatchObject({ status: "cache_hit", cacheHit: true });
  });

  it("bypasses the cache with noCache", async () => {
    const t = scripted(['{"sentiment":"positive"}', '{"sentiment":"negative"}']);
    const { llm, cache } = client(t);
    await llm.complete(request({ noCache: true }));
    await expect(llm.complete(request({ noCache: true }))).resolves.toEqual({ sentiment: "negative" });
    expect(cache.entries.size).toBe(0);
  });

  it("strips reasoning and code fences before parsing", async () => {
    const t = scripted(['<think>let me think</think>\n```json\n{"sentiment":"negative"}\n```']);
    const { llm } = client(t);
    await expect(llm.complete(request())).resolves.toEqual({ sentiment: "negative" });
  });

  it("re-asks once with the validation error after invalid JSON", async () => {
    const t = scripted(["not json at all", '{"sentiment":"positive"}']);
    const { llm, ledger } = client(t);
    await expect(llm.complete(request())).resolves.toEqual({ sentiment: "positive" });
    const second = t.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", content: "not json at all" });
    expect(second.at(-1)!.content).toMatch(/rejected by the validator: invalid JSON/);
    expect(ledger.rows.map((r) => r.status)).toEqual(["invalid", "ok"]);
  });

  it("re-asks with the zod error and gives up after the second invalid answer", async () => {
    const t = scripted(['{"sentiment":"meh"}', '{"sentiment":"still meh"}', '{"sentiment":"positive"}']);
    const { llm } = client(t);
    await expect(llm.complete(request())).rejects.toBeInstanceOf(LlmValidationError);
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.messages.at(-1)!.content).toMatch(/sentiment/);
  });

  it("retries transport errors with backoff up to 3 attempts", async () => {
    const t = scripted([new LlmTransportError("HTTP 503", 503), new LlmTransportError("timeout"), '{"sentiment":"positive"}']);
    const { llm, ledger } = client(t);
    await expect(llm.complete(request())).resolves.toEqual({ sentiment: "positive" });
    expect(ledger.rows.map((r) => r.status)).toEqual(["error", "error", "ok"]);
  });

  it("does not retry non-retryable 4xx errors", async () => {
    const t = scripted([new LlmTransportError("HTTP 401", 401), '{"sentiment":"positive"}']);
    const { llm } = client(t);
    await expect(llm.complete(request())).rejects.toThrow(/401/);
    expect(t.requests).toHaveLength(1);
  });

  it("opens the circuit after 5 consecutive failures and fails fast", async () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 60_000, now: () => now });
    const t = scripted(Array.from({ length: 6 }, () => new LlmTransportError("HTTP 500", 500)));
    const { llm } = client(t, { breaker });
    await expect(llm.complete(request({ user: "a" }))).rejects.toThrow(/500/);
    await expect(llm.complete(request({ user: "b" }))).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(t.requests).toHaveLength(5);
    expect(breaker.state).toBe("open");

    now += 60_001;
    expect(breaker.state).toBe("half_open");
    t.chat = async (req) => {
      t.requests.push(req);
      return { content: '{"sentiment":"positive"}', promptTokens: 1, completionTokens: 1 };
    };
    await expect(llm.complete(request({ user: "c" }))).resolves.toEqual({ sentiment: "positive" });
    expect(breaker.state).toBe("closed");
  });

  it("enforces the daily call budget", async () => {
    const t = scripted(['{"sentiment":"positive"}', '{"sentiment":"positive"}']);
    const { llm } = client(t, { budget: 1 });
    await llm.complete(request({ user: "one" }));
    await expect(llm.complete(request({ user: "two" }))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.requests).toHaveLength(1);
  });

  it("cache hits do not count against the budget", async () => {
    const t = scripted(['{"sentiment":"positive"}']);
    const { llm } = client(t, { budget: 1 });
    await llm.complete(request());
    await expect(llm.complete(request())).resolves.toEqual({ sentiment: "positive" });
  });

  it("can send strict json_schema when configured", async () => {
    const t = scripted(['{"sentiment":"positive"}']);
    const { llm } = client(t, { structuredOutput: "json_schema" });
    await llm.complete(request());
    expect(t.requests[0]!.responseFormat).toMatchObject({ type: "json_schema", json_schema: { name: "sentiment", strict: true } });
    expect(t.requests[0]!.messages[0]!.content).toBe("Classify.");
  });

  it("falls back to json_object with the schema in the prompt when json_schema is rejected", async () => {
    const { UnsupportedResponseFormatError } = await import("../src/llm/transport");
    const t = scripted([new UnsupportedResponseFormatError("response_format json_schema not supported"), '{"sentiment":"positive"}']);
    const { llm } = client(t, { structuredOutput: "json_schema" });
    await expect(llm.complete(request())).resolves.toEqual({ sentiment: "positive" });
    expect(t.requests[1]!.responseFormat).toEqual({ type: "json_object" });
    expect(t.requests[1]!.messages[0]!.content).toMatch(/validates against this JSON schema/);
  });

  it("computes IST midnight", () => {
    expect(istMidnight(new Date("2026-11-15T20:00:00Z")).toISOString()).toBe("2026-11-15T18:30:00.000Z");
    expect(istMidnight(new Date("2026-11-15T10:00:00Z")).toISOString()).toBe("2026-11-14T18:30:00.000Z");
  });
});
