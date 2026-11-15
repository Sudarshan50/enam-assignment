import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryLlmCache, llmCacheKey } from "../src/llm/cache";
import { CircuitBreaker } from "../src/llm/circuitBreaker";
import { createLlmClientFromDeps } from "../src/llm/client";
import { BudgetExceededError, LlmTransportError, LlmUnavailableError, LlmValidationError } from "../src/llm/errors";
import type { LlmCallRecord, LlmLedger } from "../src/llm/ledger";
import { createMemoryLedger } from "../src/llm/ledger";
import type { ChatRequest, ChatResponse, ChatTransport } from "../src/llm/transport";
import { toStrictJsonSchema } from "../src/util/schema";

const Schema = z.object({ verdict: z.enum(["buy", "hold"]), score: z.number().min(0).max(10) });
const OK = '{"verdict":"buy","score":7}';

function req(over: Partial<{ task: string; promptVersion: string; user: string; noCache: boolean; schema: z.ZodType }> = {}) {
  const schema = over.schema ?? Schema;
  return {
    task: over.task ?? "rate",
    promptVersion: over.promptVersion ?? "rate.v1",
    system: "Rate the filing.",
    user: over.user ?? "Revenue grew 12%.",
    jsonSchema: toStrictJsonSchema(schema),
    parse: (v: unknown) => schema.parse(v) as z.infer<typeof Schema>,
    noCache: over.noCache,
  };
}

function scripted(responses: (string | Error)[]): ChatTransport & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async chat(r): Promise<ChatResponse> {
      requests.push(structuredClone(r));
      const next = responses.shift();
      if (next === undefined) throw new Error("no scripted response left");
      if (next instanceof Error) throw next;
      return { content: next, promptTokens: 50, completionTokens: 5 };
    },
  };
}

/** Ledger whose rows are stamped by a controllable clock, so the IST-midnight budget window can be tested. */
function clockLedger(clock: { now: Date }): LlmLedger & { rows: (LlmCallRecord & { at: Date })[] } {
  const rows: (LlmCallRecord & { at: Date })[] = [];
  return {
    rows,
    async record(entry) {
      rows.push({ ...entry, at: new Date(clock.now) });
    },
    async countBillableSince(since, provider) {
      return rows.filter((r) => r.at >= since && r.provider === provider && !r.cacheHit && r.status !== "rejected").length;
    },
  };
}

describe("llmCacheKey", () => {
  const base = { model: "glm", task: "rate", promptVersion: "v1", jsonSchema: { type: "object" }, system: "s", user: "u", format: "json_object" };

  it("is stable for identical inputs and insensitive to schema key order", () => {
    expect(llmCacheKey(base)).toBe(llmCacheKey({ ...base }));
    expect(llmCacheKey({ ...base, jsonSchema: { a: 1, b: 2 } })).toBe(llmCacheKey({ ...base, jsonSchema: { b: 2, a: 1 } }));
  });

  it.each([
    ["model", { model: "glm-other" }],
    ["task", { task: "rate2" }],
    ["promptVersion", { promptVersion: "v2" }],
    ["schema", { jsonSchema: { type: "array" } }],
    ["output mode", { format: "json_schema" }],
    ["system prompt", { system: "s2" }],
    ["user prompt", { user: "u2" }],
  ])("changes when the %s changes", (_name, patch) => {
    expect(llmCacheKey({ ...base, ...patch })).not.toBe(llmCacheKey(base));
  });
});

describe("LLM client caching", () => {
  it("a cache hit records a cache_hit ledger row and makes no transport call", async () => {
    const t = scripted([OK]);
    const cache = createMemoryLlmCache();
    const ledger = createMemoryLedger();
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache, ledger, dailyCallBudget: 10, sleep: async () => {} });
    await llm.complete(req());
    const second = await llm.complete(req());
    expect(second).toEqual({ verdict: "buy", score: 7 });
    expect(t.requests).toHaveLength(1);
    expect(ledger.rows.at(-1)).toMatchObject({ status: "cache_hit", cacheHit: true, schemaValid: true, latencyMs: 0, task: "rate", promptVersion: "rate.v1" });
  });

  it("misses the cache when the model, prompt version or output mode differ", async () => {
    const cache = createMemoryLlmCache();
    const t = scripted([OK, OK, OK, OK]);
    const mk = (model: string, structuredOutput?: "json_schema" | "json_object") =>
      createLlmClientFromDeps({ transport: t, model, cache, ledger: createMemoryLedger(), dailyCallBudget: 10, structuredOutput, sleep: async () => {} });
    await mk("m1").complete(req());
    await mk("m2").complete(req());
    await mk("m1").complete(req({ promptVersion: "rate.v2" }));
    await mk("m1", "json_schema").complete(req());
    expect(t.requests).toHaveLength(4);
    expect(cache.entries.size).toBe(4);
  });

  it("noCache neither reads a cached answer nor writes one", async () => {
    const cache = createMemoryLlmCache();
    const t = scripted([OK, '{"verdict":"hold","score":3}']);
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache, ledger: createMemoryLedger(), dailyCallBudget: 10, sleep: async () => {} });
    await llm.complete(req());
    expect(cache.entries.size).toBe(1);
    await expect(llm.complete(req({ noCache: true }))).resolves.toEqual({ verdict: "hold", score: 3 });
    expect(t.requests).toHaveLength(2);
    expect([...cache.entries.values()]).toEqual([{ verdict: "buy", score: 7 }]);
  });

  it("ignores a cached answer that no longer passes the schema and asks the provider", async () => {
    const cache = createMemoryLlmCache();
    const t = scripted([OK]);
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache, ledger: createMemoryLedger(), dailyCallBudget: 10, sleep: async () => {} });
    const r = req();
    const key = llmCacheKey({ model: "m", task: r.task, promptVersion: r.promptVersion, jsonSchema: r.jsonSchema, system: r.system, user: r.user, format: "json_object" });
    cache.entries.set(key, { verdict: "sell" });
    await expect(llm.complete(r)).resolves.toEqual({ verdict: "buy", score: 7 });
    expect(t.requests).toHaveLength(1);
    expect(cache.entries.get(key)).toEqual({ verdict: "buy", score: 7 });
  });
});

describe("LLM client parsing and re-ask", () => {
  function client(responses: (string | Error)[]) {
    const t = scripted(responses);
    const ledger = createMemoryLedger();
    const sleep = vi.fn(async () => {});
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache: createMemoryLlmCache(), ledger, dailyCallBudget: 50, sleep });
    return { t, ledger, llm, sleep };
  }

  it.each([
    ["<think> tags", `<think>score it 7?</think>${OK}`],
    ["<thinking> tags", `<thinking>\nhmm {"not":"this"}\n</thinking>\n${OK}`],
    ["<reasoning> tags", `<REASONING>internal</REASONING>${OK}`],
    ["a json code fence", "```json\n" + OK + "\n```"],
    ["surrounding prose", `Sure! Here is the JSON: ${OK} Hope that helps.`],
  ])("strips %s before parsing", async (_name, content) => {
    const { llm, t } = client([content]);
    await expect(llm.complete(req())).resolves.toEqual({ verdict: "buy", score: 7 });
    expect(t.requests).toHaveLength(1);
  });

  it("invalid JSON then valid JSON costs exactly one re-ask", async () => {
    const { llm, t, ledger } = client(["{verdict: buy", OK]);
    await expect(llm.complete(req())).resolves.toEqual({ verdict: "buy", score: 7 });
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.messages.at(-1)!.content).toMatch(/invalid JSON/);
    expect(ledger.rows.map((r) => [r.status, r.schemaValid, r.attempt])).toEqual([
      ["invalid", false, 1],
      ["ok", true, 2],
    ]);
  });

  it("a zod failure re-asks with the validation path and message, echoing the rejected answer", async () => {
    const { llm, t } = client(['{"verdict":"buy","score":42}', OK]);
    await expect(llm.complete(req())).resolves.toEqual({ verdict: "buy", score: 7 });
    const followUp = t.requests[1]!.messages;
    expect(followUp.at(-2)).toEqual({ role: "assistant", content: '{"verdict":"buy","score":42}' });
    expect(followUp.at(-1)!.content).toMatch(/rejected by the validator: score: .*(10|less than)/i);
  });

  describe("a reply cut off at the token limit", () => {
    function cutOffClient(replies: ChatResponse[]) {
      const requests: ChatRequest[] = [];
      const transport: ChatTransport = {
        async chat(r) {
          requests.push(structuredClone(r));
          return replies.shift()!;
        },
      };
      const ledger = createMemoryLedger();
      const llm = createLlmClientFromDeps({ transport, model: "m", cache: createMemoryLlmCache(), ledger, dailyCallBudget: 50, sleep: async () => {} });
      return { llm, ledger, requests };
    }
    const runaway = `{"items":[${'{"verdict":"buy"},'.repeat(400)}{"verd`;

    it("is reported as cut off and re-asked for a shorter answer without echoing the runaway reply", async () => {
      const { llm, ledger, requests } = cutOffClient([
        { content: runaway, promptTokens: 50, completionTokens: 6000, finishReason: "length" },
        { content: OK, promptTokens: 60, completionTokens: 9, finishReason: "stop" },
      ]);
      await expect(llm.complete({ ...req(), maxTokens: 6000 })).resolves.toEqual({ verdict: "buy", score: 7 });
      const followUp = requests[1]!.messages;
      expect(followUp.map((m) => m.role)).toEqual(["system", "user", "user"]);
      expect(followUp.at(-1)!.content).toMatch(/cut off at the token limit.*shorter/);
      expect(ledger.rows[0]).toMatchObject({ status: "invalid", error: "response cut off at the 6000 token limit before the JSON was complete" });
    });

    it("is recognised from the token count when the provider gives no finish reason", async () => {
      const { llm } = cutOffClient([
        { content: runaway, promptTokens: 50, completionTokens: 6000 },
        { content: runaway, promptTokens: 50, completionTokens: 6000 },
      ]);
      await expect(llm.complete({ ...req(), maxTokens: 6000 })).rejects.toThrow("rate: response cut off at the 6000 token limit before the JSON was complete");
    });

    it("does not count as cut off when the reply ended on its own", async () => {
      const { llm, requests } = cutOffClient([
        { content: "{verdict: buy", promptTokens: 50, completionTokens: 12, finishReason: "stop" },
        { content: OK, promptTokens: 50, completionTokens: 9, finishReason: "stop" },
      ]);
      await llm.complete({ ...req(), maxTokens: 6000 });
      expect(requests[1]!.messages.at(-1)!.content).toMatch(/rejected by the validator: invalid JSON/);
    });
  });

  it("never re-asks twice: a second invalid answer raises LlmValidationError with the task", async () => {
    const { llm, t } = client(["nope", "still nope", OK]);
    const err = await llm.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
    expect((err as LlmValidationError).task).toBe("rate");
    expect(t.requests).toHaveLength(2);
  });

  it("three consecutive transport failures surface the last error after backing off twice", async () => {
    const { llm, t, ledger, sleep } = client([new LlmTransportError("HTTP 502", 502), new LlmTransportError("HTTP 503", 503), new LlmTransportError("HTTP 504", 504), OK]);
    await expect(llm.complete(req())).rejects.toThrow(/504/);
    expect(t.requests).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(ledger.rows.map((r) => r.status)).toEqual(["error", "error", "error"]);
  });

  it("retries 429 and unknown errors but not a 400", async () => {
    const a = client([new LlmTransportError("HTTP 429", 429), new Error("socket hang up"), OK]);
    await expect(a.llm.complete(req())).resolves.toEqual({ verdict: "buy", score: 7 });
    const b = client([new LlmTransportError("HTTP 400 bad request", 400), OK]);
    await expect(b.llm.complete(req())).rejects.toThrow(/400/);
    expect(b.t.requests).toHaveLength(1);
  });

  it("passes model, max tokens and a default temperature of 0 to the transport", async () => {
    const { llm, t } = client([OK]);
    await llm.complete({ ...req(), maxTokens: 123 });
    expect(t.requests[0]).toMatchObject({ model: "m", maxTokens: 123, temperature: 0 });
  });
});

describe("circuit breaker", () => {
  it("opens after 5 consecutive failures, rejects for 60s, then allows a single half-open trial", () => {
    let now = 0;
    const b = new CircuitBreaker({ now: () => now });
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.state).toBe("closed");
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.tryAcquire()).toBe(false);
    now = 59_999;
    expect(b.state).toBe("open");
    expect(b.retryAfterMs()).toBe(1);
    now = 60_000;
    expect(b.state).toBe("half_open");
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.retryAfterMs()).toBe(0);
  });

  it("a success resets the consecutive-failure count", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 4; i++) b.recordFailure();
    b.recordSuccess();
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.state).toBe("closed");
  });

  it("a failed half-open trial re-opens the circuit for another full window", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, openMs: 60_000, now: () => now });
    for (let i = 0; i < 5; i++) b.recordFailure();
    now = 61_000;
    expect(b.tryAcquire()).toBe(true);
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.retryAfterMs()).toBe(60_000);
  });

  it("the client fails fast with retryAfterMs while open and recovers after the window", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now });
    const t = scripted([...Array.from({ length: 5 }, () => new LlmTransportError("HTTP 500", 500)), OK]);
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache: createMemoryLlmCache(), ledger: createMemoryLedger(), dailyCallBudget: 99, breaker, maxAttempts: 1, sleep: async () => {} });
    for (let i = 0; i < 5; i++) await expect(llm.complete(req({ user: `u${i}` }))).rejects.toBeInstanceOf(LlmTransportError);
    now = 30_000;
    const err = await llm.complete(req({ user: "x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).retryAfterMs).toBe(30_000);
    expect(t.requests).toHaveLength(5);
    now = 60_000;
    await expect(llm.complete(req({ user: "y" }))).resolves.toEqual({ verdict: "buy", score: 7 });
    expect(breaker.state).toBe("closed");
  });
});

describe("daily budget (IST day)", () => {
  // 2026-11-14 23:59 IST = 18:29 UTC; 2026-11-15 00:01 IST = 18:31 UTC.
  const at = (iso: string) => new Date(iso);

  it("counts calls from IST midnight: a call at 23:59 IST does not use the next day's budget", async () => {
    const clock = { now: at("2026-11-14T18:29:00Z") };
    const ledger = clockLedger(clock);
    const t = scripted([OK, OK]);
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache: createMemoryLlmCache(), ledger, dailyCallBudget: 1, now: () => clock.now, sleep: async () => {} });

    await llm.complete(req({ user: "a" }));
    clock.now = at("2026-11-14T18:29:40Z");
    await expect(llm.complete(req({ user: "b" }))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.requests).toHaveLength(1);

    clock.now = at("2026-11-14T18:31:00Z");
    await expect(llm.complete(req({ user: "c" }))).resolves.toEqual({ verdict: "buy", score: 7 });
    expect(t.requests).toHaveLength(2);
  });

  it("raises BudgetExceededError with used/budget before any transport call", async () => {
    const clock = { now: at("2026-11-15T05:00:00Z") };
    const ledger = clockLedger(clock);
    for (let i = 0; i < 3; i++) await ledger.record({ provider: "glm", model: "m", task: "x", cacheHit: false, status: "ok" });
    await ledger.record({ provider: "glm", model: "m", task: "x", cacheHit: true, status: "cache_hit" });
    await ledger.record({ provider: "cloudflare", model: "e", task: "embed", cacheHit: false, status: "ok" });
    const t = scripted([OK]);
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache: createMemoryLlmCache(), ledger, dailyCallBudget: 3, now: () => clock.now, sleep: async () => {} });
    const err = await llm.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ used: 3, budget: 3 });
    expect(t.requests).toHaveLength(0);
  });

  it("every provider attempt, including failed ones, counts against the budget", async () => {
    const clock = { now: at("2026-11-15T05:00:00Z") };
    const t = scripted([new LlmTransportError("HTTP 503", 503), new LlmTransportError("HTTP 503", 503), OK]);
    const llm = createLlmClientFromDeps({ transport: t, model: "m", cache: createMemoryLlmCache(), ledger: clockLedger(clock), dailyCallBudget: 2, now: () => clock.now, sleep: async () => {} });
    await expect(llm.complete(req())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.requests).toHaveLength(2);
  });
});
