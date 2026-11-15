import { llmRepo } from "@finn/db/repositories/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createSqlLlmCache } from "../src/llm/cache";
import { createLlmClient } from "../src/llm/client";
import { createSqlLedger } from "../src/llm/ledger";
import type { ChatRequest, ChatTransport } from "../src/llm/transport";
import { toStrictJsonSchema } from "../src/util/schema";
import { connect, TAG } from "./helpers/db";

// Rows are tagged with this model/provider so only test rows are ever read or deleted.
const MODEL = `zta-test-model-${TAG}`;
const PROVIDER = `zta-test-provider-${TAG}`;
const KEY = `zta-key-1-${TAG}`;
const { sql, reachable } = await connect();

async function cleanup() {
  await sql`DELETE FROM llm_calls WHERE model = ${MODEL} OR provider = ${PROVIDER}`;
  await sql`DELETE FROM llm_cache WHERE model = ${MODEL}`;
}

describe.skipIf(!reachable)("SQL-backed LLM cache and cost ledger", () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("cache: put then get returns the response and counts the hit", async () => {
    const cache = createSqlLlmCache(sql);
    expect(await cache.get(`zta-key-missing-${TAG}`)).toBeUndefined();
    await cache.put(KEY, { model: MODEL, task: "t", response: { a: 1 } });
    await cache.put(KEY, { model: MODEL, task: "t", response: { a: 2 } });
    expect(await cache.get(KEY)).toEqual({ a: 2 });
    const [row] = await sql<{ hit_count: number }[]>`SELECT hit_count FROM llm_cache WHERE cache_key = ${KEY}`;
    expect(row!.hit_count).toBe(1);
  });

  it("cache: entries older than 30 days are ignored", async () => {
    await sql`INSERT INTO llm_cache (cache_key, model, purpose, response, created_at) VALUES (${`zta-key-old-${TAG}`}, ${MODEL}, 't', '{"a":1}', now() - interval '31 days')`;
    expect(await createSqlLlmCache(sql).get(`zta-key-old-${TAG}`)).toBeUndefined();
  });

  it("ledger: billable count excludes cache hits, rejected calls, other providers and earlier calls", async () => {
    const ledger = createSqlLedger(sql);
    const since = new Date(Date.now() - 1_000);
    for (const [status, cacheHit] of [
      ["ok", false],
      ["error", false],
      ["invalid", false],
      ["cache_hit", true],
      ["rejected", false],
    ] as const) {
      await ledger.record({ provider: PROVIDER, model: MODEL, task: "zta", cacheHit, status, promptTokens: 10, completionTokens: 2, neurons: 0.5, error: status === "error" ? "x".repeat(900) : null, refKind: "research_run", refId: "r1", attempt: 1, promptVersion: "v1", schemaValid: status === "ok" });
    }
    expect(await ledger.countBillableSince(since, PROVIDER)).toBe(3);
    expect(await ledger.countBillableSince(new Date(Date.now() + 60_000), PROVIDER)).toBe(0);
    const [err] = await sql<{ error: string }[]>`SELECT error FROM llm_calls WHERE provider = ${PROVIDER} AND status = 'error'`;
    expect(err!.error).toHaveLength(500);
    const usage = (await llmRepo(sql).usageSince(since)).find((u) => u.provider === PROVIDER)!;
    expect(usage).toMatchObject({ task: "zta", calls: 5, cache_hits: 1, prompt_tokens: 50, completion_tokens: 10, neurons: 2.5 });
  });

  it("ledger: a failing insert never fails the call it describes", async () => {
    const ledger = createSqlLedger(sql);
    const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM llm_calls WHERE model = ${MODEL}`;
    // purpose is NOT NULL, so this insert fails inside the ledger.
    await expect(ledger.record({ provider: PROVIDER, model: MODEL, task: null as unknown as string, cacheHit: false, status: "ok" })).resolves.toBeUndefined();
    const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM llm_calls WHERE model = ${MODEL}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("createLlmClient wires the SQL cache and ledger around an injected transport", async () => {
    const requests: ChatRequest[] = [];
    const transport: ChatTransport = {
      async chat(r) {
        requests.push(r);
        return { content: '{"ok":true}', promptTokens: 3, completionTokens: 1 };
      },
    };
    const llm = createLlmClient({ baseURL: "http://unused.invalid", apiKey: "unused", model: MODEL, sql, dailyCallBudget: 1_000_000, transport });
    const Schema = z.object({ ok: z.boolean() });
    const req = { task: "zta_probe", promptVersion: "v1", system: "s", user: `u-${Date.now()}`, jsonSchema: toStrictJsonSchema(Schema), parse: (v: unknown) => Schema.parse(v) };
    expect(await llm.complete(req)).toEqual({ ok: true });
    expect(await llm.complete(req)).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const rows = await sql<{ status: string; cache_hit: boolean }[]>`SELECT status, cache_hit FROM llm_calls WHERE model = ${MODEL} AND purpose = 'zta_probe' ORDER BY id`;
    expect(rows).toEqual([
      { status: "ok", cache_hit: false },
      { status: "cache_hit", cache_hit: true },
    ]);
  });
});
