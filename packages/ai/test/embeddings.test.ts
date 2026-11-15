import { describe, expect, it, vi } from "vitest";
import { createEmbeddingClient, EmbeddingError } from "../src/embeddings/cloudflare";
import { documentPrompt, queryPrompt } from "../src/embeddings/prefix";
import { createMemoryLedger } from "../src/llm/ledger";

const DIMS = 8;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { input: string[]; dimensions: number };
}

type Reply = { status?: number; body?: unknown; dims?: number; count?: number; raw?: string };

/** Fake Workers AI endpoint: echoes one vector per input unless a reply overrides it. */
function fakeFetch(replies: Reply[] = []) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call["body"];
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    const r = replies.shift() ?? {};
    const status = r.status ?? 200;
    if (r.raw !== undefined) return new Response(r.raw, { status });
    const n = r.count ?? body.input.length;
    const data = Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: Array.from({ length: r.dims ?? body.dimensions }, () => n - 1 - i) }));
    const payload = r.body ?? { success: true, result: { data, usage: { prompt_tokens: 7 * n, neurons: 1.5 } } };
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function client(f: ReturnType<typeof fakeFetch>, over: Partial<Parameters<typeof createEmbeddingClient>[0]> = {}) {
  const ledger = createMemoryLedger();
  const sleep = vi.fn(async () => {});
  const c = createEmbeddingClient({ accountId: "acct", apiToken: "tok", model: "@cf/google/embeddinggemma-2", dims: DIMS, fetchImpl: f.impl, ledger, sleep, ...over });
  return { c, ledger, sleep };
}

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Doc ${i}`, text: `chunk text ${i}` }));

describe("embedding prefixes", () => {
  it("formats documents as title/text with 'none' for a missing title", () => {
    expect(documentPrompt("ACME  Annual\nReport", "  body text ")).toBe("title: ACME Annual Report | text: body text");
    expect(documentPrompt("  ", "body")).toBe("title: none | text: body");
  });

  it("formats queries per task", () => {
    expect(queryPrompt("what is  capex?")).toBe("task: search result | query: what is capex?");
    expect(queryPrompt("q", "search_query")).toBe("task: search result | query: q");
    expect(queryPrompt("q", "question_answering")).toBe("task: question answering | query: q");
    expect(queryPrompt("q", "clustering")).toBe("task: clustering | query: q");
  });
});

describe("Cloudflare embedding client", () => {
  it("posts {input, dimensions} to the account's model URL with the bearer token", async () => {
    const f = fakeFetch();
    const { c } = client(f);
    await c.embedDocuments([{ title: "T", text: "hello" }]);
    expect(f.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/google/embeddinggemma-2");
    expect(f.calls[0]!.headers.Authorization).toBe("Bearer tok");
    expect(f.calls[0]!.body).toEqual({ input: ["title: T | text: hello"], dimensions: DIMS });
    expect(c.dims).toBe(DIMS);
    expect(c.model).toBe("@cf/google/embeddinggemma-2");
  });

  it("uses the query prefix for each query task, defaulting to search", async () => {
    const f = fakeFetch();
    const { c } = client(f);
    await c.embedQuery("growth?");
    await c.embedQuery("growth?", "question_answering");
    await c.embedQuery("growth?", "clustering");
    expect(f.calls.map((x) => x.body.input[0])).toEqual([
      "task: search result | query: growth?",
      "task: question answering | query: growth?",
      "task: clustering | query: growth?",
    ]);
  });

  it.each([
    [31, [31]],
    [32, [32]],
    [33, [32, 1]],
    [65, [32, 32, 1]],
  ])("batches %i inputs as %j and keeps output order", async (n, sizes) => {
    const f = fakeFetch();
    const { c } = client(f);
    const out = await c.embedDocuments(docs(n));
    expect(f.calls.map((x) => x.body.input.length)).toEqual(sizes);
    expect(out).toHaveLength(n);
    // The fake returns data in reverse index order; the client must re-sort by index.
    expect(out[0]![0]).toBe(0);
    expect(out[sizes[0]! - 1]![0]).toBe(sizes[0]! - 1);
  });

  it("truncates over-long inputs", async () => {
    const f = fakeFetch();
    const { c } = client(f, { maxInputChars: 20 });
    await c.embedDocuments([{ title: "", text: "x".repeat(100) }]);
    expect(f.calls[0]!.body.input[0]).toHaveLength(20);
  });

  it.each([429, 500, 503])("retries HTTP %i with backoff and then succeeds", async (status) => {
    const f = fakeFetch([{ status, body: { success: false, errors: [{ message: "busy" }] } }]);
    const { c, sleep, ledger } = client(f);
    await expect(c.embedQuery("q")).resolves.toHaveLength(DIMS);
    expect(f.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(ledger.rows.map((r) => r.status)).toEqual(["error", "ok"]);
  });

  it("gives up after the configured retries", async () => {
    const f = fakeFetch(Array.from({ length: 5 }, () => ({ status: 503, raw: "<html>bad gateway</html>" })));
    const { c } = client(f, { retries: 2 });
    const err = await c.embedQuery("q").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).message).toMatch(/HTTP 503/);
    expect(f.calls).toHaveLength(3);
  });

  it("does not retry other 4xx errors", async () => {
    const f = fakeFetch([{ status: 401, body: { success: false, errors: [{ message: "Authentication error" }] } }]);
    const { c } = client(f);
    await expect(c.embedQuery("q")).rejects.toThrow(/Authentication error/);
    expect(f.calls).toHaveLength(1);
  });

  it("treats success:false in a 200 body as a failure", async () => {
    const f = fakeFetch([{ status: 200, body: { success: false, errors: [{ message: "model overloaded" }] } }]);
    const { c } = client(f);
    await expect(c.embedQuery("q")).rejects.toThrow(/model overloaded/);
  });

  it("fails fast when the vector dimensions do not match", async () => {
    const f = fakeFetch([{ dims: DIMS + 1 }, {}]);
    const { c } = client(f);
    await expect(c.embedQuery("q")).rejects.toThrow(`Expected ${DIMS}-dim vectors, got ${DIMS + 1}`);
    expect(f.calls).toHaveLength(1);
  });

  it("retries when the provider returns the wrong number of vectors", async () => {
    const f = fakeFetch([{ count: 1 }, {}]);
    const { c } = client(f);
    await expect(c.embedDocuments(docs(2))).resolves.toHaveLength(2);
    expect(f.calls).toHaveLength(2);
  });

  it("records a usage ledger row per successful batch with tokens and neurons", async () => {
    const f = fakeFetch();
    const { c, ledger } = client(f);
    await c.embedDocuments(docs(33));
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]).toMatchObject({ provider: "cloudflare", model: "@cf/google/embeddinggemma-2", task: "embed", promptTokens: 7 * 32, neurons: 1.5, cacheHit: false, status: "ok", attempt: 1 });
  });

  it("works without a ledger", async () => {
    const f = fakeFetch();
    const c = createEmbeddingClient({ accountId: "a", apiToken: "t", model: "m", dims: DIMS, fetchImpl: f.impl });
    await expect(c.embedQuery("q")).resolves.toHaveLength(DIMS);
  });
});
